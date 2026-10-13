const formatters = new Map();
function partsAt(epoch, zone) {
  if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }));
  return Object.fromEntries(formatters.get(zone).formatToParts(new Date(epoch)).map(p => [p.type, p.value]));
}
function serviceDate(epoch, zone) {
  const p = partsAt(epoch, zone);
  return `${p.year}${p.month}${p.day}`;
}
function addDays(date, count) {
  const epoch = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8) + count);
  return new Date(epoch).toISOString().slice(0, 10).replaceAll('-', '');
}
function serviceEpoch(date, zone) {
  // GTFS defines service time as local noon minus twelve elapsed hours.
  // This deliberately differs from local midnight on DST transition days.
  const noon = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), 12);
  let guess = noon;
  for (let i = 0; i < 3; i += 1) {
    const p = partsAt(guess, zone);
    guess += noon - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  }
  return guess - 12 * 3600_000;
}
function gtfsSeconds(value) {
  const match = typeof value === 'string' && value.match(/^(\d{1,3}):([0-5]\d):([0-5]\d)$/);
  if (!match) return NaN;
  return +match[1] * 3600 + +match[2] * 60 + +match[3];
}
function meters(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
module.exports = { serviceDate, serviceEpoch, addDays, gtfsSeconds, meters };
