const origin = { lat: 37, lng: -122, formattedAddress: 'Origin' };
const destination = { lat: 37.05, lng: -122, formattedAddress: 'Destination' };
const alight = { lat: 37.04, lng: -122 };
const input = { origin: 'Origin', destination: 'Destination', departureTime: '2026-10-12T18:38:00Z', bikeSpeedMph: 8, maxBikeMinutes: 30 };
const location = point => ({ latLng: { latitude: point.lat, longitude: point.lng } });

function transitStep(stop, { trip = '22-1', departure = '2026-10-12T18:48:00Z', arrival = '2026-10-12T19:08:00Z' } = {}) {
  return { travelMode: 'TRANSIT', staticDuration: '1200s', transitDetails: {
    tripShortText: trip, headsign: 'Downtown', transitLine: { nameShort: '22', agencies: [{ name: 'Test Transit' }] },
    stopDetails: { departureStop: { name: stop.name, location: location(stop) }, departureTime: departure,
      arrivalStop: { name: 'Final stop', location: location(alight) }, arrivalTime: arrival },
  } };
}

function fixtureClient({ count = 1 } = {}) {
  const calls = [];
  const stops = Array.from({ length: count }, (_, i) => ({ name: `Stop ${i}`, lat: 37.001 + i / 1000, lng: -122 }));
  const client = {
    async geocodeAddress(address, options) {
      calls.push({ method: 'geocode', options });
      return address === input.origin ? origin : destination;
    },
    async findNearbyTransitStops(point, radius, rank, options) {
      calls.push({ method: 'nearby', point, radius, rank, options });
      return stops;
    },
    async computeBikeMatrix(point, candidates, options) {
      calls.push({ method: 'matrix', candidates, options });
      return candidates.map((stop, destinationIndex) => ({ destinationIndex, originIndex: 0,
        status: {}, condition: 'ROUTE_EXISTS', distanceMeters: 1609.344, duration: '450s' }));
    },
    async computeRoutes(from, to, options) {
      calls.push({ method: 'routes', from, to, options });
      if (options.mode === 'bicycle') return [{ distanceMeters: 1609.344, polyline: { encodedPolyline: 'geometry' } }];
      return [{ duration: '1800s', legs: [{ steps: [transitStep(from, { trip: `22-${from.lat}` })] }],
        polyline: { encodedPolyline: 'transit-geometry' } }];
    },
  };
  return { client, calls, stops };
}

module.exports = { fixtureClient, input, origin, destination, alight, transitStep };
