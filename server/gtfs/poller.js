const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { download } = require('./transport');
const { atomicWrite, positive } = require('./runtime');
const { decode, validateSnapshot, realtimeView, compatibility } = require('./realtime');
const registry = new Map();

function discoverVta(buffer) {
  const operators = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(operators)) throw new Error('Unexpected 511 operator list');
  const matches = operators.filter(row => /\bVTA\b|Santa Clara.*(?:Valley|Transit)|Valley Transportation Authority/i.test(row.Name || ''));
  if (matches.length !== 1 || !/^[a-z0-9_-]+$/i.test(matches[0].Id || '')) throw new Error('Cannot uniquely discover VTA operator');
  return { id: matches[0].Id, name: matches[0].Name, lastGenerated: matches[0].LastGenerated };
}
class RequestBudget {
  constructor({ limit = 54, now = Date.now, save = async () => {}, state = {} } = {}) {
    this.limit = limit; this.now = now; this.save = save;
    this.attempts = state.attempts || []; this.blockedUntil = state.blockedUntil || 0; this.failures = state.failures || 0;
    this.tail = Promise.resolve();
  }
  state() { return { attempts: this.attempts, blockedUntil: this.blockedUntil, failures: this.failures }; }
  run(operation) {
    const work = this.tail.then(async () => {
      const now = this.now(); this.attempts = this.attempts.filter(t => now - t < 3600000);
      if (now < this.blockedUntil || this.attempts.length >= this.limit) throw new Error('511 aggregate budget/backoff active');
      this.attempts.push(now); await this.save(this.state()); // Charge before EVERY attempt, including failures.
      try {
        const result = await operation(); this.failures = 0; await this.save(this.state()); return result;
      } catch (error) {
        if (error.status === 429) {
          this.failures += 1;
          this.blockedUntil = this.now() + Math.max(error.retryAfterMs || 0, Math.min(3600000, 30000 * 2 ** Math.min(this.failures - 1, 7)));
          await this.save(this.state());
        }
        throw error;
      }
    });
    this.tail = work.catch(() => {});
    return work;
  }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error('Invalid persisted 511 state; refusing to reset the request budget');
  }
}
async function acquireLock(file) {
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    await handle.writeFile(String(process.pid)); await handle.close(); return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await fs.readFile(file, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return false; } catch (e) { if (e.code !== 'ESRCH') return false; }
    // Serialize stale-owner recovery as well: two restarts must not unlink
    // one another's newly acquired owner file.
    const recovery = `${file}.recovery`;
    try { await fs.mkdir(recovery); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    try {
      const currentPid = Number(await fs.readFile(file, 'utf8'));
      if (!Number.isInteger(currentPid) || currentPid <= 0) return false;
      try { process.kill(currentPid, 0); return false; } catch (e) { if (e.code !== 'ESRCH') return false; }
      await fs.unlink(file);
      return await acquireLock(file);
    } finally { await fs.rmdir(recovery); }
  }
}
async function createCoordinator(token, { env = {}, downloadFeed = download, now = Date.now, directory } = {}) {
  // A per-user, per-token lock also prevents duplicate pollers in two local Node processes.
  const hash = createHash('sha256').update(token).digest('hex');
  const dir = directory || path.join(os.tmpdir(), `bike-transit-511-${process.getuid?.() ?? 'user'}-${hash}`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, 'owner.lock');
  const owner = await acquireLock(lock);
  const budgetFile = path.join(dir, 'budget.json');
  const budget = new RequestBudget({ now, limit: positive(env.TRANSIT_511_HOURLY_BUDGET, 54, 1, 60),
    state: await readJson(budgetFile, {}), save: state => atomicWrite(budgetFile, JSON.stringify(state)) });
  const intervals = {
    tripupdates: positive(env.GTFS_RT_TRIP_INTERVAL_SECONDS, 120, 1, 86400) * 1000,
    servicealerts: positive(env.GTFS_RT_ALERT_INTERVAL_SECONDS, 300, 1, 86400) * 1000,
  };
  let operator = await readJson(path.join(dir, 'operator.json'), null);
  const snapshots = {}; const next = { tripupdates: 0, servicealerts: 0 };
  let feed; let evidence; let timer; let busy = false; let polling; let stopped = false; let errorCount = 0; let discoveryRetryAt = 0;
  async function readSnapshots() {
    for (const endpoint of Object.keys(intervals)) {
      try { snapshots[endpoint] = validateSnapshot(decode(await fs.readFile(path.join(dir, `${endpoint}.pb`))), snapshots[endpoint], now()); } catch { /* Retain last valid data; freshness still expires. */ }
    }
  }
  await readSnapshots();
  for (const endpoint of Object.keys(intervals)) {
    if (snapshots[endpoint]) next[endpoint] = Math.min(now(), snapshots[endpoint].timestamp) + intervals[endpoint];
  }
  async function request(endpoint, params = {}) {
    if (!owner || stopped) throw new Error('Another local process owns this token poller');
    return budget.run(() => {
      const url = new URL(`https://api.511.org/transit/${endpoint}`);
      url.searchParams.set('api_key', token);
      for (const [key,value] of Object.entries(params)) url.searchParams.set(key,value);
      return downloadFeed(url.toString(), endpoint === 'datafeeds' ? { timeoutMs: 60000 } : undefined);
    });
  }
  async function discover() {
    if (!operator || now() - operator.discoveredAt > 86400000) {
      operator = { ...discoverVta(await request('gtfsoperators')), discoveredAt: now() };
      await atomicWrite(path.join(dir, 'operator.json'), JSON.stringify(operator));
    }
    return operator;
  }
  function tick() {
    if (busy || stopped || !feed) return polling || Promise.resolve();
    busy = true;
    polling = (async () => {
    try {
      if (!owner) { await readSnapshots(); return; }
      if (now() < discoveryRetryAt) return;
      await discover();
      for (const endpoint of Object.keys(intervals)) {
        if (now() < next[endpoint]) continue;
        next[endpoint] = now() + intervals[endpoint];
        try {
          const buffer = await request(endpoint, { agency: operator.id });
          const snapshot = validateSnapshot(decode(buffer), snapshots[endpoint], now());
          if (endpoint === 'tripupdates') {
            const report = compatibility(feed, snapshot);
            if (report.verified) evidence = report;
            else if (report.rejectedTrips && !report.matchedTrips) throw new Error('Snapshot identifiers do not match static feed');
          }
          await atomicWrite(path.join(dir, `${endpoint}.pb`), buffer);
          snapshots[endpoint] = snapshot;
        } catch { errorCount += 1; }
      }
    } catch { errorCount += 1; discoveryRetryAt = now() + intervals.tripupdates; } finally { busy = false; }
    })();
    return polling;
  }
  return {
    async staticFeed() {
      const cached = path.join(dir, 'static.zip');
      try {
        const stat = await fs.stat(cached);
        const refreshMs = positive(env.GTFS_STATIC_REFRESH_SECONDS, 86400, 3600, 604800) * 1000;
        if (now() - stat.mtimeMs < refreshMs) return await fs.readFile(cached);
      } catch { /* No shared download available. */ }
      if (!owner) throw new Error('Shared static cache is stale; waiting for the token owner to refresh');
      const agency = await discover();
      const buffer = await request('datafeeds', { operator_id: agency.id });
      // Static parser validates before the runtime publishes it. Keep the shared download for follower processes.
      await atomicWrite(path.join(dir, 'static.zip'), buffer); return buffer;
    },
    async invalidateStatic() { if (owner) await fs.unlink(path.join(dir, 'static.zip')).catch(() => {}); },
    setFeed(value) {
      if (feed?.hash !== value.hash) evidence = null;
      feed = value;
      const report = compatibility(feed, snapshots.tripupdates);
      if (report.verified) evidence = report;
      if (!timer) { tick(); timer = setInterval(tick, 1000); timer.unref(); }
    },
    snapshot(value = feed) {
      const view = realtimeView(value, snapshots.tripupdates, snapshots.servicealerts, {
        now: now(), compatibilityEvidence: evidence, tripMaxAgeMs: positive(env.GTFS_RT_TRIP_MAX_AGE_SECONDS, 300, 1, 3600) * 1000,
        alertMaxAgeMs: positive(env.GTFS_RT_ALERT_MAX_AGE_SECONDS, 900, 1, 86400) * 1000,
      });
      view.status.operator = operator; view.status.pollErrors = errorCount;
      view.status.pollOwner = owner; view.status.requestsLastHour = budget.attempts.filter(t => now() - t < 3600000).length;
      return view;
    },
    tick,
    async stop() { stopped = true; clearInterval(timer); await polling; await budget.tail; if (owner) await fs.unlink(lock).catch(() => {}); },
  };
}
function getCoordinator(token, options) {
  const key = createHash('sha256').update(token).digest('hex');
  if (!registry.has(key)) registry.set(key, createCoordinator(token, options).catch(error => { registry.delete(key); throw error; }));
  return registry.get(key);
}
module.exports = { getCoordinator, createCoordinator, RequestBudget, discoverVta };
