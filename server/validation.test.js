const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSearchRequest } = require('./validation');
const { input } = require('./fixtures/search');

test('Validation preserves defaults/cap, trims addresses and normalizes an explicit timezone', () => {
  assert.deepEqual(validateSearchRequest({ ...input, origin: ' Origin ', bikeSpeedMph: '', maxBikeMinutes: '',
    departureTime: '2026-10-12T11:38:00-07:00' }), { ...input, departureTime: '2026-10-12T18:38:00.000Z' });
  assert.equal(validateSearchRequest({ ...input, maxBikeMinutes: '90' }).maxBikeMinutes, 60);
  assert.equal(validateSearchRequest({ ...input, bikeSpeedMph: '9.5' }).bikeSpeedMph, 9.5);
  assert.equal(validateSearchRequest({ ...input, departureTime: '2028-02-29T12:00:00Z' }).departureTime, '2028-02-29T12:00:00.000Z');
});

test('Malformed strings, numbers, and dates are rejected before routing', () => {
  for (const body of [null, [], { ...input, origin: '  ' }, { ...input, destination: {} },
    ...[-8, 0, Infinity, 'NaN', [], {}, true, ' '].map(bikeSpeedMph => ({ ...input, bikeSpeedMph })),
    ...[-1, 0, 'bad', {}].map(maxBikeMinutes => ({ ...input, maxBikeMinutes })),
    ...['bad', '', '2026-10-12T11:38', '2026-02-29T12:00Z', '2026-04-31T12:00Z',
      '2026-10-12T24:00Z', '2026-10-12T11:38:00+25:00'].map(departureTime => ({ ...input, departureTime })),
  ]) assert.throws(() => validateSearchRequest(body), { statusCode: 400 });
});
