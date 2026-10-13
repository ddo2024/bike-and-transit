class InputError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

function positiveNumber(value, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') {
    throw new InputError(`${name} must be a positive number.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new InputError(`${name} must be a positive number.`);
  return number;
}

function parseDeparture(value) {
  // An explicit offset makes requests independent of the server's timezone.
  const match = typeof value === 'string' && value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match) throw new InputError('Departure time must include a valid date, time, and timezone offset.');
  const [, year, month, day, hour, minute, second = '0'] = match;
  const leap = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const date = new Date(value);
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1
      || Number(day) > days[Number(month) - 1] || Number(hour) > 23
      || Number(minute) > 59 || Number(second) > 59 || !Number.isFinite(date.getTime())) {
    throw new InputError('Departure time is not a valid calendar date and time.');
  }
  return date.toISOString();
}

function validateSearchRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('A JSON search request is required.');
  const addresses = {};
  for (const name of ['origin', 'destination']) {
    if (typeof body[name] !== 'string' || !body[name].trim()) throw new InputError('Origin and destination must be nonblank text.');
    addresses[name] = body[name].trim();
  }
  return {
    ...addresses,
    departureTime: parseDeparture(body.departureTime),
    bikeSpeedMph: positiveNumber(body.bikeSpeedMph, 'Bike speed', 8),
    maxBikeMinutes: Math.min(positiveNumber(body.maxBikeMinutes, 'Max bike time', 30), 60),
  };
}

module.exports = { InputError, validateSearchRequest };
