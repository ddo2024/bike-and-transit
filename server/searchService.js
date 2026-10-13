const {
  rankRoutes, dedupeRoutes, isCandidateEligible, createCorridorSearchPoints,
  selectCandidateStops, isBoardingStopValid, createDirectBikeOption,
  createTransitItinerarySignature,
} = require('./routePlanner');
const {
  parseDurationSeconds, getFirstTransitStop, getLastTransitStop, summarizeTransitRoute, getTransitDestinationArrival,
} = require('./transitSummary');

const SEARCH_TIMEOUT_MS = 90_000;

function validDistance(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function routeDistance(route) {
  // Google's protobuf JSON may omit scalar distanceMeters when it is zero.
  // A valid duration distinguishes a returned zero-distance route from {}.
  if (route?.distanceMeters === undefined && Number.isFinite(parseDurationSeconds(route?.duration))) return 0;
  return route?.distanceMeters;
}

function bikeMinutesFromDistance(distanceMeters, speed) {
  return distanceMeters / 1609.344 / speed * 60;
}

function readMatrixRide(element, speed) {
  if (!element || element.condition !== 'ROUTE_EXISTS' || element.status?.code) return null;
  const distanceMeters = routeDistance(element);
  if (!validDistance(distanceMeters)) return null;
  const duration = parseDurationSeconds(element.duration);
  if (!Number.isFinite(duration) || duration < 0) return null;
  const configured = bikeMinutesFromDistance(distanceMeters, speed);
  const minutes = configured > 0 ? configured : duration / 60;
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  return { distanceMeters, minutes };
}

function createSearchService(client, { searchTimeoutMs = SEARCH_TIMEOUT_MS, transitProvider } = {}) {
  async function findTransitRoutes(input, origin, destination, signal, warnings) {
    const departure = new Date(input.departureTime);
    const radius = Math.min(50000, Math.max(2400,
      input.bikeSpeedMph * input.maxBikeMinutes / 60 * 1609.344 * 1.25));
    const corridor = createCorridorSearchPoints(origin, destination);
    const groups = await Promise.allSettled([
      client.findNearbyTransitStops(origin, radius, 'DISTANCE', { signal }),
      client.findNearbyTransitStops(origin, radius, 'POPULARITY', { signal }),
      ...corridor.map(point => client.findNearbyTransitStops(point, radius, 'DISTANCE', { signal })),
    ]);
    signal.throwIfAborted();
    if (groups.some(group => group.status === 'rejected')) warnings.push('Some stop searches failed; transit coverage may be incomplete.');
    const [distanceStops, popularStops, ...corridorStopGroups] = groups.map(
      group => group.status === 'fulfilled' ? group.value : [],
    );
    const stops = selectCandidateStops({ distanceStops, popularStops, corridorStopGroups, maxCandidates: 12 });
    const matrix = stops.length ? await client.computeBikeMatrix(origin, stops, { signal }) : [];
    const routes = [];
    let failedCandidates = 0;
    let failedMatrixElements = 0;
    for (const [index, stop] of stops.entries()) {
      signal.throwIfAborted();
      const element = matrix.find(item => (item.destinationIndex === undefined ? 0 : item.destinationIndex) === index);
      const ride = readMatrixRide(element, input.bikeSpeedMph);
      if (!ride) {
        if (element?.condition !== 'ROUTE_NOT_FOUND' || element?.status?.code) failedMatrixElements += 1;
        continue;
      }
      const arrivalAtStop = new Date(departure.getTime() + ride.minutes * 60000);
      if (!Number.isFinite(arrivalAtStop.getTime())
          || !isCandidateEligible({ bikeMinutes: ride.minutes, arrivalAtStop }, input)) continue;
      try {
        const transitRoutes = await client.computeRoutes(stop, destination, {
          mode: 'transit', departureTime: arrivalAtStop, signal,
        });
        const transit = transitRoutes[0];
        if (!transit) continue;
        const first = getFirstTransitStop(transit);
        if (!first || !isBoardingStopValid(stop, first, arrivalAtStop, first.departureTime)) continue;
        const last = getLastTransitStop(transit);
        if (!last) continue;
        const summary = summarizeTransitRoute(transit, { readyAt: arrivalAtStop, excludeFinalWalk: true });
        const finalBikeRoutes = await client.computeRoutes(last, destination, { mode: 'bicycle', signal });
        const finalBike = finalBikeRoutes[0];
        if (!finalBike) continue;
        const finalBikeDistance = routeDistance(finalBike);
        if (!validDistance(finalBikeDistance)) throw new Error('Invalid bicycle distance');
        const finalBikeMinutes = bikeMinutesFromDistance(finalBikeDistance, input.bikeSpeedMph);
        const finalArrival = new Date(last.arrivalTime.getTime() + finalBikeMinutes * 60000);
        if (!Number.isFinite(finalArrival.getTime())) throw new Error('Invalid bicycle arrival');
        routes.push({
          stopName: stop.name, stopLat: stop.lat, stopLng: stop.lng,
          bikeDistanceMiles: Number((ride.distanceMeters / 1609.344).toFixed(2)),
          bikeMinutes: Number(ride.minutes.toFixed(1)), arrivalAtStop,
          waitMinutes: summary.waitMinutes, transitMinutes: summary.transitMinutes,
          walkingMinutes: summary.walkingMinutes, transitSteps: summary.transitSteps,
          finalBikeDistanceMiles: Number((finalBikeDistance / 1609.344).toFixed(2)),
          finalBikeMinutes: Number(finalBikeMinutes.toFixed(1)),
          finalTransitStop: last.name, boardingStop: first.name,
          boardingLat: first.lat, boardingLng: first.lng, transitDepartureTime: first.departureTime,
          finalTransitArrival: last.arrivalTime,
          transferCount: summary.transferCount, transitRoute: summary.routeName,
          transitLines: summary.transitLines,
          transitPolyline: transit.polyline?.encodedPolyline || null,
          finalBikePolyline: finalBike.polyline?.encodedPolyline || null,
          totalMinutes: Number(((finalArrival - departure) / 60000).toFixed(1)), finalArrival,
          routeSignature: createTransitItinerarySignature(transit),
        });
      } catch (error) {
        signal.throwIfAborted();
        failedCandidates += 1;
      }
    }
    if (failedCandidates) warnings.push(`${failedCandidates} transit candidate lookup(s) failed; results may be incomplete.`);
    if (failedMatrixElements) warnings.push(`${failedMatrixElements} bike access lookup(s) failed or returned invalid data; results may be incomplete.`);
    return rankRoutes(dedupeRoutes(routes)).slice(0, 3);
  }

  async function enrichGeometry(ranked, origin, signal, warnings) {
    for (const route of ranked) {
      signal.throwIfAborted();
      route.firstBikePolyline = null;
      try {
        const firstBike = await client.computeRoutes(origin, { lat: route.stopLat, lng: route.stopLng }, {
          mode: 'bicycle', signal,
        });
        route.firstBikePolyline = firstBike[0]?.polyline?.encodedPolyline || null;
        if (route.finalStopLat != null) {
          const finalBike = await client.computeRoutes({ lat: route.finalStopLat, lng: route.finalStopLng }, route.destination, { mode: 'bicycle', signal });
          route.finalBikePolyline = finalBike[0]?.polyline?.encodedPolyline || null;
        }
      } catch (error) {
        signal.throwIfAborted();
        warnings.push('Some bike map geometry is unavailable; route timing is still available.');
      }
    }
  }

  async function directBike(input, origin, destination, signal, warnings) {
    try {
      const [route] = await client.computeRoutes(origin, destination, { mode: 'bicycle', signal });
      if (!route) return { mode: 'direct-bike', unavailable: true };
      const distanceMeters = routeDistance(route);
      if (!validDistance(distanceMeters)) throw new Error('Invalid bicycle distance');
      const option = createDirectBikeOption({ ...input, distanceMeters,
        polyline: route.polyline?.encodedPolyline });
      if (!Number.isFinite(option.finalArrival.getTime())) throw new Error('Invalid bicycle arrival');
      return option;
    } catch (error) {
      signal.throwIfAborted();
      warnings.push('Direct bicycle routing is temporarily unavailable.');
      return { mode: 'direct-bike', unavailable: true };
    }
  }

  async function baseline(input, origin, destination, signal, warnings) {
    try {
      const [route] = await client.computeRoutes(origin, destination, {
        mode: 'transit', departureTime: new Date(input.departureTime), signal,
      });
      if (!route) return null;
      const departure = new Date(input.departureTime);
      const summary = summarizeTransitRoute(route, { readyAt: departure });
      // Google duration may exclude the wait before its suggested trip starts.
      // Compare absolute scheduled arrivals, just as for bike-transit routes.
      const finalArrival = getTransitDestinationArrival(route)
        || new Date(departure.getTime() + parseDurationSeconds(route.duration) * 1000);
      return { totalMinutes: (finalArrival - departure) / 60000, finalArrival, routeName: summary.routeName };
    } catch (error) {
      signal.throwIfAborted();
      warnings.push('The normal-transit comparison is temporarily unavailable.');
      return null;
    }
  }

  async function search(input, { signal: callerSignal } = {}) {
    let completedResult;
    const controller = new AbortController();
    const { signal } = controller;
    const abortFromCaller = () => controller.abort(callerSignal.reason);
    if (callerSignal?.aborted) abortFromCaller();
    else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(Object.assign(
      new Error('Route search timed out. Please try again.'), { statusCode: 504, code: 'SEARCH_TIMEOUT' },
    )), searchTimeoutMs);
    let onAbort;
    const aborted = new Promise((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    async function run() {
      signal.throwIfAborted();
      const [origin, destination] = await Promise.all([
        client.geocodeAddress(input.origin, { signal }), client.geocodeAddress(input.destination, { signal }),
      ]);
      signal.throwIfAborted();
      if (!origin || !destination) throw Object.assign(new Error('Could not find the origin or destination.'), { statusCode: 400 });
      const warnings = [];
      const [transitRoutes, direct, comparison] = await Promise.all([
        (transitProvider ? transitProvider.findTransitRoutes(input, origin, destination, signal, warnings)
          : findTransitRoutes(input, origin, destination, signal, warnings)).catch(error => {
          signal.throwIfAborted();
          warnings.push('Transit routing is temporarily unavailable; a direct bicycle option may still be available.');
          return [];
        }),
        directBike(input, origin, destination, signal, warnings),
        baseline(input, origin, destination, signal, warnings),
      ]);
      completedResult = { results: [...transitRoutes, direct], baseline: comparison, origin, destination, warnings };
      transitRoutes.forEach(route => { if (route.finalStopLat != null) route.destination = destination; });
      await enrichGeometry(transitRoutes, origin, signal, warnings);
      return { ...completedResult, warnings: [...new Set(warnings)] };
    }
    try {
      return await Promise.race([run(), aborted]);
    } catch (error) {
      if (error.code === 'SEARCH_TIMEOUT' && completedResult) {
        return { ...completedResult, warnings: [...new Set([
          ...completedResult.warnings, 'Map enrichment timed out; completed route timing is still available.',
        ])] };
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      callerSignal?.removeEventListener('abort', abortFromCaller);
      // Also cancel siblings when a required operation fails early.
      if (!signal.aborted) controller.abort();
    }
  }
  return { search };
}

module.exports = { createSearchService, readMatrixRide, SEARCH_TIMEOUT_MS };
