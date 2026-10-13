const fs = require('node:fs/promises');
const path = require('node:path');
const { loadGtfsZip } = require('./static');
const { download } = require('./transport');

const DIRECT_URL = 'https://gtfs.vta.org/gtfs_vta.zip';
function positive(value, fallback, min, max) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error('Invalid transit configuration value');
  return n;
}
async function atomicWrite(file, data) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, data, { mode: 0o600 });
  await fs.rename(temporary, file);
}
function createTransitRuntime({ env = process.env, dataDir = path.join(__dirname, '../../data'), downloadFeed = download } = {}) {
  let feed; let loading; let fetchedAt = 0; let timer; let lastError = false; let coordinator;
  const refreshMs = positive(env.GTFS_STATIC_REFRESH_SECONDS, 86400, 3600, 604800) * 1000;
  const token = env.TRANSIT_511_API_KEY;
  const source = token ? '511' : 'vta-direct';
  const file = path.join(dataDir, token ? 'vta-511.zip' : 'vta-direct.zip');
  async function refresh() {
    if (loading) return loading;
    loading = (async () => {
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
      if (!feed) {
        try {
          const [buffer, stat] = await Promise.all([fs.readFile(file), fs.stat(file)]);
          feed = loadGtfsZip(buffer, { source }); fetchedAt = stat.mtimeMs;
        } catch { /* A missing or corrupt cache must be replaced, never published. */ }
      }
      if (token && !coordinator) {
        const { getCoordinator } = require('./poller');
        coordinator = await getCoordinator(token, { env, downloadFeed });
      }
      if (!feed || Date.now() - fetchedAt > refreshMs) {
        try {
          const buffer = token ? await coordinator.staticFeed() : await downloadFeed(DIRECT_URL, { timeoutMs: 60000 });
          let next;
          try { next = loadGtfsZip(buffer, { source }); }
          catch (error) { await coordinator?.invalidateStatic(); throw error; }
          await atomicWrite(file, buffer); feed = next; fetchedAt = Date.now(); lastError = false;
        } catch (error) { lastError = true; if (!feed) throw error; }
      }
      if (coordinator) coordinator.setFeed(feed);
      return feed;
    })().finally(() => { loading = null; });
    return loading;
  }
  return {
    async start() {
      try { await refresh(); } catch { lastError = true; }
      // Background refresh only, never one poller per route search.
      timer ||= setInterval(() => { refresh().catch(() => { lastError = true; }); }, Math.min(refreshMs, 300000));
      timer.unref();
    },
    async snapshot() {
      if (!feed) await refresh();
      const warnings = [];
      if (!token) warnings.push('VTA direct static feed: scheduled-only mode. No 511 token configured.');
      if (lastError) warnings.push('Static feed refresh failed; using the last valid cached schedule.');
      const realtime = coordinator?.snapshot(feed);
      if (realtime?.status?.message) warnings.push(realtime.status.message);
      return { feed, realtime, warnings };
    },
    stop() { clearInterval(timer); return coordinator?.stop(); },
  };
}
module.exports = { createTransitRuntime, positive, atomicWrite, DIRECT_URL };
