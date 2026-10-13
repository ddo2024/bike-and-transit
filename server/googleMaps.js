const { requestJson } = require('./requestJson');

function getApiKey() {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_MAPS_API_KEY is not configured.');
  }

  return apiKey;
}

async function geocodeAddress(address, options = {}) {
  const apiKey = getApiKey();
  const response = await requestJson('https://places.googleapis.com/v1/places:searchText', {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    method: 'POST',
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.types',
    },
    body: {
      textQuery: address,
      maxResultCount: 1,
    },
  });

  if (!response.places || response.places.length === 0) {
    return null;
  }

  const best = response.places[0];
  return {
    placeId: best.id,
    formattedAddress: best.formattedAddress,
    lat: best.location.latitude,
    lng: best.location.longitude,
  };
}

async function findNearbyTransitStops(origin, radiusMeters = 2000, rankPreference = 'DISTANCE', options = {}) {
  const apiKey = getApiKey();
  const response = await requestJson('https://places.googleapis.com/v1/places:searchNearby', {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    method: 'POST',
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.types',
    },
    body: {
      includedTypes: ['transit_station', 'bus_station', 'train_station', 'bus_stop'],
      maxResultCount: 20,
      rankPreference,
      locationRestriction: {
        circle: {
          center: { latitude: origin.lat, longitude: origin.lng },
          radius: radiusMeters,
        },
      },
    },
  });

  if (!response.places || !Array.isArray(response.places)) {
    return [];
  }

  return response.places.map((item) => ({
    placeId: item.id,
    name: item.displayName?.text || item.formattedAddress || 'Transit stop',
    lat: item.location.latitude,
    lng: item.location.longitude,
    types: item.types || [],
  }));
}

function toWaypoint(location) {
  return {
    location: {
      latLng: {
        latitude: location.lat,
        longitude: location.lng,
      },
    },
  };
}

function routeFieldMask() {
  return [
    'routes.duration',
    'routes.distanceMeters',
    'routes.polyline.encodedPolyline',
    'routes.legs.duration',
    'routes.legs.distanceMeters',
    'routes.legs.steps.travelMode',
    'routes.legs.steps.staticDuration',
    'routes.legs.steps.transitDetails',
    'routes.legs.steps.transitDetails.transitLine',
    'routes.legs.steps.transitDetails.tripShortText',
    'routes.legs.steps.transitDetails.transitLine.uri',
    'routes.legs.steps.transitDetails.transitLine.nameShort',
    'routes.legs.steps.transitDetails.transitLine.name',
    'routes.legs.steps.transitDetails.stopDetails.arrivalStop',
    'routes.legs.steps.transitDetails.stopDetails.arrivalStop.name',
    'routes.legs.steps.transitDetails.stopDetails.arrivalStop.location',
    'routes.legs.steps.transitDetails.stopDetails.arrivalTime',
    'routes.legs.steps.transitDetails.stopDetails.departureStop.name',
    'routes.legs.steps.transitDetails.stopDetails.departureStop.location',
    'routes.legs.steps.transitDetails.stopDetails.departureTime',
  ].join(',');
}

async function computeRoutes(origin, destination, options = {}) {
  const apiKey = getApiKey();
  const body = {
    origin: toWaypoint(origin),
    destination: toWaypoint(destination),
    travelMode: options.mode === 'transit' ? 'TRANSIT' : 'BICYCLE',
    computeAlternativeRoutes: false,
  };

  if (options.departureTime) {
    body.departureTime = options.departureTime.toISOString();
  }

  const response = await requestJson('https://routes.googleapis.com/directions/v2:computeRoutes', {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    method: 'POST',
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': routeFieldMask(),
    },
    body,
  });

  return response.routes || [];
}

async function computeBikeMatrix(origin, destinations, options = {}) {
  return bikeMatrix([origin], destinations, options);
}

async function computeBikeEgressMatrix(origins, destination, options = {}) {
  return bikeMatrix(origins, [destination], options);
}

async function bikeMatrix(origins, destinations, options = {}) {
  const apiKey = getApiKey();
  const response = await requestJson('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    method: 'POST',
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'originIndex,destinationIndex,condition,duration,distanceMeters,status',
    },
    body: {
      origins: origins.map(origin => ({ waypoint: toWaypoint(origin) })),
      destinations: destinations.map((destination) => ({ waypoint: toWaypoint(destination) })),
      travelMode: 'BICYCLE',
    },
  });

  if (!Array.isArray(response)) {
    throw new Error('Routes API returned an unexpected route matrix response.');
  }

  return response;
}

module.exports = {
  geocodeAddress,
  findNearbyTransitStops,
  computeRoutes,
  computeBikeMatrix,
  computeBikeEgressMatrix,
};
