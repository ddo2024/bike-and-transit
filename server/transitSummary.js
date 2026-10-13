function parseDurationSeconds(duration) {
  if (typeof duration === 'number') {
    return Number.isFinite(duration) && duration >= 0 ? duration : NaN;
  }
  if (typeof duration !== 'string' || !/^\d+(?:\.\d+)?s$/.test(duration)) return NaN;
  const seconds = Number(duration.slice(0, -1));
  return Number.isFinite(seconds) ? seconds : NaN;
}

function readLatLng(location) {
  const latLng = location?.latLng || location;
  if (!Number.isFinite(latLng?.latitude) || !Number.isFinite(latLng?.longitude)) return null;
  if (Math.abs(latLng.latitude) > 90 || Math.abs(latLng.longitude) > 180) return null;
  return { lat: latLng.latitude, lng: latLng.longitude };
}

function validDate(value) {
  if (!(value instanceof Date) && (typeof value !== 'string' || !value.trim())) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function routeSteps(routeData) {
  return (routeData.legs || []).flatMap((leg) => leg.steps || []);
}

function getFirstTransitStop(routeData) {
  const step = routeSteps(routeData).find((item) => item.travelMode === 'TRANSIT');
  const details = step?.transitDetails?.stopDetails;
  const coordinates = readLatLng(details?.departureStop?.location);
  const departureTime = validDate(details?.departureTime);
  if (!coordinates || !departureTime) return null;
  return {
    name: details.departureStop.name || 'Transit boarding stop',
    ...coordinates,
    departureTime,
  };
}

function getLastTransitStop(routeData) {
  const step = routeSteps(routeData).filter((item) => item.travelMode === 'TRANSIT').at(-1);
  const details = step?.transitDetails?.stopDetails;
  const coordinates = readLatLng(details?.arrivalStop?.location);
  const arrivalTime = validDate(details?.arrivalTime);
  if (!coordinates || !arrivalTime) return null;
  return {
    name: details.arrivalStop.name || 'Final transit stop',
    ...coordinates,
    arrivalTime,
  };
}

function getTransitDestinationArrival(routeData) {
  const steps = routeSteps(routeData);
  const finalTransitIndex = steps.findLastIndex((step) => step.travelMode === 'TRANSIT');
  if (finalTransitIndex < 0) return null;

  const arrival = validDate(steps[finalTransitIndex].transitDetails?.stopDetails?.arrivalTime);
  if (!arrival) throw new Error('Transit route has an invalid final scheduled arrival.');
  let trailingWalkSeconds = 0;
  for (const step of steps.slice(finalTransitIndex + 1)) {
    if (step.travelMode !== 'WALK') throw new Error('Transit route has unsupported movement after its final transit ride.');
    const seconds = parseDurationSeconds(step.staticDuration);
    if (!Number.isFinite(seconds)) throw new Error('Transit route has an invalid final walking duration.');
    trailingWalkSeconds += seconds;
  }

  // A transit route's duration can exclude waiting before its suggested start.
  // Anchor the destination time to the actual schedule instead of the request.
  const destinationArrival = new Date(arrival.getTime() + trailingWalkSeconds * 1000);
  if (!Number.isFinite(destinationArrival.getTime())) throw new Error('Transit route has an invalid destination arrival.');
  return destinationArrival;
}

function minutes(seconds) {
  return Number((seconds / 60).toFixed(1));
}

function summarizeTransitRoute(routeData, { readyAt, excludeFinalWalk = false } = {}) {
  const totalDurationSeconds = parseDurationSeconds(routeData.duration);
  if (!Number.isFinite(totalDurationSeconds)) throw new Error('Transit route has an invalid duration.');

  const steps = routeSteps(routeData);
  const finalTransitIndex = steps.findLastIndex((step) => step.travelMode === 'TRANSIT');
  const transitLines = [];
  const transitSteps = [];
  const start = readyAt == null ? null : validDate(readyAt);
  if (readyAt != null && !start) throw new Error('Transit route has an invalid ready time.');

  let transitSeconds = 0;
  let walkingSeconds = 0;
  let walkingThroughTransitSeconds = 0;
  let allWalkingSeconds = 0;
  let pendingWalkingSeconds = 0;
  let previousArrival = start;
  let lastTransitArrival = null;
  let transitCount = 0;

  for (const [index, step] of steps.entries()) {
    if (step.travelMode === 'TRANSIT') {
      const details = step.transitDetails || {};
      const stops = details.stopDetails || {};
      const departure = validDate(stops.departureTime);
      const arrival = validDate(stops.arrivalTime);
      if (!departure || !arrival || arrival < departure
        || (previousArrival && departure.getTime() < previousArrival.getTime() + pendingWalkingSeconds * 1000)) {
        throw new Error('Transit route has invalid or nonchronological scheduled times.');
      }

      const line = details.transitLine?.nameShort || details.transitLine?.name || 'Transit';
      if (!transitLines.includes(line)) transitLines.push(line);
      const seconds = (arrival.getTime() - departure.getTime()) / 1000;
      transitSteps.push({
        mode: 'TRANSIT',
        line,
        headsign: details.headsign || null,
        departureStop: stops.departureStop?.name || 'Transit boarding stop',
        arrivalStop: stops.arrivalStop?.name || 'Transit alighting stop',
        departureTime: departure.toISOString(),
        arrivalTime: arrival.toISOString(),
        minutes: minutes(seconds),
      });
      transitSeconds += seconds;
      transitCount += 1;
      previousArrival = arrival;
      lastTransitArrival = arrival;
      pendingWalkingSeconds = 0;
    } else if (step.travelMode === 'WALK') {
      const seconds = parseDurationSeconds(step.staticDuration);
      if (!Number.isFinite(seconds)) throw new Error('Transit route has an invalid walking duration.');
      allWalkingSeconds += seconds;
      pendingWalkingSeconds += seconds;
      if (index < finalTransitIndex) walkingThroughTransitSeconds += seconds;
      if (excludeFinalWalk && index > finalTransitIndex) continue;

      walkingSeconds += seconds;
      const previousTransit = steps.slice(0, index).findLast((item) => item.travelMode === 'TRANSIT');
      const nextTransit = steps.slice(index + 1).find((item) => item.travelMode === 'TRANSIT');
      const previousWalk = transitSteps.at(-1);
      // Google can split one transfer walk into several navigation steps.
      // Keep one human-readable connection rather than repeating its stops.
      if (previousWalk?.mode === 'WALK') {
        previousWalk.seconds += seconds;
        previousWalk.minutes = minutes(previousWalk.seconds);
      } else {
        transitSteps.push({
          mode: 'WALK',
          line: null,
          headsign: null,
          departureStop: previousTransit?.transitDetails?.stopDetails?.arrivalStop?.name || 'Transit route start',
          arrivalStop: nextTransit?.transitDetails?.stopDetails?.departureStop?.name || 'Destination',
          departureTime: null,
          arrivalTime: null,
          seconds,
          minutes: minutes(seconds),
        });
      }
    }
  }

  const elapsedThroughTransit = start && lastTransitArrival
    ? (lastTransitArrival.getTime() - start.getTime()) / 1000
    : null;
  const waitingSeconds = elapsedThroughTransit == null
    ? Math.max(0, totalDurationSeconds - transitSeconds - allWalkingSeconds)
    : Math.max(0, elapsedThroughTransit - transitSeconds - walkingThroughTransitSeconds);

  return {
    routeName: transitLines.join(', ') || 'Transit',
    transitLines,
    waitMinutes: minutes(waitingSeconds),
    walkingMinutes: minutes(walkingSeconds),
    transitMinutes: minutes(transitSeconds),
    transferCount: Math.max(0, transitCount - 1),
    // Keep the Google route duration intact for the normal-transit baseline.
    totalMinutes: totalDurationSeconds / 60,
    transitSteps: transitSteps.map(({ seconds, ...step }) => step),
  };
}

module.exports = {
  parseDurationSeconds,
  readLatLng,
  getFirstTransitStop,
  getLastTransitStop,
  getTransitDestinationArrival,
  summarizeTransitRoute,
};
