const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
const requestModule = require('./requestJson');

// Capture the dependency before loading the adapter. Each node:test file runs
// in its own process, and the module mock is immediately restored.
const calls = [];
let nextResponse;
const requestMock = mock.method(requestModule, 'requestJson', async (url, options) => {
  calls.push({ url, options });
  return nextResponse;
});
const maps = require('./googleMaps');
requestMock.mock.restore();

test('Google helpers forward cancellation/deadline options and retain request policies', async (t) => {
  const previousKey = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = 'test-placeholder';
  t.after(() => {
    if (previousKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = previousKey;
  });
  const controller = new AbortController();
  const options = { signal: controller.signal, timeoutMs: 1234 };
  const origin = { lat: 1, lng: 2 };
  const destination = { lat: 3, lng: 4 };

  nextResponse = { places: [] };
  await maps.geocodeAddress('Test origin', options);
  await maps.findNearbyTransitStops(origin, 2000, 'DISTANCE', options);
  nextResponse = { routes: [] };
  await maps.computeRoutes(origin, destination, {
    ...options, mode: 'transit', departureTime: new Date('2026-10-12T10:00:00Z'),
  });
  nextResponse = [];
  await maps.computeBikeMatrix(origin, [destination], options);
  await maps.computeBikeEgressMatrix([origin, destination], destination, options);

  assert.equal(calls.length, 5);
  for (const call of calls) {
    assert.equal(call.options.signal, controller.signal);
    assert.equal(call.options.timeoutMs, 1234);
  }
  assert.equal(calls[2].options.body.travelMode, 'TRANSIT');
  assert.equal(calls[2].options.body.computeAlternativeRoutes, false);
  assert.equal(calls[2].options.body.departureTime, '2026-10-12T10:00:00.000Z');
  const matrixMask = calls[3].options.headers['X-Goog-FieldMask'].split(',');
  for (const required of ['condition', 'status', 'distanceMeters', 'duration', 'destinationIndex']) {
    assert.ok(matrixMask.includes(required), `missing matrix field: ${required}`);
  }
  assert.equal(calls[3].options.body.travelMode, 'BICYCLE');
  assert.equal(calls[4].options.body.origins.length, 2);
  assert.equal(calls[4].options.body.destinations.length, 1);
});
