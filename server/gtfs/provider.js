const { scanJourneys, signature } = require('./planner');
const { meters, serviceDate } = require('./time');
const { readMatrixRide } = require('../searchService');

const round = n => Math.round(n * 10) / 10;
function transitPath(feed, ride) {
  const { instance, from, to } = ride;
  const a = instance.times[from]; const b = instance.times[to];
  const shape = feed.shapes.get(instance.trip.shape_id);
  if (shape?.length && a.shapeDistance != null && b.shapeDistance != null) {
    const points = shape.filter(p => p.distance != null && p.distance >= a.shapeDistance && p.distance <= b.shapeDistance);
    if (points.length >= 2) return { points: points.map(({lat,lng})=>({lat,lng})), approximate: false };
  }
  // No invented road geometry: a stop-to-stop schematic is explicitly labeled.
  return { points: instance.times.slice(from,to+1).map(p=>{const s=feed.stops.get(p.stopId);return {lat:s.lat,lng:s.lng};}), approximate: true };
}
function bestDistinct(items) {
  const sorted = [...items].sort((a, b) => a.finalArrival - b.finalArrival || a.access.minutes - b.access.minutes);
  const seen = new Set();
  return sorted.filter(item => { const key = signature(item); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 3);
}

function routeResult(feed, state, departureMs, realtime) {
  const rides = state.segments.filter(s => s.mode === 'TRANSIT');
  const first = rides[0]; const last = rides.at(-1);
  const boarding = first.instance.times[first.from]; const alighting = last.instance.times[last.to];
  const stop = feed.stops.get(boarding.stopId); const finalStop = feed.stops.get(alighting.stopId);
  let transitMinutes = 0; let walkingMinutes = 0;
  const transitSteps = state.segments.map(segment => {
    if (segment.mode === 'WALK') {
      const minutes = (segment.arrival - segment.departure) / 60000; walkingMinutes += minutes;
      return { mode: 'WALK', from: feed.stops.get(segment.fromStop).name, to: feed.stops.get(segment.toStop).name,
        minutes: round(minutes), estimated: true };
    }
    const { instance, from, to } = segment; const a = instance.times[from]; const b = instance.times[to];
    const minutes = (b.arrival - a.departure) / 60000; transitMinutes += minutes;
    return { mode: 'TRANSIT', line: instance.route.route_short_name || instance.route.route_long_name,
      headsign: instance.trip.trip_headsign, tripId: instance.trip.trip_id, serviceDate: instance.date,
      departureStopId: a.stopId, arrivalStopId: b.stopId,
      departureStop: feed.stops.get(a.stopId).name, arrivalStop: feed.stops.get(b.stopId).name,
      departureTime: new Date(a.departure), arrivalTime: new Date(b.arrival), minutes: round(minutes),
      scheduledDepartureTime: new Date(a.scheduledDeparture), scheduledArrivalTime: new Date(b.scheduledArrival),
      departureSource: a.departureSource, arrivalSource: b.arrivalSource,
      bikesAllowed: instance.trip.bikes_allowed === '1' ? 'yes' : 'unknown' };
  });
  const lines = [...new Set(transitSteps.filter(s => s.mode === 'TRANSIT').map(s => s.line))];
  const alerts = realtime?.alertsFor ? realtime.alertsFor(rides) : [];
  return { stopName: stop.name, stopLat: stop.lat, stopLng: stop.lng, boardingLat: stop.lat, boardingLng: stop.lng,
    boardingStop: stop.name, finalTransitStop: finalStop.name, finalStopLat: finalStop.lat, finalStopLng: finalStop.lng,
    bikeDistanceMiles: round(state.access.distanceMeters / 1609.344), bikeMinutes: round(state.access.minutes),
    arrivalAtStop: new Date(departureMs + state.access.minutes * 60000), transitDepartureTime: new Date(boarding.departure),
    finalTransitArrival: new Date(alighting.arrival), finalArrival: new Date(state.finalArrival),
    finalBikeDistanceMiles: round(state.egress.distanceMeters / 1609.344), finalBikeMinutes: round(state.egress.minutes),
    totalMinutes: round((state.finalArrival - departureMs) / 60000), transitMinutes: round(transitMinutes),
    walkingMinutes: round(walkingMinutes), waitMinutes: round((alighting.arrival - departureMs) / 60000 - state.access.minutes - transitMinutes - walkingMinutes),
    transferCount: rides.length - 1, transitLines: lines, transitRoute: lines.join(', '), transitSteps,
    routeSignature: signature(state), source: feed.source, feedVersion: feed.version,
    timingStatus: transitSteps.some(s => s.departureSource && s.departureSource !== 'scheduled' || s.arrivalSource && s.arrivalSource !== 'scheduled')
      ? 'Real-time where available; other times scheduled' : 'Scheduled — no live prediction',
    transitPaths: rides.map(ride => transitPath(feed, ride)), alerts, realtime: realtime?.status || null,
  };
}

function createGtfsProvider(runtime, client, { horizonHours = 6, maxTransfers = 2, matrixBudget = 3000, batchSize = 50 } = {}) {
  return {
    async findTransitRoutes(input, origin, destination, signal, warnings) {
      const { feed, realtime, warnings: sourceWarnings = [] } = await runtime.snapshot();
      warnings.push(...sourceWarnings, ...feed.warnings);
      const departure = Date.parse(input.departureTime); const date = serviceDate(departure, feed.zone);
      if (feed.startDate && date < feed.startDate || feed.endDate && date > feed.endDate) {
        warnings.push(`Departure is outside the static feed coverage (${feed.startDate}–${feed.endDate}); transit results are unavailable.`);
        return [];
      }
      warnings.push(`VTA search covers ${horizonHours} hours and up to ${maxTransfers} transfers. Times without predictions are scheduled, not confirmed on time.`);
      let used = 0; let failures = 0; let limited = false;
      const failureReasons = new Map();
      function failed(reason, count = 1) { failures += count; failureReasons.set(reason, (failureReasons.get(reason) || 0) + count); }
      const range = input.bikeSpeedMph * input.maxBikeMinutes / 60 * 1609.344;
      const stops = [...feed.servedStops].map(id => feed.stops.get(id)).filter(s => meters(origin, s) <= range)
        .sort((a, b) => meters(origin, a) - meters(origin, b));
      const access = [];
      async function matrix(batch, egress) {
        used += batch.length;
        try {
          const elements = await (egress ? client.computeBikeEgressMatrix(batch, destination, { signal })
            : client.computeBikeMatrix(origin, batch, { signal }));
          signal.throwIfAborted();
          return batch.map((stop, index) => {
            const matches = elements.filter(e => (e[egress ? 'originIndex' : 'destinationIndex'] ?? 0) === index
              && (e[egress ? 'destinationIndex' : 'originIndex'] ?? 0) === 0);
            const element = matches.length === 1 ? matches[0] : null;
            const ride = readMatrixRide(element, input.bikeSpeedMph);
            if (!ride && (element?.condition !== 'ROUTE_NOT_FOUND' || element?.status?.code)) {
              failed(!element ? 'missing or duplicate rows' : element.status?.code
                ? `upstream status ${Number(element.status.code)}` : 'invalid distance/duration');
            }
            return ride;
          });
        } catch (error) { signal.throwIfAborted(); failed(error.code === 'UPSTREAM_TIMEOUT' ? 'request deadlines' : 'failed requests', batch.length); return batch.map(() => null); }
      }
      for (let i = 0; i < stops.length;) {
        signal.throwIfAborted();
        const batch = stops.slice(i, i + Math.min(batchSize, matrixBudget - used));
        if (!batch.length) { limited = true; break; }
        const rides = await matrix(batch, false);
        rides.forEach((ride, index) => { if (ride && ride.minutes <= input.maxBikeMinutes) access.push({ ...ride, stopId: batch[index].id }); });
        i += batch.length;
      }
      const scan = scanJourneys(feed, access, departure, { horizonHours, maxTransfers, transform: realtime?.transform, signal });
      const ordered = scan.candidates.map(state => ({ ...state,
        lowerBound: state.time + meters(feed.stops.get(state.stopId), destination) / 1609.344 / input.bikeSpeedMph * 3600_000,
      })).sort((a, b) => a.lowerBound - b.lowerBound);
      const cache = new Map(); let best = [];
      for (let i = 0; i < ordered.length; i += 1) {
        signal.throwIfAborted(); const state = ordered[i];
        if (best.length === 3 && state.lowerBound > best[2].finalArrival) break;
        if (!cache.has(state.stopId)) {
          const ids = [];
          for (let j = i; j < ordered.length && ids.length < Math.min(batchSize, matrixBudget - used); j += 1) {
            if (best.length === 3 && ordered[j].lowerBound > best[2].finalArrival) break;
            const id = ordered[j].stopId;
            if (!cache.has(id) && !ids.includes(id)) ids.push(id);
          }
          if (!ids.length) { limited = true; break; }
          const rides = await matrix(ids.map(id => feed.stops.get(id)), true);
          ids.forEach((id, index) => cache.set(id, rides[index]));
        }
        const egress = cache.get(state.stopId);
        if (egress) best = bestDistinct([...best, { ...state, egress, finalArrival: state.time + egress.minutes * 60000 }]);
      }
      if (failures) warnings.push(`${failures} bicycle matrix elements unavailable (${[...failureReasons].map(([reason,count]) => `${reason}: ${count}`).join(', ')}); transit coverage is incomplete.`);
      if (limited) warnings.push(`Bicycle matrix budget (${matrixBudget} elements) reached; results are incomplete, not guaranteed optimal.`);
      return best.map(state => ({ ...routeResult(feed, state, departure, realtime),
        coverage: { ...scan.coverage, incomplete: limited || failures > 0 || feed.stats.excludedTrips > 0, matrixElements: used } }));
    },
  };
}
module.exports = { createGtfsProvider, routeResult, bestDistinct };
