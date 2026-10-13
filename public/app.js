const form = document.getElementById('route-form');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const mapPanel = document.getElementById('map-panel');
const mapStatusEl = document.getElementById('map-status');
let mapsPromise;
let mapInstance;
let mapOverlays = [];
let latestSubmissionId = 0;
let activeSearchController;

function formatTime(date) {
  if (!date) return '—';
  const parsed = new Date(date);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '—';
}

function formatMinutes(value) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return '—';
  return `${Math.round(Number(value))} min`;
}

function decodePolyline(encoded) {
  const points = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    latitude += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    longitude += result & 1 ? ~(result >> 1) : result >> 1;
    points.push({ lat: latitude / 1e5, lng: longitude / 1e5 });
  }

  return points;
}

function loadGoogleMaps() {
  if (mapsPromise) return mapsPromise;

  mapsPromise = fetch('/api/map-config')
    .then((response) => response.json())
    .then(({ browserApiKey }) => {
      if (!browserApiKey) return null;
      return new Promise((resolve, reject) => {
        window.bikeTransitMapsReady = () => resolve(window.google.maps);
        const script = document.createElement('script');
        script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(browserApiKey)}&loading=async&callback=bikeTransitMapsReady`;
        script.async = true;
        script.defer = true;
        script.onerror = () => reject(new Error('Google Maps JavaScript API failed to load.'));
        document.head.appendChild(script);
      });
    });

  return mapsPromise;
}

function comparisonRouteFor(routes) {
  return routes.find((route) => route.mode !== 'direct-bike' && !route.unavailable)
    || routes.find((route) => route.mode === 'direct-bike' && !route.unavailable);
}

function clearMap() {
  mapOverlays.forEach((overlay) => overlay.setMap(null));
  mapOverlays = [];
  mapStatusEl.textContent = '';
}

async function renderMap(data, submissionId) {
  if (submissionId !== latestSubmissionId) return;
  clearMap();
  const route = comparisonRouteFor(data.results || []);
  mapPanel.hidden = false;
  if (!route) {
    mapStatusEl.textContent = 'No route geometry to display.';
    return;
  }

  try {
    const maps = await loadGoogleMaps();
    if (submissionId !== latestSubmissionId) return;
    if (!maps) {
      mapStatusEl.textContent = 'Map is optional. Add GOOGLE_MAPS_BROWSER_API_KEY to .env to enable it.';
      return;
    }

    mapInstance = mapInstance || new maps.Map(document.getElementById('map'), {
      center: data.origin,
      zoom: 13,
      mapTypeControl: false,
      streetViewControl: false,
    });

    const origin = { lat: data.origin.lat, lng: data.origin.lng };
    const destination = { lat: data.destination.lat, lng: data.destination.lng };
    const isDirectBike = route.mode === 'direct-bike';
    const stop = isDirectBike ? null : { lat: route.stopLat, lng: route.stopLng };
    const bounds = new maps.LatLngBounds();
    [origin, destination, stop].filter(Boolean).forEach((point) => bounds.extend(point));

    const routeLines = isDirectBike
      ? [{ path: route.firstBikePolyline, color: '#1976d2' }]
      : [
        { path: route.firstBikePolyline, color: '#1976d2' },
        { path: route.transitPolyline, color: '#2e7d32' },
        ...(route.transitPaths || []).map(segment => ({ path: segment.points, color: '#2e7d32' })),
        { path: route.finalBikePolyline, color: '#d32f2f' },
      ];
    routeLines.forEach(({ path, color }) => {
      if (!path) return;
      const polyline = new maps.Polyline({
        path: Array.isArray(path) ? path : decodePolyline(path),
        geodesic: true,
        strokeColor: color,
        strokeOpacity: 0.9,
        strokeWeight: 5,
        map: mapInstance,
      });
      mapOverlays.push(polyline);
      if (Array.isArray(path)) path.forEach(point => bounds.extend(point));
    });

    const routeMarkers = [
      { point: origin, label: 'A' },
      { point: destination, label: 'B' },
    ];
    if (stop) routeMarkers.splice(1, 0, { point: stop, label: 'T' });
    routeMarkers.forEach(({ point, label }) => {
      const marker = new maps.Marker({ position: point, label, map: mapInstance });
      mapOverlays.push(marker);
    });

    mapInstance.fitBounds(bounds, 48);
    mapStatusEl.textContent = isDirectBike
      ? 'Showing the direct bike route.'
      : `Showing the best route: Bike → ${route.transitLines?.join(', ') || 'Transit'} → Bike.`;
    if (route.transitPaths?.some(segment => segment.approximate)) mapStatusEl.textContent += ' Transit geometry is a stop-to-stop schematic where shapes are unavailable.';
  } catch (error) {
    if (submissionId !== latestSubmissionId) return;
    mapStatusEl.textContent = error.message;
  }
}

// All API-provided names and warnings are text, never HTML.
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function appendLine(parent, text) {
  parent.appendChild(element('div', text));
}

function renderBaseline(baseline, comparisonRoute) {
  if (!baseline) return null;
  const section = element('section', undefined, 'baseline');
  section.appendChild(element('strong', 'Normal transit comparison'));
  appendLine(section, `Baseline arrival: ${formatTime(baseline.finalArrival)}`);
  if (comparisonRoute) {
    const savedMinutes = Math.max(0, Math.round((new Date(baseline.finalArrival) - new Date(comparisonRoute.finalArrival)) / 60000));
    const comparisonLabel = comparisonRoute.mode === 'direct-bike' ? 'Direct bike arrival' : 'Bike + transit best arrival';
    appendLine(section, `${comparisonLabel}: ${formatTime(comparisonRoute.finalArrival)}`);
    appendLine(section, `Estimated time saved: ${formatMinutes(savedMinutes)}`);
  } else {
    appendLine(section, 'No usable bike route is available for comparison.');
  }
  section.appendChild(element('small', 'This baseline is generated by the Google API and may differ from the consumer Google Maps app.'));
  return section;
}

function renderTransitSteps(parent, route) {
  if (!Array.isArray(route.transitSteps) || !route.transitSteps.length) {
    appendLine(parent, `↓ Board at: ${route.boardingStop || route.stopName}`);
    appendLine(parent, `↓ Bus/train: ${route.transitLines?.join(', ') || route.transitRoute || 'Transit'}`);
    appendLine(parent, `↓ Get off: ${route.finalTransitStop || 'Final transit stop'}`);
    return;
  }
  route.transitSteps.forEach((step) => {
    if (step.mode === 'TRANSIT') {
      appendLine(parent, `↓ Board ${step.line || 'transit'}${step.headsign ? ` toward ${step.headsign}` : ''} at ${step.departureStop || 'transit stop'}: ${formatTime(step.departureTime)}`);
      appendLine(parent, `↓ Get off at ${step.arrivalStop || 'transit stop'}: ${formatTime(step.arrivalTime)}`);
      if (step.departureSource) appendLine(parent, `Boarding: ${step.departureSource}; alighting: ${step.arrivalSource}.`);
      if (step.bikesAllowed === 'unknown') appendLine(parent, 'Bicycle carriage is unspecified in this trip’s feed; verify with VTA.');
    } else if (step.mode === 'WALK') {
      const from = step.from || step.departureStop;
      const to = step.to || step.arrivalStop;
      appendLine(parent, `↓ Walk${from ? ` from ${from}` : ''}${to ? ` to ${to}` : ''}: ${formatMinutes(step.minutes)}`);
    }
  });
}

function renderResults(routes, baseline, warnings) {
  resultsEl.replaceChildren();
  if (Array.isArray(warnings) && warnings.length) {
    const warningSection = element('section', undefined, 'baseline');
    warningSection.appendChild(element('strong', 'Some trip information is unavailable'));
    warnings.forEach((warning) => appendLine(warningSection, warning));
    resultsEl.appendChild(warningSection);
  }
  const baselineSection = renderBaseline(baseline, comparisonRouteFor(routes));
  if (baselineSection) resultsEl.appendChild(baselineSection);
  if (routes.length === 0) {
    resultsEl.appendChild(element('p', 'No bike-to-transit routes found. Try an earlier departure, a larger maximum bike time, or a more specific origin address.'));
    return;
  }

  routes.forEach((route, index) => {
    const isDirectBike = route.mode === 'direct-bike';
    const isBest = !isDirectBike && index === 0;
    const card = element('article', undefined, `route-card${isDirectBike ? ' direct-bike' : isBest ? ' best' : ''}`);
    card.appendChild(element('div', isDirectBike ? 'Direct bike · always shown last' : isBest ? 'Best route' : `Route ${index + 1}`, 'route-header'));
    if (isDirectBike && route.unavailable) {
      card.appendChild(element('p', 'Google did not return a direct bicycle route for this trip.'));
      resultsEl.appendChild(card);
      return;
    }
    const steps = element('div', undefined, 'route-steps');
    appendLine(steps, `${isDirectBike ? 'Bike straight to destination' : 'Bike'}: ${route.bikeDistanceMiles} mi — ${formatMinutes(route.bikeMinutes)}`);
    if (!isDirectBike) {
      appendLine(steps, `↓ Bike to transit point: ${route.stopName}`);
      appendLine(steps, `Waiting (total): ${formatMinutes(route.waitMinutes)}`);
      renderTransitSteps(steps, route);
      appendLine(steps, `↓ Bike to destination: ${route.finalBikeDistanceMiles ?? '—'} mi — ${formatMinutes(route.finalBikeMinutes)}`);
    }
    card.appendChild(steps);
    const meta = element('div', undefined, 'route-meta');
    appendLine(meta, `Total: ${formatMinutes(route.totalMinutes)}`);
    appendLine(meta, `Arrival: ${formatTime(route.finalArrival)}`);
    if (!isDirectBike) {
      if (route.timingStatus) appendLine(meta, route.timingStatus);
      if (route.source) appendLine(meta, `Schedule source: ${route.source}`);
      (route.alerts || []).forEach(alert => appendLine(meta, `Service alert: ${alert.header}${alert.description ? ` — ${alert.description}` : ''}`));
      appendLine(meta, `Transfers: ${route.transferCount ?? 0}`);
      appendLine(meta, `Walking: ${formatMinutes(route.walkingMinutes ?? 0)}`);
      appendLine(meta, `Ready at stop: ${formatTime(route.arrivalAtStop)}`);
    }
    card.appendChild(meta);
    resultsEl.appendChild(card);
  });
}

function serializeDepartureTime(value) {
  const parts = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  const departure = new Date(value);
  if (!parts || !Number.isFinite(departure.getTime())
      || departure.getFullYear() !== Number(parts[1])
      || departure.getMonth() + 1 !== Number(parts[2])
      || departure.getDate() !== Number(parts[3])
      || departure.getHours() !== Number(parts[4])
      || departure.getMinutes() !== Number(parts[5])
      || departure.getSeconds() !== Number(parts[6] || 0)) {
    throw new Error('Enter a valid local departure date and time.');
  }
  return departure.toISOString();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submissionId = ++latestSubmissionId;
  activeSearchController?.abort();
  activeSearchController = new AbortController();
  statusEl.textContent = 'Searching...';
  statusEl.className = 'status';
  resultsEl.replaceChildren();
  clearMap();
  mapPanel.hidden = true;

  try {
    const formData = new FormData(form);
    const payload = {
      origin: formData.get('origin'),
      destination: formData.get('destination'),
      departureTime: serializeDepartureTime(formData.get('departureTime')),
      bikeSpeedMph: formData.get('bikeSpeedMph'),
      maxBikeMinutes: formData.get('maxBikeMinutes'),
    };
    const response = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: activeSearchController.signal,
    });

    const data = await response.json();
    if (submissionId !== latestSubmissionId) return;
    if (!response.ok) {
      throw new Error(data.error || 'Search failed.');
    }

    data.results = Array.isArray(data.results) ? data.results : [];
    const transitCount = data.results.filter((route) => route.mode !== 'direct-bike' && !route.unavailable).length;
    statusEl.textContent = `${transitCount} bike + transit route(s); direct bike option shown last.`;
    renderResults(data.results, data.baseline, data.warnings);
    renderMap(data, submissionId);
  } catch (error) {
    if (submissionId !== latestSubmissionId) return;
    statusEl.textContent = error.message;
    statusEl.classList.add('error');
  }
});

const now = new Date();
const localDateTime = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
document.querySelector('input[name="departureTime"]').value = localDateTime;
