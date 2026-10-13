const { unzipSync, strFromU8 } = require('fflate');
const { parse } = require('csv-parse/sync');
const { createHash } = require('node:crypto');
const { gtfsSeconds, serviceEpoch, addDays, serviceDate, meters } = require('./time');

const FILES = ['agency', 'feed_info', 'stops', 'routes', 'trips', 'stop_times', 'calendar', 'calendar_dates', 'transfers', 'frequencies', 'shapes'];
function loadGtfsZip(buffer, metadata = {}) {
  const zip = unzipSync(new Uint8Array(buffer), { filter: file => {
    if (file.originalSize > 150_000_000) throw new Error('GTFS entry exceeds size limit.');
    return FILES.some(name => file.name === `${name}.txt`);
  } });
  const tables = {};
  for (const name of FILES) {
    tables[name] = zip[`${name}.txt`] ? parse(strFromU8(zip[`${name}.txt`]), {
      columns: true, bom: true, skip_empty_lines: true, trim: true,
    }) : [];
    delete zip[`${name}.txt`];
  }
  return buildFeed(tables, { ...metadata, hash: createHash('sha256').update(buffer).digest('hex') });
}

function buildFeed(tables, metadata = {}) {
  for (const name of ['agency', 'stops', 'routes', 'trips', 'stop_times']) {
    if (!tables[name]?.length) throw new Error(`GTFS is missing ${name}.txt data.`);
  }
  if (!tables.calendar?.length && !tables.calendar_dates?.length) throw new Error('GTFS has no service calendar.');
  const zones = new Set(tables.agency.map(row => row.agency_timezone));
  if (zones.size !== 1 || ![...zones][0]) throw new Error('This planner requires one agency timezone per feed.');
  const zone = [...zones][0];
  serviceDate(Date.now(), zone); // Validate the IANA timezone before publishing.
  const warnings = [];
  function unique(rows, field) {
    const map = new Map();
    for (const row of rows) {
      if (!row[field] || map.has(row[field])) throw new Error(`Duplicate or missing ${field}.`);
      map.set(row[field], row);
    }
    return map;
  }
  const stops = unique(tables.stops.map(row => ({ ...row, id: row.stop_id, name: row.stop_name,
    lat: Number(row.stop_lat), lng: Number(row.stop_lon) })), 'stop_id');
  for (const stop of stops.values()) {
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lng) || Math.abs(stop.lat) > 90 || Math.abs(stop.lng) > 180) throw new Error('GTFS has invalid stop coordinates.');
  }
  const routes = unique(tables.routes, 'route_id');
  const trips = unique(tables.trips.map(row => ({ ...row, times: [] })), 'trip_id');
  let excludedTrips = 0;
  for (const row of tables.stop_times) {
    const trip = trips.get(row.trip_id);
    if (!trip || !stops.has(row.stop_id)) throw new Error('GTFS stop_times references an unknown trip or stop.');
    trip.times.push({ stopId: row.stop_id, sequence: Number(row.stop_sequence),
      arrival: gtfsSeconds(row.arrival_time), departure: gtfsSeconds(row.departure_time),
      pickup: row.pickup_type || '0', dropoff: row.drop_off_type || '0',
      timepoint: row.timepoint, shapeDistance: row.shape_dist_traveled === '' || row.shape_dist_traveled == null ? null : Number(row.shape_dist_traveled) });
  }
  let maxTime = 86400;
  const servedStops = new Set();
  const frequencyRows = new Map();
  for (const row of tables.frequencies || []) {
    if (!frequencyRows.has(row.trip_id)) frequencyRows.set(row.trip_id, []);
    frequencyRows.get(row.trip_id).push(row);
  }
  for (const [id, trip] of trips) {
    if (!routes.has(trip.route_id)) throw new Error('GTFS trip references an unknown route.');
    trip.times.sort((a, b) => a.sequence - b.sequence);
    // Interpolate only non-timepoint intermediate stops bounded by known times.
    for (let i = 0; i < trip.times.length; i += 1) {
      const point = trip.times[i];
      if (!Number.isFinite(point.arrival) && Number.isFinite(point.departure)) point.arrival = point.departure;
      if (!Number.isFinite(point.departure) && Number.isFinite(point.arrival)) point.departure = point.arrival;
      if (Number.isFinite(point.arrival)) continue;
      let end = i + 1;
      while (end < trip.times.length && !Number.isFinite(trip.times[end].arrival)) end += 1;
      if (i === 0 || end === trip.times.length || trip.times.slice(i, end).some(p => p.timepoint === '1')) break;
      const start = trip.times[i - 1];
      const finish = trip.times[end];
      for (let j = i; j < end; j += 1) {
        const fraction = (j - i + 1) / (end - i + 1);
        trip.times[j].arrival = trip.times[j].departure = start.departure + fraction * (finish.arrival - start.departure);
        trip.times[j].interpolated = true;
      }
      i = end - 1;
    }
    const valid = trip.times.length >= 2 && trip.times.every((point, i, all) => Number.isFinite(point.arrival)
      && Number.isFinite(point.departure) && point.departure >= point.arrival && Number.isInteger(point.sequence)
      && (i === 0 || (point.sequence > all[i - 1].sequence && point.arrival >= all[i - 1].departure)));
    if (!valid) { trips.delete(id); excludedTrips += 1; continue; }
    trip.frequencies = frequencyRows.get(id) || [];
    if (trip.frequencies.some(row => row.exact_times !== '1')) {
      // A headway service has no exact catchable departure. Do not invent one.
      trips.delete(id); excludedTrips += 1; continue;
    }
    for (const row of trip.frequencies) {
      if (!Number.isFinite(gtfsSeconds(row.start_time)) || !(gtfsSeconds(row.end_time) > gtfsSeconds(row.start_time)) || !(Number(row.headway_secs) >= 1)) throw new Error('Invalid frequency interval.');
      maxTime = Math.max(maxTime, gtfsSeconds(row.end_time) + trip.times.at(-1).arrival - trip.times[0].departure);
    }
    for (const point of trip.times) { servedStops.add(point.stopId); maxTime = Math.max(maxTime, point.departure); }
  }
  if (!trips.size) throw new Error('GTFS contains no valid scheduled trips.');
  if (excludedTrips) warnings.push(`${excludedTrips} malformed or non-exact frequency trips excluded; coverage is incomplete.`);
  const calendars = new Map((tables.calendar || []).map(row => [row.service_id, row]));
  const exceptions = new Map();
  for (const row of tables.calendar_dates || []) {
    if (!exceptions.has(row.date)) exceptions.set(row.date, new Map());
    exceptions.get(row.date).set(row.service_id, row.exception_type);
  }
  const activeCache = new Map();
  function activeServices(date) {
    if (activeCache.has(date)) return activeCache.get(date);
    const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T12:00:00Z`).getUTCDay()];
    const active = new Set();
    for (const row of calendars.values()) if (row.start_date <= date && date <= row.end_date && row[weekday] === '1') active.add(row.service_id);
    for (const [id, type] of exceptions.get(date) || []) {
      if (type === '1') active.add(id);
      if (type === '2') active.delete(id);
    }
    if (activeCache.size > 32) activeCache.delete(activeCache.keys().next().value);
    activeCache.set(date, active);
    return active;
  }
  const transferRules = tables.transfers || [];
  const footpaths = new Map([...stops.keys()].map(id => [id, []]));
  function addPath(from, to, seconds, estimated = false) {
    if (from === to || !stops.has(from) || !stops.has(to)) return;
    const old = footpaths.get(from).find(path => path.to === to);
    if (!old) footpaths.get(from).push({ from, to, seconds, estimated });
    else if (seconds < old.seconds) { old.seconds = seconds; old.estimated = estimated; }
  }
  // Nearby platform access uses the existing 75m tolerance, not a new parking buffer.
  // A spatial grid avoids an all-stops squared comparison.
  const grid = new Map();
  for (const id of servedStops) {
    const stop = stops.get(id); const x = Math.floor(stop.lat / 0.001); const y = Math.floor(stop.lng / 0.001);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -2; dy <= 2; dy += 1) {
      for (const other of grid.get(`${x + dx},${y + dy}`) || []) {
        const distance = meters(stop, other);
        if (distance <= 75) {
          const seconds = Math.ceil(distance / 1.2);
          addPath(stop.id, other.id, seconds, true); addPath(other.id, stop.id, seconds, true);
        }
      }
    }
    const key = `${x},${y}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(stop);
  }
  for (const rule of transferRules) {
    if (rule.transfer_type === '3') continue;
    const a = stops.get(rule.from_stop_id); const b = stops.get(rule.to_stop_id);
    if (a && b) addPath(a.id, b.id, Math.max(Number(rule.min_transfer_time) || 0, Math.ceil(meters(a, b) / 1.2)), true);
  }
  const shapes = new Map();
  for (const row of tables.shapes || []) {
    if (!shapes.has(row.shape_id)) shapes.set(row.shape_id, []);
    shapes.get(row.shape_id).push({ lat: Number(row.shape_pt_lat), lng: Number(row.shape_pt_lon),
      sequence: Number(row.shape_pt_sequence), distance: row.shape_dist_traveled === '' || row.shape_dist_traveled == null ? null : Number(row.shape_dist_traveled) });
  }
  for (const points of shapes.values()) points.sort((a, b) => a.sequence - b.sequence);
  const info = tables.feed_info?.[0] || {};
  return { ...metadata, zone, stops, routes, trips, agency: tables.agency, servedStops,
    activeServices, footpaths, transferRules, shapes, maxTime, warnings,
    startDate: info.feed_start_date || null, endDate: info.feed_end_date || null, version: info.feed_version || metadata.hash,
    stats: { stops: stops.size, trips: trips.size, stopTimes: [...trips.values()].reduce((n, t) => n + t.times.length, 0), excludedTrips } };
}

function tripInstances(feed, departureMs, horizonMs, transform) {
  const instances = [];
  const firstDate = serviceDate(departureMs, feed.zone);
  const lastDate = serviceDate(horizonMs, feed.zone);
  for (let date = addDays(firstDate, -Math.ceil(feed.maxTime / 86400)); date <= lastDate; date = addDays(date, 1)) {
    const active = feed.activeServices(date);
    const epoch = serviceEpoch(date, feed.zone);
    for (const trip of feed.trips.values()) {
      if (!active.has(trip.service_id) || trip.bikes_allowed === '2') continue;
      const offsets = trip.frequencies.length ? trip.frequencies.flatMap(row => {
        const result = [];
        for (let t = gtfsSeconds(row.start_time); t < gtfsSeconds(row.end_time); t += Number(row.headway_secs)) result.push(t - trip.times[0].departure);
        return result;
      }) : [0];
      for (const offset of offsets) {
        // Static searches avoid allocating stop-time objects for irrelevant trips.
        // Real-time transforms must run before filtering: a delay can move a trip into range.
        if (!transform && (epoch + (trip.times.at(-1).arrival + offset) * 1000 < departureMs
          || epoch + (trip.times[0].departure + offset) * 1000 > horizonMs)) continue;
        const instance = { key: `${date}:${trip.trip_id}:${offset}`, date, trip, route: feed.routes.get(trip.route_id), offset,
          times: trip.times.map(point => ({ ...point, scheduledArrival: epoch + (point.arrival + offset) * 1000,
            scheduledDeparture: epoch + (point.departure + offset) * 1000, arrival: epoch + (point.arrival + offset) * 1000,
            departure: epoch + (point.departure + offset) * 1000, arrivalSource: 'scheduled', departureSource: 'scheduled' })) };
        const updated = transform ? transform(instance) : instance;
        if (updated && updated.times.at(-1).arrival >= departureMs && updated.times[0].departure <= horizonMs) instances.push(updated);
      }
    }
  }
  return instances;
}

module.exports = { loadGtfsZip, buildFeed, tripInstances };
