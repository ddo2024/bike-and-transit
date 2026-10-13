const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { createApp } = require('./app');
const { fixtureClient, input, origin, destination } = require('./fixtures/search');
const { fixture: gtfsFixture } = require('./gtfs/fixtures');
const { createGtfsProvider } = require('./gtfs/provider');

async function startServer(t, options) {
  const server = http.createServer(createApp(options));
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function request(base, path, { body, rawBody, method = body === undefined && rawBody === undefined ? 'GET' : 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody === undefined && body !== undefined ? JSON.stringify(body) : rawBody;
    const req = http.request(`${base}${path}`, {
      method,
      agent: false,
      headers: payload === undefined ? {} : { 'Content-Type': 'application/json' },
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Test HTTP request timed out.')));
    req.end(payload);
  });
}

function within(promise, milliseconds = 2000) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Expected test event did not arrive.')), milliseconds);
    }),
  ]).finally(() => clearTimeout(timeout));
}

test('HTTP GTFS search uses schedule graph, labels data, and keeps direct bike last', async t => {
  const feed=gtfsFixture();let placesCalls=0;
  const {client}=fixtureClient();
  client.geocodeAddress=async address=>feed.stops.get(address==='A'?'A':'B');
  client.findNearbyTransitStops=async()=>{placesCalls++;throw new Error('Legacy discovery should not run');};
  client.computeBikeMatrix=async(_,stops)=>stops.map((s,i)=>({destinationIndex:i,condition:'ROUTE_EXISTS',duration:'60s',distanceMeters:100}));
  client.computeBikeEgressMatrix=async(stops)=>stops.map((s,i)=>({originIndex:i,condition:'ROUTE_EXISTS',duration:'60s',distanceMeters:100}));
  const transitProvider=createGtfsProvider({snapshot:async()=>({feed})},client);
  const base=await startServer(t,{mapsClient:client,transitProvider});
  const response=await request(base,'/api/search',{body:{origin:'A',destination:'B',departureTime:'2026-10-12T11:38:00-07:00',bikeSpeedMph:8,maxBikeMinutes:30}});
  assert.equal(response.status,200);const result=JSON.parse(response.text);
  assert.equal(placesCalls,0);assert.equal(result.results[0].transitSteps[0].tripId,'T1');
  assert.match(result.results[0].timingStatus,/Scheduled/);assert.equal(result.results.at(-1).mode,'direct-bike');
});

test('HTTP health, static files, and map config work without contacting Google', async t => {
  const { client, calls } = fixtureClient();
  const base = await startServer(t, { mapsClient: client });
  const health = await request(base, '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.text), { ok: true });
  const page = await request(base, '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.text, /id="route-form"/);
  const script = await request(base, '/app.js');
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'], /javascript/);
  assert.match(script.text, /route-form/);
  const config = await request(base, '/api/map-config');
  assert.equal(config.status, 200);
  assert.deepEqual(JSON.parse(config.text), { browserApiKey: null });
  assert.equal(calls.length, 0);
});

test('HTTP search serializes successful routes, dates, transfer fields, and direct bike last', async t => {
  const { client } = fixtureClient();
  const base = await startServer(t, { mapsClient: client });
  const response = await request(base, '/api/search', { body: input });
  assert.equal(response.status, 200);
  const result = JSON.parse(response.text);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].finalArrival, '2026-10-12T19:15:30.000Z');
  assert.equal(result.results[0].transferCount, 0);
  assert.equal(result.results[0].transitSteps[0].mode, 'TRANSIT');
  assert.equal(result.results[0].transitSteps[0].departureTime, '2026-10-12T18:48:00.000Z');
  assert.equal(result.results[1].mode, 'direct-bike');
  assert.ok(result.baseline);
  assert.deepEqual(result.warnings, []);
});

test('HTTP optional comparison and geometry failures return usable results with warnings', async t => {
  const { client } = fixtureClient();
  const computeRoutes = client.computeRoutes;
  client.computeRoutes = async (from, to, options) => {
    if (from === origin && (options.mode === 'transit' || to !== destination)) {
      throw new Error('Synthetic optional failure');
    }
    return computeRoutes(from, to, options);
  };
  const base = await startServer(t, { mapsClient: client });
  const response = await request(base, '/api/search', { body: input });
  assert.equal(response.status, 200);
  const result = JSON.parse(response.text);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].firstBikePolyline, null);
  assert.equal(result.results[1].mode, 'direct-bike');
  assert.equal(result.baseline, null);
  assert.match(result.warnings.join(' '), /normal-transit comparison/);
  assert.match(result.warnings.join(' '), /map geometry/);
});

test('HTTP input validation rejects invalid fields before any Google work', async t => {
  const { client, calls } = fixtureClient();
  const base = await startServer(t, { mapsClient: client });
  const cases = [
    ['blank origin', { origin: '   ' }],
    ['object origin', { origin: { address: 'Origin' } }],
    ['number destination', { destination: 42 }],
    ['negative speed', { bikeSpeedMph: -8 }],
    ['zero speed', { bikeSpeedMph: 0 }],
    ['boolean speed', { bikeSpeedMph: true }],
    ['nonfinite speed', { bikeSpeedMph: 'Infinity' }],
    ['invalid date', { departureTime: 'not-a-date' }],
    ['invalid calendar day', { departureTime: '2026-02-30T10:00:00Z' }],
    ['missing timezone', { departureTime: '2026-10-12T10:00:00' }],
    ['invalid timezone', { departureTime: '2026-10-12T10:00:00+25:00' }],
    ['negative max bike', { maxBikeMinutes: -1 }],
    ['nonnumeric max bike', { maxBikeMinutes: 'many' }],
  ];
  for (const [name, invalid] of cases) {
    await t.test(name, async () => {
      const response = await request(base, '/api/search', { body: { ...input, ...invalid } });
      assert.equal(response.status, 400);
      assert.equal(typeof JSON.parse(response.text).error, 'string');
      assert.equal(calls.length, 0);
    });
  }
});

test('HTTP malformed JSON and nonobject bodies return JSON 400 before Google work', async t => {
  const { client, calls } = fixtureClient();
  const base = await startServer(t, { mapsClient: client });
  for (const rawBody of ['{"origin":', '[]', 'null', '']) {
    const response = await request(base, '/api/search', { rawBody });
    assert.equal(response.status, 400);
    assert.match(response.headers['content-type'], /application\/json/);
    assert.equal(typeof JSON.parse(response.text).error, 'string');
    assert.equal(calls.length, 0);
  }
});

test('HTTP search deadline returns 504 and aborts required Google work', async t => {
  const { client, calls } = fixtureClient();
  const signals = [];
  client.geocodeAddress = (address, { signal }) => {
    signals.push(signal);
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const base = await startServer(t, { mapsClient: client, searchTimeoutMs: 20 });
  const response = await request(base, '/api/search', { body: input });
  assert.equal(response.status, 504);
  assert.match(JSON.parse(response.text).error, /timed out/);
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(calls.length, 0);
});

test('HTTP client disconnect aborts in-flight Google work without issuing downstream requests', async t => {
  const { client, calls } = fixtureClient();
  const signals = [];
  let markStarted;
  let markAborted;
  let abortCount = 0;
  const started = new Promise(resolve => { markStarted = resolve; });
  const aborted = new Promise(resolve => { markAborted = resolve; });
  client.geocodeAddress = (address, { signal }) => {
    signals.push(signal);
    const pending = new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        abortCount += 1;
        if (abortCount === 2) markAborted();
        reject(signal.reason);
      }, { once: true });
    });
    if (signals.length === 2) markStarted();
    return pending;
  };
  const base = await startServer(t, { mapsClient: client });
  const req = http.request(`${base}/api/search`, {
    method: 'POST', agent: false, headers: { 'Content-Type': 'application/json' },
  });
  // Destroying the client socket intentionally emits ECONNRESET.
  req.on('error', () => {});
  t.after(() => req.destroy());
  req.end(JSON.stringify(input));
  await within(started);
  req.destroy();
  await within(aborted);
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(calls.length, 0);
});
