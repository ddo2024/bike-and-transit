const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDurationSeconds,
  readLatLng,
  getFirstTransitStop,
  getLastTransitStop,
  getTransitDestinationArrival,
  summarizeTransitRoute,
} = require('./transitSummary');

function ride(line, from, to, departureTime, arrivalTime) {
  return {
    travelMode: 'TRANSIT',
    // Scheduled timestamps, not this deliberately different static estimate,
    // determine time aboard a transit vehicle.
    staticDuration: '1s',
    transitDetails: {
      transitLine: { nameShort: line },
      headsign: 'Downtown',
      stopDetails: {
        departureStop: { name: from, location: { latLng: { latitude: 37, longitude: -122 } } },
        arrivalStop: { name: to, location: { latLng: { latitude: 37.1, longitude: -122 } } },
        departureTime,
        arrivalTime,
      },
    },
  };
}

function transferRoute() {
  return {
    duration: '2400s',
    legs: [{ steps: [
      { travelMode: 'WALK', staticDuration: '120s' },
      ride('22', 'First boarding', 'Transfer west', '2026-10-12T08:05:00Z', '2026-10-12T08:15:00Z'),
      { travelMode: 'WALK', staticDuration: '120s' },
      { travelMode: 'WALK', staticDuration: '60s' },
      ride('23', 'Transfer east', 'Final alighting', '2026-10-12T08:20:00Z', '2026-10-12T08:35:00Z'),
      { travelMode: 'WALK', staticDuration: '300s' },
    ] }],
  };
}

test('Counts two transit rides in a single leg as one transfer and preserves their stops and times', () => {
  const summary = summarizeTransitRoute(transferRoute(), {
    readyAt: new Date('2026-10-12T08:00:00Z'),
    excludeFinalWalk: true,
  });

  assert.equal(summary.transferCount, 1);
  assert.equal(summary.routeName, '22, 23');
  assert.deepEqual(summary.transitLines, ['22', '23']);
  assert.equal(summary.waitMinutes, 5);
  assert.equal(summary.transitMinutes, 25);
  assert.equal(summary.walkingMinutes, 5);
  assert.equal(summary.totalMinutes, 40);
  assert.deepEqual(summary.transitSteps.map((step) => step.mode), ['WALK', 'TRANSIT', 'WALK', 'TRANSIT']);
  assert.deepEqual(summary.transitSteps[1], {
    mode: 'TRANSIT', line: '22', headsign: 'Downtown',
    departureStop: 'First boarding', arrivalStop: 'Transfer west',
    departureTime: '2026-10-12T08:05:00.000Z', arrivalTime: '2026-10-12T08:15:00.000Z', minutes: 10,
  });
  assert.deepEqual(summary.transitSteps[2], {
    mode: 'WALK', line: null, headsign: null,
    departureStop: 'Transfer west', arrivalStop: 'Transfer east',
    departureTime: null, arrivalTime: null, minutes: 3,
  });
});

test('Normal-transit baseline retains the final walk and exact original route duration', () => {
  const route = transferRoute();
  route.duration = '2401s';
  const summary = summarizeTransitRoute(route);
  assert.equal(summary.walkingMinutes, 10);
  assert.equal(summary.totalMinutes, 2401 / 60);
  assert.equal(summary.transitSteps.at(-1).arrivalStop, 'Destination');
});

test('Single transit ride has zero transfers even if the route has multiple legs', () => {
  const route = transferRoute();
  route.legs = [{ steps: [route.legs[0].steps[0]] }, { steps: [route.legs[0].steps[1]] }];
  assert.equal(summarizeTransitRoute(route).transferCount, 0);
});

test('No wait is invented when cycling reaches a vehicle exactly at departure', () => {
  const route = {
    duration: '1500s',
    legs: [{ steps: [
      ride('22', 'A', 'B', '2026-10-12T08:05:00Z', '2026-10-12T08:15:00Z'),
      { travelMode: 'WALK', staticDuration: '300s' },
    ] }],
  };
  const summary = summarizeTransitRoute(route, { readyAt: '2026-10-12T08:05:00Z', excludeFinalWalk: true });
  assert.equal(summary.waitMinutes, 0);
  assert.equal(summary.walkingMinutes, 0);
  assert.equal(summary.transitMinutes, 10);
});

test('Stop helpers reject missing or invalid timestamps rather than returning Invalid Date', () => {
  const route = transferRoute();
  assert.equal(getFirstTransitStop(route).name, 'First boarding');
  assert.equal(getLastTransitStop(route).name, 'Final alighting');
  route.legs[0].steps[1].transitDetails.stopDetails.departureTime = 'invalid';
  route.legs[0].steps[4].transitDetails.stopDetails.arrivalTime = null;
  assert.equal(getFirstTransitStop(route), null);
  assert.equal(getLastTransitStop(route), null);
  assert.throws(() => summarizeTransitRoute(route), /scheduled times/);
});

test('Rejects backwards rides, overlapping vehicles, missed initial boarding, and impossible transfer walks', () => {
  const invalidRide = transferRoute();
  invalidRide.legs[0].steps[1].transitDetails.stopDetails.arrivalTime = '2026-10-12T08:04:00Z';
  assert.throws(() => summarizeTransitRoute(invalidRide), /scheduled times/);

  const overlap = transferRoute();
  overlap.legs[0].steps[4].transitDetails.stopDetails.departureTime = '2026-10-12T08:14:00Z';
  assert.throws(() => summarizeTransitRoute(overlap), /scheduled times/);

  const impossibleWalk = transferRoute();
  impossibleWalk.legs[0].steps[4].transitDetails.stopDetails.departureTime = '2026-10-12T08:17:00Z';
  assert.throws(() => summarizeTransitRoute(impossibleWalk), /scheduled times/);
  assert.throws(() => summarizeTransitRoute(transferRoute(), { readyAt: '2026-10-12T08:04:00Z' }), /scheduled times/);
});

test('A missing first or last transit stop does not silently select a different ride', () => {
  const route = transferRoute();
  delete route.legs[0].steps[1].transitDetails.stopDetails.departureStop;
  delete route.legs[0].steps[4].transitDetails.stopDetails.arrivalStop;
  assert.equal(getFirstTransitStop(route), null);
  assert.equal(getLastTransitStop(route), null);
});

test('Duration parsing distinguishes legitimate zero from malformed or absent metrics', () => {
  assert.equal(parseDurationSeconds('0s'), 0);
  assert.equal(parseDurationSeconds(0), 0);
  assert.equal(parseDurationSeconds('3.5s'), 3.5);
  for (const invalid of [undefined, null, '', '-1s', -1, Infinity, '1..2s', 'NaNs', '3']) {
    assert.ok(Number.isNaN(parseDurationSeconds(invalid)));
  }
  assert.equal(readLatLng({ latitude: 91, longitude: 0 }), null);
  assert.equal(readLatLng({ latitude: 0, longitude: -181 }), null);
  assert.equal(readLatLng({ latitude: '37', longitude: -122 }), null);
});

test('Baseline arrival uses the last scheduled alighting plus final walk, including initial wait', () => {
  const requestedDeparture = new Date('2026-10-12T18:38:00Z');
  const route = {
    duration: '1736s',
    legs: [{ steps: [
      { travelMode: 'WALK', staticDuration: '270s' },
      ride('22', 'Boarding', 'Final alighting', '2026-10-12T18:52:00Z', '2026-10-12T19:08:40Z'),
      { travelMode: 'WALK', staticDuration: '271s' },
      { travelMode: 'WALK', staticDuration: '195s' },
    ] }],
  };
  const arrival = getTransitDestinationArrival(route);
  assert.equal(arrival.toISOString(), '2026-10-12T19:16:26.000Z');
  assert.equal((arrival - requestedDeparture) / 1000, 2306);
  assert.equal(new Date(requestedDeparture.getTime() + parseDurationSeconds(route.duration) * 1000).toISOString(),
    '2026-10-12T19:06:56.000Z');
  assert.equal(summarizeTransitRoute(route, { readyAt: requestedDeparture }).waitMinutes, 9.5);
});

test('Destination arrival preserves the last schedule without a final walk and returns null for walking-only routes', () => {
  const route = {
    legs: [{ steps: [ride('22', 'A', 'B', '2026-10-12T08:05:00Z', '2026-10-12T08:15:00Z')] }],
  };
  assert.equal(getTransitDestinationArrival(route).toISOString(), '2026-10-12T08:15:00.000Z');
  assert.equal(getTransitDestinationArrival({ legs: [{ steps: [{ travelMode: 'WALK', staticDuration: '60s' }] }] }), null);
});

test('Destination arrival rejects invalid schedules, malformed final walks, and unsupported trailing movement', () => {
  const invalidSchedule = transferRoute();
  invalidSchedule.legs[0].steps[4].transitDetails.stopDetails.arrivalTime = 'invalid';
  assert.throws(() => getTransitDestinationArrival(invalidSchedule), /scheduled arrival/);
  for (const trailing of [
    { travelMode: 'WALK' },
    { travelMode: 'WALK', staticDuration: '-60s' },
    { travelMode: 'BICYCLE', staticDuration: '60s' },
    {},
  ]) {
    const route = transferRoute();
    route.legs[0].steps[5] = trailing;
    assert.throws(() => getTransitDestinationArrival(route), /walking duration|unsupported movement/);
  }
});
