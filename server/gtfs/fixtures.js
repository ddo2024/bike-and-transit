const { buildFeed } = require('./static');
function fixture({ trips, transfers = [], calendarDates = [], frequencies = [] } = {}) {
  trips ||= [{ id: 'T1', route: '22', stops: [['A', '11:50:00'], ['B', '12:00:00']] }];
  const ids = [...new Set(trips.flatMap(t => t.stops.map(s => s[0])))];
  return buildFeed({
    agency: [{ agency_id: 'VTA', agency_timezone: 'America/Los_Angeles' }],
    stops: ids.map((id, i) => ({ stop_id: id, stop_name: id, stop_lat: '37.3', stop_lon: String(-121.9 + i * .02) })),
    routes: [...new Set(trips.map(t => t.route || '22'))].map(id => ({ route_id: id, route_short_name: id, route_type: '3' })),
    trips: trips.map(t => ({ trip_id: t.id, route_id: t.route || '22', service_id: t.service || 'weekday', bikes_allowed: t.bikes || '1' })),
    stop_times: trips.flatMap(t => t.stops.map(([id, time, extra], i) => ({ trip_id: t.id, stop_id: id,
      stop_sequence: String(i + 1), arrival_time: time, departure_time: time, ...extra }))),
    calendar: [{ service_id: 'weekday', start_date: '20260101', end_date: '20261231', monday: '1', tuesday: '1',
      wednesday: '1', thursday: '1', friday: '1', saturday: '0', sunday: '0' }],
    calendar_dates: calendarDates, transfers, frequencies,
  }, { source: '511', hash: 'fixture' });
}
module.exports = { fixture };
