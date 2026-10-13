const bindings = require('gtfs-realtime-bindings');
const { gtfsSeconds } = require('./time');
const own = (o, k) => o != null && Object.hasOwn(o, k);
const num = value => Number(value);
function decode(buffer) {
  const message = bindings.transit_realtime.FeedMessage.decode(buffer);
  return bindings.transit_realtime.FeedMessage.toObject(message, { longs: Number, enums: String, defaults: false });
}
function validateSnapshot(message, previous, now = Date.now()) {
  const timestamp = num(message.header?.timestamp) * 1000;
  if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > now + 60000) throw new Error('Invalid feed timestamp');
  if (previous && timestamp < previous.timestamp) throw new Error('Out-of-order feed');
  if (message.header?.incrementality === 'DIFFERENTIAL' || message.header?.incrementality === 1) throw new Error('Differential snapshots are unsupported');
  return { message, timestamp, receivedAt: now };
}
function stopIndex(trip, update) {
  if (own(update, 'stopSequence')) {
    const i = trip.times.findIndex(p => p.sequence === num(update.stopSequence));
    return i >= 0 && (!update.stopId || update.stopId === trip.times[i].stopId) ? i : -1;
  }
  const indices = trip.times.flatMap((p,i) => p.stopId === update.stopId ? [i] : []);
  return indices.length === 1 ? indices[0] : -1;
}
function checkUpdate(feed, update) {
  const descriptor = update.trip || {}; const trip = feed.trips.get(descriptor.tripId);
  if (!trip || descriptor.routeId && descriptor.routeId !== trip.route_id
    || own(descriptor, 'directionId') && String(descriptor.directionId) !== trip.direction_id) return false;
  let previous = -1;
  for (const point of update.stopTimeUpdate || []) {
    const index = stopIndex(trip, point);
    if (index <= previous) return false;
    previous = index;
  }
  return true;
}
function compatibility(feed, snapshot) {
  let matchedTrips = 0; let matchedStops = 0; let rejectedTrips = 0; const samples = [];
  for (const entity of snapshot?.message.entity || []) {
    if (!entity.tripUpdate || entity.isDeleted) continue;
    const update = entity.tripUpdate;
    if (!checkUpdate(feed, update)) { rejectedTrips += 1; continue; }
    matchedTrips += 1;
    for (const point of update.stopTimeUpdate || []) if (point.stopId) {
      matchedStops += 1;
      if (samples.length < 5) samples.push({ tripId: update.trip.tripId, stopId: point.stopId, stopSequence: point.stopSequence });
    }
  }
  return { verified: feed.source === '511' && matchedTrips > 0 && matchedStops > 0,
    staticHash: feed.hash, matchedTrips, matchedStops, rejectedTrips, samples };
}
function fresh(snapshot, now, maxAge) { return !!snapshot && now - snapshot.timestamp <= maxAge && snapshot.timestamp <= now + 60000; }
function relation(value, numeric, name) { return value === numeric || value === name; }
function updateInstance(instance, update) {
  const descriptor = update.trip;
  if (!/^\d{8}$/.test(descriptor.startDate || '') || descriptor.startDate !== instance.date) return instance;
  if (instance.trip.frequencies.length && !descriptor.startTime) return instance;
  if (descriptor.startTime && gtfsSeconds(descriptor.startTime) !== instance.trip.times[0].departure + instance.offset) return instance;
  const rel = descriptor.scheduleRelationship;
  if (relation(rel, 3, 'CANCELED') || relation(rel, 7, 'DELETED')) return null;
  if (rel != null && !relation(rel, 0, 'SCHEDULED')) return instance;
  const updates = new Map((update.stopTimeUpdate || []).map(p => [stopIndex(instance.trip, p), p]));
  let delay = own(update, 'delay') && Number.isFinite(update.delay) ? update.delay : null;
  const times = instance.times.map((point, i) => {
    const result = { ...point }; const change = updates.get(i);
    if (relation(change?.scheduleRelationship, 2, 'NO_DATA')) { delay = null; return result; }
    if (relation(change?.scheduleRelationship, 1, 'SKIPPED')) result.skipped = true;
    for (const field of ['arrival', 'departure']) {
      const scheduled = point[field === 'arrival' ? 'scheduledArrival' : 'scheduledDeparture'];
      const event = change?.[field];
      let predicted = null;
      if (own(event, 'time') && Number.isFinite(num(event.time))) predicted = num(event.time) * 1000;
      else if (own(event, 'delay') && Number.isFinite(event.delay)) predicted = scheduled + event.delay * 1000;
      if (predicted != null) {
        result[field] = predicted; result[`${field}Source`] = 'predicted'; delay = (predicted - scheduled) / 1000;
      } else if (delay != null) {
        result[field] = scheduled + delay * 1000; result[`${field}Source`] = 'predicted (propagated delay)';
      }
    }
    // Departure-only predictions are valid. The bus must have arrived by its
    // predicted departure; do not discard an early bus because arrival is absent.
    if (!change?.arrival && result.departure < result.arrival && result.departureSource !== 'scheduled') {
      result.arrival = result.departure; result.arrivalSource = 'predicted (departure bound)';
    }
    return result;
  });
  // Never repair contradictory predictions by silently manufacturing later times.
  if (times.some((p,i) => p.departure < p.arrival || i > 0 && p.arrival < times[i-1].departure)) return instance;
  return { ...instance, times };
}
function translated(value) {
  const texts = value?.translation || [];
  return (texts.find(t => /^en(?:-|$)/.test(t.language || '')) || texts[0])?.text || '';
}
function active(alert, start, end = start) {
  return !alert.activePeriod?.length || alert.activePeriod.some(p => (!own(p, 'start') || num(p.start) * 1000 <= end)
    && (!own(p, 'end') || num(p.end) * 1000 > start));
}
function matches(selector, instance, feed, stopId) {
  return (!selector.agencyId || selector.agencyId === instance.route.agency_id || feed.agency.some(a => a.agency_id === selector.agencyId))
    && (!selector.routeId || selector.routeId === instance.trip.route_id)
    && (!own(selector, 'routeType') || String(selector.routeType) === instance.route.route_type)
    && (!own(selector, 'directionId') || String(selector.directionId) === instance.trip.direction_id)
    && (!selector.trip || (!selector.trip.tripId || selector.trip.tripId === instance.trip.trip_id)
      && (!selector.trip.startDate || selector.trip.startDate === instance.date)
      && (!selector.trip.startTime || gtfsSeconds(selector.trip.startTime) === instance.trip.times[0].departure + instance.offset))
    && (!selector.stopId || selector.stopId === stopId);
}
function realtimeView(feed, updates, alerts, { now = Date.now(), tripMaxAgeMs = 300000, alertMaxAgeMs = 900000, compatibilityEvidence } = {}) {
  let report = compatibility(feed, updates);
  if (feed.source === '511' && compatibilityEvidence?.verified && compatibilityEvidence.staticHash === feed.hash) {
    report = { ...report, verified: true, samples: compatibilityEvidence.samples };
  }
  const updatesFresh = fresh(updates, now, tripMaxAgeMs);
  const alertsFresh = fresh(alerts, now, alertMaxAgeMs);
  const byTrip = new Map(); let ignored = 0;
  if (report.verified && updatesFresh) for (const entity of updates.message.entity || []) {
    const update = entity.tripUpdate;
    if (!update || entity.isDeleted) continue;
    const rel = update.trip?.scheduleRelationship;
    if (!checkUpdate(feed, update) || !/^\d{8}$/.test(update.trip?.startDate || '')
      || rel != null && ![0,3,7,'SCHEDULED','CANCELED','DELETED'].includes(rel)
      || own(update, 'timestamp') && (now - num(update.timestamp) * 1000 > tripMaxAgeMs || num(update.timestamp) * 1000 > now + 60000)) { ignored += 1; continue; }
    const key = `${update.trip.tripId}:${update.trip.startDate}:${update.trip.startTime || ''}`;
    if (byTrip.has(key)) { byTrip.set(key, null); ignored += 1; } else byTrip.set(key, update);
  }
  const relevantAlerts = report.verified && alertsFresh ? (alerts.message.entity || []).filter(e => e.alert && !e.isDeleted) : [];
  const status = { compatibility: report, tripFeedTimestamp: updates?.timestamp || null,
    alertFeedTimestamp: alerts?.timestamp || null, updatesFresh, alertsFresh, ignoredUpdates: ignored,
    message: !report.verified ? '511 identifier compatibility is unverified; real-time data is not applied.'
      : !updatesFresh ? 'Trip Updates are missing or stale; using scheduled times, not confirmation of on-time service.'
        : `511 Trip Updates available; missing predictions use scheduled times.${ignored ? ` ${ignored} unmatched, ambiguous, unsupported, or stale updates ignored.` : ''}` };
  if (!alertsFresh) status.message += ' Service Alerts are missing or stale; disruptions may be unreported.';
  return {
    status,
    transform: byTrip.size || relevantAlerts.length ? instance => {
      const startSeconds = instance.trip.times[0].departure + instance.offset;
      const startTime = `${String(Math.floor(startSeconds/3600)).padStart(2,'0')}:${String(Math.floor(startSeconds/60)%60).padStart(2,'0')}:${String(startSeconds%60).padStart(2,'0')}`;
      const update = byTrip.get(`${instance.trip.trip_id}:${instance.date}:${startTime}`)
        || byTrip.get(`${instance.trip.trip_id}:${instance.date}:`);
      let result = update ? updateInstance(instance, update) : instance;
      if (!result) return null;
      for (const { alert } of relevantAlerts) {
        if (!relation(alert.effect, 1, 'NO_SERVICE')) continue;
        for (const selector of alert.informedEntity || []) {
          if (!selector.stopId && matches(selector, result, feed)
              && active(alert, result.times[0].departure, result.times.at(-1).arrival)) return null;
          if (selector.stopId) result = { ...result, times: result.times.map(point => matches(selector, result, feed, point.stopId)
            && active(alert, point.arrival, point.departure) ? { ...point, skipped: true } : point) };
        }
      }
      return result;
    } : undefined,
    alertsFor(rides) {
      return relevantAlerts.filter(({ alert }) => rides.some(({ instance, from, to }) => active(alert, instance.times[from].departure, instance.times[to].arrival)
        && (alert.informedEntity || []).some(selector => instance.times.slice(from, to + 1).some(p => matches(selector, instance, feed, p.stopId)))))
        .map(({ id, alert }) => ({ id, header: translated(alert.headerText), description: translated(alert.descriptionText), effect: alert.effect }));
    },
  };
}
module.exports = { decode, validateSnapshot, compatibility, realtimeView, updateInstance, checkUpdate };
