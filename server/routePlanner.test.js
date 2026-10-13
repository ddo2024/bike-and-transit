const test = require('node:test');
const assert = require('node:assert/strict');
const {
  rankRoutes,
  isCandidateEligible,
  dedupeRoutes,
  createCorridorSearchPoints,
  selectCandidateStops,
  isBoardingStopValid,
  createDirectBikeOption,
  createTransitItinerarySignature,
  resolveMaxBikeMinutes,
} = require('./routePlanner');

test('Creates two candidate search centers between the origin and destination', () => {
  const points = createCorridorSearchPoints(
    { lat: 37, lng: -122 },
    { lat: 38, lng: -121 },
  );

  assert.equal(points.length, 2);
  assert.ok(points[0].lat > 37 && points[0].lat < points[1].lat);
  assert.ok(points[1].lat < 38);
});

test('Reserves candidate capacity for corridor stops and deduplicates locations', () => {
  const originStops = Array.from({ length: 10 }, (_, index) => ({
    name: `Origin ${index}`,
    lat: 37 + index / 10000,
    lng: -122,
  }));
  const corridorStops = [
    [{ name: 'Corridor stop', lat: 37.5, lng: -121.5 }],
    [{ name: 'Duplicate origin', lat: originStops[0].lat, lng: originStops[0].lng }],
  ];

  const selected = selectCandidateStops({
    distanceStops: originStops,
    popularStops: originStops,
    corridorStopGroups: corridorStops,
    maxCandidates: 12,
  });

  assert.ok(selected.length <= 12);
  assert.equal(selected.length, 11);
  assert.ok(selected.some((stop) => stop.name === 'Corridor stop'));
  assert.equal(selected.filter((stop) => stop.lat === originStops[0].lat && stop.lng === originStops[0].lng).length, 1);
});

test('Rejects a transit itinerary boarding farther away than the allowed walk from its candidate stop', () => {
  const candidate = { lat: 37, lng: -122 };
  const actualStopNearby = { lat: 37.0005, lng: -122 };
  const actualStopFarAway = { lat: 37.0009, lng: -122 };

  assert.equal(isBoardingStopValid(candidate, actualStopNearby, new Date('2026-10-05T08:00:00Z'), new Date('2026-10-05T08:01:00Z')), true);
  assert.equal(isBoardingStopValid(candidate, actualStopFarAway, new Date('2026-10-05T08:00:00Z'), new Date('2026-10-05T08:01:00Z')), false);
});

test('Uses a bounded 30-minute bike limit when the max time is blank', () => {
  assert.equal(resolveMaxBikeMinutes(''), 30);
  assert.equal(resolveMaxBikeMinutes(null), 30);
  assert.equal(resolveMaxBikeMinutes('18'), 18);
  assert.equal(resolveMaxBikeMinutes('90'), 60);
});

test('Creates the same signature for the same scheduled transit trip from different bike access stops', () => {
  const route = {
    legs: [{ steps: [{
      travelMode: 'TRANSIT',
      transitDetails: {
        tripShortText: '23-0815',
        headsign: 'Downtown',
        transitLine: { nameShort: '23', agencies: [{ name: 'VTA', uri: 'https://www.vta.org' }] },
        stopDetails: {
          departureStop: { name: 'Alum Rock & Jackson' },
          departureTime: '2026-10-06T15:45:00-07:00',
          arrivalStop: { name: 'Santa Clara & 7th' },
          arrivalTime: '2026-10-06T16:02:00-07:00',
        },
      },
    }] }],
  };

  const differentAccess = structuredClone(route);
  differentAccess.legs[0].steps[0].transitDetails.stopDetails.departureStop.name = 'Alum Rock & King';
  differentAccess.legs[0].steps[0].transitDetails.stopDetails.departureTime = '2026-10-06T15:50:00-07:00';

  assert.equal(
    createTransitItinerarySignature(route),
    createTransitItinerarySignature(differentAccess),
  );
  assert.notEqual(
    createTransitItinerarySignature(route),
    createTransitItinerarySignature({
      legs: [{ steps: [{
        ...route.legs[0].steps[0],
        transitDetails: {
          ...route.legs[0].steps[0].transitDetails,
          tripShortText: '23-0820',
        },
      }] }],
    }),
  );

  assert.deepEqual(dedupeRoutes([
    { stopName: 'Alum Rock & Jackson', routeSignature: createTransitItinerarySignature(route), finalArrival: '2026-10-06T16:12:00-07:00' },
    { stopName: 'Alum Rock & King', routeSignature: createTransitItinerarySignature(differentAccess), finalArrival: '2026-10-06T16:10:00-07:00' },
  ]).map((item) => item.stopName), ['Alum Rock & King']);
});

function signatureRoute({ trip = '538', from = 'A', departure = '2026-10-06T23:55:00-07:00', arrival = '2026-10-07T00:20:00-07:00' } = {}) {
  return { legs: [{ steps: [{
    travelMode: 'TRANSIT',
    transitDetails: {
      tripShortText: trip,
      headsign: 'Northbound',
      transitLine: { nameShort: '22', agencies: [{ name: 'Agency A' }] },
      stopDetails: {
        departureStop: { name: from }, departureTime: departure,
        arrivalStop: { name: 'Common destination' }, arrivalTime: arrival,
      },
    },
  }] }] };
}

test('A shared alighting event anchors the same trip across midnight and offset representations', () => {
  const beforeMidnight = signatureRoute();
  const afterMidnight = signatureRoute({ from: 'B', departure: '2026-10-07T00:05:00-07:00', arrival: '2026-10-07T07:20:00Z' });
  assert.equal(createTransitItinerarySignature(beforeMidnight), createTransitItinerarySignature(afterMidnight));
  const nextServiceDay = signatureRoute({ departure: '2026-10-07T23:55:00-07:00', arrival: '2026-10-08T00:20:00-07:00' });
  assert.notEqual(createTransitItinerarySignature(beforeMidnight), createTransitItinerarySignature(nextServiceDay));
});

test('Preserves separate vehicles, agencies, directions, lines, and different final alighting events', () => {
  const original = signatureRoute();
  const variants = [
    (route) => { route.legs[0].steps[0].transitDetails.tripShortText = '540'; },
    (route) => { route.legs[0].steps[0].transitDetails.transitLine.agencies = [{ name: 'Agency B' }]; },
    (route) => { route.legs[0].steps[0].transitDetails.headsign = 'Southbound'; },
    (route) => { route.legs[0].steps[0].transitDetails.transitLine.nameShort = '23'; },
    (route) => { route.legs[0].steps[0].transitDetails.stopDetails.arrivalStop.name = 'Different destination'; },
  ];
  for (const change of variants) {
    const other = structuredClone(original);
    change(other);
    assert.notEqual(createTransitItinerarySignature(original), createTransitItinerarySignature(other));
  }
});

test('Without a trip identifier, only exact boarding and alighting events are deduplicated', () => {
  const first = signatureRoute({ trip: '' });
  const differentStop = signatureRoute({ trip: '', from: 'B', departure: '2026-10-07T00:05:00-07:00' });
  const differentDeparture = signatureRoute({ trip: '', departure: '2026-10-06T23:56:00-07:00' });
  assert.equal(createTransitItinerarySignature(first), createTransitItinerarySignature(structuredClone(first)));
  assert.notEqual(createTransitItinerarySignature(first), createTransitItinerarySignature(differentStop));
  assert.notEqual(createTransitItinerarySignature(first), createTransitItinerarySignature(differentDeparture));
});

test('Transfer vehicle sequences remain distinct even when the first vehicle is shared', () => {
  const first = signatureRoute();
  const onward = signatureRoute({ trip: '700', from: 'Transfer station', departure: '2026-10-07T00:25:00-07:00', arrival: '2026-10-07T00:40:00-07:00' });
  first.legs[0].steps.push(onward.legs[0].steps[0]);
  const second = structuredClone(first);
  second.legs[0].steps[1].transitDetails.tripShortText = '701';
  assert.notEqual(createTransitItinerarySignature(first), createTransitItinerarySignature(second));
  assert.notEqual(createTransitItinerarySignature(first), createTransitItinerarySignature(signatureRoute()));
});

test('Rejects a transit itinerary whose first vehicle departs before bike arrival', () => {
  const candidate = { lat: 37, lng: -122 };

  assert.equal(isBoardingStopValid(
    candidate,
    candidate,
    new Date('2026-10-05T08:02:00Z'),
    new Date('2026-10-05T08:01:00Z'),
  ), false);
});

test('Creates a direct-bike option using the configured speed and leaves it as a separate mode', () => {
  const directRoute = createDirectBikeOption({
    distanceMeters: 8046.72,
    departureTime: new Date('2026-10-05T08:00:00Z'),
    bikeSpeedMph: 8,
    polyline: 'encoded-path',
  });

  assert.equal(directRoute.mode, 'direct-bike');
  assert.equal(directRoute.bikeDistanceMiles, 5);
  assert.equal(directRoute.bikeMinutes, 37.5);
  assert.equal(directRoute.totalMinutes, 37.5);
  assert.equal(directRoute.finalArrival.toISOString(), '2026-10-05T08:37:30.000Z');
  assert.equal(directRoute.firstBikePolyline, 'encoded-path');
});

test('Stop B wins when it has a shorter overall arrival time despite slightly longer bike ride', () => {
  const routes = [
    {
      stopName: 'Stop A',
      bikeMinutes: 4,
      bikeDistanceMiles: 0.5,
      arrivalAtStop: new Date('2026-09-22T07:34:00'),
      waitMinutes: 15,
      transitMinutes: 20,
      walkingMinutes: 3,
      totalMinutes: 42,
      finalArrival: new Date('2026-09-22T08:16:00'),
    },
    {
      stopName: 'Stop B',
      bikeMinutes: 10,
      bikeDistanceMiles: 1.2,
      arrivalAtStop: new Date('2026-09-22T07:40:00'),
      waitMinutes: 2,
      transitMinutes: 20,
      walkingMinutes: 3,
      totalMinutes: 35,
      finalArrival: new Date('2026-09-22T08:15:00'),
    },
  ];

  const ranked = rankRoutes(routes);
  assert.equal(ranked[0].stopName, 'Stop B');
  assert.equal(ranked[1].stopName, 'Stop A');
});

test('Rejects stops if the transit departure would be missed', () => {
  const route = {
    stopName: 'Late Stop',
    bikeMinutes: 12,
    bikeDistanceMiles: 1.4,
    arrivalAtStop: new Date('2026-09-22T07:42:00'),
    transitDepartureTime: new Date('2026-09-22T07:40:00'),
    waitMinutes: 0,
    transitMinutes: 20,
    walkingMinutes: 3,
  };

  assert.equal(isCandidateEligible(route, { maxBikeMinutes: 15 }), false);
});

test('Rejects a stop above the maximum bike time', () => {
  const route = {
    stopName: 'Far Stop',
    bikeMinutes: 17,
    bikeDistanceMiles: 2.1,
    arrivalAtStop: new Date('2026-09-22T07:47:00'),
    waitMinutes: 5,
    transitMinutes: 23,
    walkingMinutes: 2,
  };

  assert.equal(isCandidateEligible(route, { maxBikeMinutes: 15 }), false);
});

test('Avoids duplicate recommendations from effectively identical itineraries', () => {
  const routes = [
    {
      stopName: 'Stop 1',
      bikeMinutes: 6,
      bikeDistanceMiles: 0.8,
      arrivalAtStop: new Date('2026-09-22T07:36:00'),
      waitMinutes: 2,
      transitMinutes: 20,
      walkingMinutes: 3,
      finalArrival: new Date('2026-09-22T08:01:00'),
      routeSignature: 'bus-42|20|min',
    },
    {
      stopName: 'Stop 2',
      bikeMinutes: 6.2,
      bikeDistanceMiles: 0.82,
      arrivalAtStop: new Date('2026-09-22T07:36:00'),
      waitMinutes: 2,
      transitMinutes: 20,
      walkingMinutes: 3,
      finalArrival: new Date('2026-09-22T08:01:00'),
      routeSignature: 'bus-42|20|min',
    },
  ];

  const deduped = dedupeRoutes(routes);
  assert.equal(deduped.length, 1);
});

test('Keeps the earliest arrival when duplicate access points reach the same transit trip', () => {
  const deduped = dedupeRoutes([
    { routeSignature: 'same-trip', stopName: 'Later access', finalArrival: new Date('2026-10-06T16:10:00Z') },
    { routeSignature: 'same-trip', stopName: 'Earlier access', finalArrival: new Date('2026-10-06T16:08:00Z') },
  ]);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].stopName, 'Earlier access');
});
