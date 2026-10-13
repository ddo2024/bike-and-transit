function minutesBetween(start, end) {
  if (!start || !end) return 0;
  return (end.getTime() - start.getTime()) / 60000;
}

function toDate(dateOrString) {
  if (dateOrString instanceof Date) return new Date(dateOrString.getTime());
  return new Date(dateOrString);
}

function createRouteSignature(route) {
  const routeName = route.transitRoute || route.routeName || route.lineName || 'unknown';
  const finalArrivalMs = route.finalArrival ? new Date(route.finalArrival).getTime() : 0;
  const parts = [
    routeName,
    Number(route.transitMinutes ?? 0),
    Number(route.waitMinutes ?? 0),
    Number(route.walkingMinutes ?? 0),
    Number(route.transferCount ?? 0),
    Math.round(finalArrivalMs / 60000),
  ];
  return parts.join('|');
}

function isCandidateEligible(route, options = {}) {
  const maxBikeMinutes = Number(options.maxBikeMinutes ?? 15);

  const bikeMinutes = Number(route.bikeMinutes ?? 0);
  if (!Number.isFinite(bikeMinutes) || bikeMinutes < 0) return false;
  if (bikeMinutes > maxBikeMinutes) return false;

  if (route.arrivalAtStop && route.transitDepartureTime) {
    const arrivalAtStop = toDate(route.arrivalAtStop);
    const departure = toDate(route.transitDepartureTime);
    if (departure.getTime() < arrivalAtStop.getTime()) {
      return false;
    }
  }

  return true;
}

function rankRoutes(routes = []) {
  return [...routes]
    .filter((route) => route && route.finalArrival)
    .sort((a, b) => new Date(a.finalArrival) - new Date(b.finalArrival));
}

function dedupeRoutes(routes = []) {
  const seen = new Map();
  const deduped = [];

  const earliestFirst = [...routes].sort((first, second) => {
    const firstArrival = first.finalArrival ? new Date(first.finalArrival).getTime() : Infinity;
    const secondArrival = second.finalArrival ? new Date(second.finalArrival).getTime() : Infinity;
    return firstArrival - secondArrival;
  });

  for (const route of earliestFirst) {
    const signature = route.routeSignature || createRouteSignature(route);
    if (!seen.has(signature)) {
      seen.set(signature, true);
      deduped.push(route);
    }
  }

  return deduped;
}

function createCorridorSearchPoints(origin, destination) {
  const fractions = [1 / 3, 2 / 3];
  return fractions.map((fraction) => ({
    lat: origin.lat + (destination.lat - origin.lat) * fraction,
    lng: origin.lng + (destination.lng - origin.lng) * fraction,
  }));
}

function selectCandidateStops({ distanceStops = [], popularStops = [], corridorStopGroups = [], maxCandidates = 12 }) {
  const candidateGroups = [
    distanceStops.slice(0, 4),
    popularStops.slice(0, 2),
    ...corridorStopGroups.map((stops) => stops.slice(0, 3)),
  ];
  const selected = [];
  const seenCoordinates = new Set();

  function add(stop) {
    const coordinateKey = `${Number(stop.lat).toFixed(4)}|${Number(stop.lng).toFixed(4)}`;
    if (seenCoordinates.has(coordinateKey) || selected.length >= maxCandidates) return;
    seenCoordinates.add(coordinateKey);
    selected.push(stop);
  }

  candidateGroups.forEach((group) => group.forEach(add));

  if (selected.length < maxCandidates) {
    [distanceStops, popularStops, ...corridorStopGroups]
      .flat()
      .forEach(add);
  }

  return selected;
}

function distanceMetersBetween(first, second) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(second.lat - first.lat);
  const longitudeDelta = radians(second.lng - first.lng);
  const firstLatitude = radians(first.lat);
  const secondLatitude = radians(second.lat);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function isBoardingStopValid(candidate, boardingStop, readyAt, scheduledDeparture, maxWalkMeters = 75) {
  if (!candidate || !boardingStop || !readyAt || !scheduledDeparture) return false;
  if (![candidate.lat, candidate.lng, boardingStop.lat, boardingStop.lng].every(Number.isFinite)) return false;

  const readyAtDate = new Date(readyAt);
  const departureDate = new Date(scheduledDeparture);
  if (!Number.isFinite(readyAtDate.getTime()) || !Number.isFinite(departureDate.getTime())) return false;
  if (departureDate.getTime() < readyAtDate.getTime()) return false;

  return distanceMetersBetween(candidate, boardingStop) <= maxWalkMeters;
}

function createDirectBikeOption({ distanceMeters, departureTime, bikeSpeedMph, polyline }) {
  const speed = Number(bikeSpeedMph) > 0 ? Number(bikeSpeedMph) : 8;
  const bikeDistanceMiles = Number(distanceMeters) / 1609.344;
  const bikeMinutes = bikeDistanceMiles / speed * 60;
  const departure = new Date(departureTime);

  return {
    mode: 'direct-bike',
    bikeDistanceMiles: Number(bikeDistanceMiles.toFixed(2)),
    bikeMinutes: Number(bikeMinutes.toFixed(1)),
    totalMinutes: Number(bikeMinutes.toFixed(1)),
    finalArrival: new Date(departure.getTime() + bikeMinutes * 60000),
    firstBikePolyline: polyline || null,
  };
}

function resolveMaxBikeMinutes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 30;
  return Math.min(parsed, 60);
}

function createTransitItinerarySignature(routeData) {
  function stopIdentity(stop) {
    const latLng = stop?.location?.latLng || stop?.location;
    return [stop?.name || '', latLng?.latitude ?? null, latLng?.longitude ?? null];
  }

  function timestamp(value) {
    const parsed = typeof value === 'string' && value.trim() ? new Date(value).getTime() : NaN;
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value || '';
  }

  const transitSteps = (routeData.legs || [])
    .flatMap((leg) => leg.steps || [])
    .filter((step) => step.travelMode === 'TRANSIT')
    .map((step) => {
      const details = step.transitDetails || {};
      const stops = details.stopDetails || {};
      const line = details.transitLine || {};
      const lineIdentity = [line.uri || '', line.nameShort || '', line.name || ''];
      const trip = typeof details.tripShortText === 'string' ? details.tripShortText.trim() : '';
      const arrival = timestamp(stops.arrivalTime);
      const hasTripIdentity = trip && lineIdentity.some(Boolean) && stops.arrivalStop
        && Number.isFinite(new Date(arrival).getTime());
      return {
        agencies: (line.agencies || []).map((agency) => agency.uri || agency.name || '').sort(),
        line: lineIdentity,
        headsign: details.headsign || '',
        vehicle: line.vehicle?.type || '',
        trip,
        // tripShortText is unique only within a service day. A shared alighting
        // event anchors that day even when access stops straddle midnight.
        // Without a trip identifier, matching line numbers alone is not proof
        // that two boarding events use the same vehicle.
        ...(hasTripIdentity ? {} : {
          from: stopIdentity(stops.departureStop),
          departure: timestamp(stops.departureTime),
        }),
        to: stopIdentity(stops.arrivalStop),
        arrival,
      };
    });

  return transitSteps.length ? JSON.stringify(transitSteps) : '';
}

module.exports = {
  minutesBetween,
  isCandidateEligible,
  rankRoutes,
  dedupeRoutes,
  createRouteSignature,
  createCorridorSearchPoints,
  selectCandidateStops,
  isBoardingStopValid,
  createDirectBikeOption,
  resolveMaxBikeMinutes,
  createTransitItinerarySignature,
};
