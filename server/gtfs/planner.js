const { tripInstances } = require('./static');

function signature(state) { return state.tripKeys.join('|'); }
function preference(a, b) { return a.time - b.time || a.access.minutes - b.access.minutes || a.segments.length - b.segments.length; }
function insert(bucket, state, limit = 3) {
  const key = signature(state);
  const same = bucket.findIndex(item => signature(item) === key);
  if (same >= 0 && preference(bucket[same], state) <= 0) return false;
  if (same >= 0) bucket.splice(same, 1);
  bucket.push(state); bucket.sort(preference);
  if (bucket.length > limit) bucket.length = limit;
  return bucket.includes(state);
}
function lastRide(state) { return state.segments.findLast(segment => segment.mode === 'TRANSIT'); }
function transferAllowed(feed, state, instance, stopId, departure) {
  const last = lastRide(state);
  if (!last) return true;
  const originStop = last.instance.times[last.to].stopId;
  const rules = feed.transferRules.filter(rule => rule.from_stop_id === originStop && rule.to_stop_id === stopId
    && (!rule.from_trip_id || rule.from_trip_id === last.instance.trip.trip_id)
    && (!rule.to_trip_id || rule.to_trip_id === instance.trip.trip_id)
    && (!rule.from_route_id || rule.from_route_id === last.instance.trip.route_id)
    && (!rule.to_route_id || rule.to_route_id === instance.trip.route_id));
  const specificity = row => ['from_trip_id', 'to_trip_id', 'from_route_id', 'to_route_id'].filter(key => row[key]).length;
  const most = rules.length ? Math.max(...rules.map(specificity)) : 0;
  for (const rule of rules.filter(row => specificity(row) === most)) {
    if (rule.transfer_type === '3') return false;
    if (departure < last.instance.times[last.to].arrival + (Number(rule.min_transfer_time) || 0) * 1000) return false;
  }
  return true;
}

function scanJourneys(feed, accessRides, departureMs, {
  horizonHours = 6, maxTransfers = 2, transform, signal,
} = {}) {
  const horizon = departureMs + horizonHours * 3600_000;
  const instances = tripInstances(feed, departureMs, horizon, transform);
  const connections = [];
  for (const instance of instances) for (let i = 0; i < instance.times.length - 1; i += 1) {
    const from = instance.times[i]; const to = instance.times[i + 1];
    if (from.departure >= departureMs && from.departure <= horizon && to.arrival <= horizon) connections.push({ instance, index: i, from, to });
  }
  connections.sort((a, b) => a.from.departure - b.from.departure || a.index - b.index || a.instance.key.localeCompare(b.instance.key));
  const candidates = [];
  let previous = new Map();
  function storeLabel(labels, stopId, state, walk = true) {
    if (state.time > horizon) return;
    if (!labels.has(stopId)) labels.set(stopId, new Map());
    // Transfer permissions depend on the previous trip and its alighting stop.
    const ride = lastRide(state);
    const context = ride && feed.transferRules.length ? `${ride.instance.key}|${ride.instance.times[ride.to].stopId}` : 'unrestricted';
    const contexts = labels.get(stopId);
    if (!contexts.has(context)) contexts.set(context, []);
    if (!insert(contexts.get(context), state)) return;
    if (!walk) return;
    // One physical transfer edge only: avoid inventing long walks by chaining
    // nearby stops. Same-stop transfers require no added parking buffer.
    for (const edge of feed.footpaths.get(stopId) || []) {
      storeLabel(labels, edge.to, { ...state, time: state.time + edge.seconds * 1000,
        segments: [...state.segments, { mode: 'WALK', fromStop: stopId, toStop: edge.to, departure: state.time,
          arrival: state.time + edge.seconds * 1000, estimated: edge.estimated }] }, false);
    }
  }
  for (const ride of accessRides) {
    if (!feed.stops.has(ride.stopId)) continue;
    storeLabel(previous, ride.stopId, { time: departureMs + ride.minutes * 60000, access: ride, segments: [], tripKeys: [] }, false);
  }
  for (let round = 0; round <= maxTransfers; round += 1) {
    signal?.throwIfAborted();
    const current = new Map(); const onboard = new Map();
    for (const connection of connections) {
      const { instance, index, from, to } = connection;
      const riders = (onboard.get(instance.key) || []).map(state => ({ ...state, time: from.departure }));
      if (from.pickup === '0' && !from.skipped) {
        for (const bucket of previous.get(from.stopId)?.values() || []) for (const state of bucket) {
          if (state.time > from.departure || state.tripKeys.includes(instance.key)
              || !transferAllowed(feed, state, instance, from.stopId, from.departure)) continue;
          insert(riders, { ...state, time: from.departure, tripKeys: [...state.tripKeys, instance.key],
            segments: [...state.segments, { mode: 'TRANSIT', instance, from: index, to: index }] });
        }
      }
      if (!riders.length) continue;
      const advanced = riders.map(state => ({ ...state, time: to.arrival,
        segments: [...state.segments.slice(0, -1), { ...state.segments.at(-1), to: index + 1 }] }));
      onboard.set(instance.key, advanced);
      if (to.dropoff !== '0' || to.skipped) continue;
      for (const state of advanced) storeLabel(current, to.stopId, state);
    }
    // Egress starts at an actual transit alighting stop, not at a synthetic
    // walked-to stop. Walking remains available for transfers in the next round.
    for (const [stopId, contexts] of current) for (const bucket of contexts.values()) {
      for (const state of bucket) if (state.segments.at(-1)?.mode === 'TRANSIT') candidates.push({ ...state, stopId });
    }
    previous = current;
    if (!current.size) break;
  }
  return { candidates, stats: { instances: instances.length, connections: connections.length, candidates: candidates.length },
    coverage: { horizonHours, maxTransfers, excludedTrips: feed.stats.excludedTrips } };
}

module.exports = { scanJourneys, transferAllowed, signature };
