const test = require('node:test');
const assert = require('node:assert/strict');
const { createSearchService, readMatrixRide } = require('./searchService');
const { fixtureClient, input, origin, destination, transitStep } = require('./fixtures/search');

test('Matrix validation rejects no-route/missing/error metrics and retains explicit zero rides', () => {
  const good = { condition: 'ROUTE_EXISTS', status: {}, distanceMeters: 1609.344, duration: '450s' };
  for (const value of [undefined, {}, { ...good, condition: 'ROUTE_NOT_FOUND' }, { ...good, condition: undefined },
    { ...good, status: { code: 5 } }, { ...good, distanceMeters: null }, { ...good, distanceMeters: -1 },
    { ...good, duration: undefined }, { ...good, duration: 'bad' }]) assert.equal(readMatrixRide(value, 8), null);
  assert.deepEqual(readMatrixRide(good, 8), { distanceMeters: 1609.344, minutes: 7.5 });
  assert.deepEqual(readMatrixRide({ ...good, distanceMeters: 0, duration: '0s' }, 8), { distanceMeters: 0, minutes: 0 });
  assert.deepEqual(readMatrixRide({ ...good, distanceMeters: undefined, duration: '0s' }, 8), { distanceMeters: 0, minutes: 0 });
  assert.equal(readMatrixRide({ condition: 'ROUTE_EXISTS', status: {} }, 8), null);
});

test('Unavailable matrix legs never become zero-minute access recommendations', async () => {
  const { client, calls } = fixtureClient();
  client.computeBikeMatrix = async () => [{ destinationIndex: 0, status: {} }];
  const result = await createSearchService(client).search(input);
  assert.deepEqual(result.results.map(route => route.mode), ['direct-bike']);
  assert.equal(calls.filter(call => call.options?.mode === 'transit').length, 1); // baseline only
  assert.match(result.warnings.join(' '), /bike access lookup/);
});

test('Protobuf omitted zero distance and destination index preserve legitimate zero bike legs', async () => {
  const { client } = fixtureClient();
  client.computeBikeMatrix = async () => [{ condition: 'ROUTE_EXISTS', status: {}, duration: '0s' }];
  const routes = client.computeRoutes;
  client.computeRoutes = (from, to, options) => options.mode === 'bicycle'
    ? Promise.resolve([{ duration: '0s' }]) : routes(from, to, options);
  const result = await createSearchService(client).search(input);
  assert.equal(result.results[0].bikeMinutes, 0);
  assert.equal(result.results[0].finalBikeMinutes, 0);
  assert.equal(result.results[1].bikeMinutes, 0);
  assert.deepEqual(result.warnings, []);
});

test('Full search preserves 12 candidates, top three, configured speed, direct last, and 36-call bound', async () => {
  const { client, calls } = fixtureClient({ count: 20 });
  const result = await createSearchService(client).search(input);
  assert.equal(calls.find(call => call.method === 'matrix').candidates.length, 12);
  assert.equal(calls.length, 36);
  assert.equal(result.results.length, 4);
  assert.equal(result.results[3].mode, 'direct-bike');
  assert.equal(result.results[0].bikeMinutes, 7.5);
  assert.equal(result.results[0].finalBikeMinutes, 7.5);
  assert.equal(result.results[0].totalMinutes, 37.5);
  assert.equal(result.results[0].arrivalAtStop.toISOString(), '2026-10-12T18:45:30.000Z');
  assert.equal(result.results[0].finalArrival.toISOString(), '2026-10-12T19:15:30.000Z');
  assert.ok(result.baseline);
  assert.deepEqual(result.warnings, []);
  assert.ok(calls.every(call => call.options.signal));
});

test('Optional baseline and first-bike geometry failures preserve usable transit and direct results', async () => {
  const { client } = fixtureClient();
  const routes = client.computeRoutes;
  client.computeRoutes = async (from, to, options) => {
    if (from === origin && (options.mode === 'transit' || to !== destination)) throw Error('optional failure');
    return routes(from, to, options);
  };
  const result = await createSearchService(client).search(input);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].firstBikePolyline, null);
  assert.equal(result.results[1].mode, 'direct-bike');
  assert.equal(result.baseline, null);
  assert.equal(result.warnings.length, 2);
});

test('Candidate failure is distinguished from no service and other candidates survive', async () => {
  const { client, stops } = fixtureClient({ count: 2 });
  const routes = client.computeRoutes;
  client.computeRoutes = async (from, to, options) => {
    if (from === stops[0] && options.mode === 'transit') throw Error('candidate failure');
    return routes(from, to, options);
  };
  const result = await createSearchService(client).search(input);
  assert.equal(result.results[0].stopName, stops[1].name);
  assert.match(result.warnings.join(' '), /1 transit candidate/);
});

test('Matrix outage still returns direct bicycle with an incomplete-search warning', async () => {
  const { client } = fixtureClient();
  client.computeBikeMatrix = async () => { throw Error('matrix failure'); };
  const result = await createSearchService(client).search(input);
  assert.deepEqual(result.results.map(route => route.mode), ['direct-bike']);
  assert.match(result.warnings.join(' '), /Transit routing is temporarily unavailable/);
});

test('Same identified vehicle from successive access stops occupies only one result slot', async () => {
  const { client } = fixtureClient({ count: 2 });
  const routes = client.computeRoutes;
  client.computeRoutes = async (from, to, options) => options.mode !== 'transit' ? routes(from, to, options)
    : [{ duration: '1800s', legs: [{ steps: [transitStep(from)] }] }];
  const result = await createSearchService(client).search(input);
  assert.equal(result.results.length, 2);
});

test('Transfer details preserve connecting walks and exclude the replaced final walk', async () => {
  const { client } = fixtureClient();
  const routes = client.computeRoutes;
  client.computeRoutes = async (from, to, options) => {
    if (options.mode !== 'transit') return routes(from, to, options);
    return [{ duration: '2220s', legs: [{ steps: [
      transitStep(from, { arrival: '2026-10-12T18:58:00Z' }),
      { travelMode: 'WALK', staticDuration: '120s' },
      transitStep({ name: 'Transfer stop', lat: 37.02, lng: -122 }, { trip: '23-1', departure: '2026-10-12T19:01:00Z' }),
      { travelMode: 'WALK', staticDuration: '420s' },
    ] }] }];
  };
  const result = await createSearchService(client).search(input);
  const route = result.results[0];
  assert.equal(route.transferCount, 1);
  assert.equal(route.walkingMinutes, 2);
  assert.deepEqual(route.transitSteps.map(step => step.mode), ['TRANSIT', 'WALK', 'TRANSIT']);
  assert.equal(route.waitMinutes, 3.5);
  assert.equal(route.totalMinutes, 37.5);
});

test('Baseline includes initial wait using scheduled final alighting plus walking, not aggregate duration', async () => {
  const { client } = fixtureClient();
  const routes = client.computeRoutes;
  client.computeRoutes = (from, to, options) => {
    if (from === origin && options.mode === 'transit') return Promise.resolve([{
      duration: '1736s', legs: [{ steps: [
        { travelMode: 'WALK', staticDuration: '270s' },
        transitStep(from, { departure: '2026-10-12T18:52:00Z', arrival: '2026-10-12T19:08:40Z' }),
        { travelMode: 'WALK', staticDuration: '466s' },
      ] }],
    }]);
    return routes(from, to, options);
  };
  const result = await createSearchService(client).search(input);
  assert.equal(result.baseline.finalArrival.toISOString(), '2026-10-12T19:16:26.000Z');
  assert.equal(result.baseline.totalMinutes, 38 + 26 / 60);
  assert.deepEqual(result.warnings, []);
});

test('Access cap, missed departure and 75m rule reject candidates while direct bike stays', async () => {
  for (const scenario of ['cap', 'missed', 'far']) {
    const { client } = fixtureClient();
    const routes = client.computeRoutes;
    client.computeRoutes = async (from, to, options) => {
      if (options.mode !== 'transit') return routes(from, to, options);
      const stop = scenario === 'far' ? { ...from, lat: from.lat + 0.001 } : from;
      return [{ duration: '1800s', legs: [{ steps: [transitStep(stop,
        scenario === 'missed' ? { departure: '2026-10-12T18:40:00Z' } : {})] }] }];
    };
    const result = await createSearchService(client).search({ ...input, maxBikeMinutes: scenario === 'cap' ? 5 : 30 });
    assert.deepEqual(result.results.map(route => route.mode), ['direct-bike'], scenario);
  }
});

test('Whole-search deadline aborts hanging geocodes and makes no later API calls', async () => {
  const { client, calls } = fixtureClient();
  const signals = [];
  client.geocodeAddress = (address, { signal }) => { signals.push(signal); return new Promise(() => {}); };
  await assert.rejects(createSearchService(client, { searchTimeoutMs: 10 }).search(input), { code: 'SEARCH_TIMEOUT', statusCode: 504 });
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(calls.length, 0);
});

test('Whole-search deadline during optional geometry returns completed routes', async () => {
  const { client } = fixtureClient();
  const routes = client.computeRoutes;
  let geometrySignal;
  client.computeRoutes = (from, to, options) => {
    if (from === origin && to !== destination && options.mode === 'bicycle') {
      geometrySignal = options.signal;
      return new Promise(() => {});
    }
    return routes(from, to, options);
  };
  const result = await createSearchService(client, { searchTimeoutMs: 20 }).search(input);
  assert.equal(result.results.length, 2);
  assert.ok(result.baseline);
  assert.ok(geometrySignal.aborted);
  assert.match(result.warnings.join(' '), /Map enrichment timed out/);
});

test('Caller cancellation and required geocode failure cancel outstanding work', async () => {
  const { client } = fixtureClient();
  const controller = new AbortController();
  let capturedSignal;
  client.geocodeAddress = (address, { signal }) => { capturedSignal = signal; return new Promise(() => {}); };
  const pending = createSearchService(client).search(input, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(capturedSignal.aborted);
  client.geocodeAddress = (address, { signal }) => {
    capturedSignal = signal;
    return address === input.origin ? Promise.reject(Error('geocode failed')) : new Promise(() => {});
  };
  await assert.rejects(createSearchService(client).search(input), /geocode failed/);
  assert.ok(capturedSignal.aborted);
});
