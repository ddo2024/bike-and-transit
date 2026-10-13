const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.listeners = {};
    this.className = '';
    this.hidden = false;
    this._text = '';
    this.classList = { add: (name) => { this.className += ` ${name}`; } };
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('\n');
  }

  set innerHTML(_) {
    throw new Error('Rendering must not write HTML.');
  }

  insertAdjacentHTML() {
    throw new Error('Rendering must not write HTML.');
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this._text = '';
    this.children = children;
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function response(data) {
  return { ok: true, json: async () => data };
}

function route(name, overrides = {}) {
  return {
    mode: 'bike-transit', stopName: name, boardingStop: name,
    stopLat: 37.3, stopLng: -121.9, bikeDistanceMiles: '1.0', bikeMinutes: 8,
    finalBikeDistanceMiles: '0.5', finalBikeMinutes: 4,
    waitMinutes: 3, walkingMinutes: 0, transitLines: ['22'], transferCount: 0,
    totalMinutes: 30, finalArrival: '2026-10-12T16:30:00Z',
    arrivalAtStop: '2026-10-12T16:08:00Z',
    ...overrides,
  };
}

function trip(results, overrides = {}) {
  return {
    results,
    origin: { lat: 37.3, lng: -121.9 },
    destination: { lat: 37.4, lng: -121.8 },
    ...overrides,
  };
}

function harness(fetchSearch, mapConfig = async () => response({ browserApiKey: null })) {
  const ids = ['route-form', 'status', 'results', 'map-panel', 'map-status', 'map'];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement('div')]));
  const departureInput = new FakeElement('input');
  const head = new FakeElement('head');
  let formValues;
  const calls = [];
  const window = {};
  const context = vm.createContext({
    window,
    document: {
      getElementById: (id) => elements[id],
      createElement: (tagName) => new FakeElement(tagName),
      querySelector: () => departureInput,
      head,
    },
    AbortController,
    FormData: class {
      constructor() { this.values = { ...formValues }; }
      get(key) { return this.values[key]; }
    },
    fetch: (url, options) => {
      calls.push({ url, options });
      return url === '/api/map-config' ? mapConfig() : fetchSearch(url, options);
    },
  });
  vm.runInContext(source, context, { filename: 'public/app.js' });
  return {
    elements, window, head, calls,
    submit(values = {}) {
      formValues = {
        origin: 'Origin', destination: 'Destination', departureTime: '2026-10-12T08:00',
        bikeSpeedMph: '8', maxBikeMinutes: '', ...values,
      };
      return elements['route-form'].listeners.submit({ preventDefault() {} });
    },
  };
}

function fakeMaps() {
  const overlays = [];
  const instances = [];
  class Overlay {
    constructor(options) { this.options = options; this.map = options.map; overlays.push(this); }
    setMap(map) { this.map = map; }
  }
  return {
    overlays, instances,
    api: {
      Map: class {
        constructor(_, options) { this.options = options; instances.push(this); }
        fitBounds() {}
      },
      LatLngBounds: class { extend() {} },
      Polyline: Overlay,
      Marker: Overlay,
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a superseded response cannot replace the latest results and its request is aborted', async () => {
  const requests = [deferred(), deferred()];
  let index = 0;
  const browser = harness(() => requests[index++].promise);
  const oldSearch = browser.submit();
  const newSearch = browser.submit();
  assert.equal(browser.calls[0].options.signal.aborted, true);
  requests[1].resolve(response(trip([route('Newest stop')])));
  await newSearch;
  requests[0].resolve(response(trip([route('Old stop')])));
  await oldSearch;
  assert.match(browser.elements.results.textContent, /Newest stop/);
  assert.doesNotMatch(browser.elements.results.textContent, /Old stop/);
});

test('a superseded error cannot replace the latest successful status', async () => {
  const firstRequest = deferred();
  let index = 0;
  const browser = harness(() => index++ === 0 ? firstRequest.promise : Promise.resolve(response(trip([route('Latest stop')]))));
  const oldSearch = browser.submit();
  await browser.submit();
  firstRequest.reject(new Error('Old request failed'));
  await oldSearch;
  assert.match(browser.elements.status.textContent, /^1 bike \+ transit/);
  assert.doesNotMatch(browser.elements.status.className, /error/);
});

test('baseline comparison never reuses an arrival from the preceding search', async () => {
  const baseline = { finalArrival: '2026-10-12T17:15:00Z' };
  const responses = [
    trip([route('First stop')], { baseline }),
    trip([{ mode: 'direct-bike', unavailable: true }], { baseline }),
  ];
  const browser = harness(async () => response(responses.shift()));
  await browser.submit();
  assert.match(browser.elements.results.textContent, /Estimated time saved: 45 min/);
  await browser.submit();
  assert.match(browser.elements.results.textContent, /No usable bike route is available for comparison/);
  assert.doesNotMatch(browser.elements.results.textContent, /Estimated time saved|Bike \+ transit best arrival/);
  assert.equal(browser.window.bestRouteArrival, undefined);
});

test('an old map loader cannot draw or change status after a newer empty search', async () => {
  const config = deferred();
  const responses = [trip([route('Old stop')]), trip([])];
  const browser = harness(async () => response(responses.shift()), () => config.promise);
  const maps = fakeMaps();
  browser.window.google = { maps: maps.api };
  await browser.submit();
  await browser.submit();
  assert.equal(browser.elements['map-status'].textContent, 'No route geometry to display.');
  config.resolve(response({ browserApiKey: 'test-key' }));
  await flush();
  browser.window.bikeTransitMapsReady();
  await flush();
  assert.equal(maps.instances.length, 0);
  assert.equal(maps.overlays.length, 0);
  assert.equal(browser.elements['map-status'].textContent, 'No route geometry to display.');
});

test('new submission clears existing map overlays before waiting for results', async () => {
  const pendingSearch = deferred();
  let index = 0;
  const browser = harness(
    async () => index++ === 0 ? response(trip([route('First stop')])) : pendingSearch.promise,
    async () => response({ browserApiKey: 'test-key' }),
  );
  const maps = fakeMaps();
  browser.window.google = { maps: maps.api };
  await browser.submit();
  await flush();
  browser.window.bikeTransitMapsReady();
  await flush();
  assert.equal(maps.overlays.length, 3);
  assert.ok(maps.overlays.every((overlay) => overlay.map));
  const nextSearch = browser.submit();
  assert.ok(maps.overlays.every((overlay) => overlay.map === null));
  assert.equal(browser.elements['map-panel'].hidden, true);
  pendingSearch.resolve(response(trip([])));
  await nextSearch;
  assert.equal(browser.elements['map-status'].textContent, 'No route geometry to display.');
});

test('external names, distances, and warnings are displayed as literal text', async () => {
  const probe = '<img src=x onerror="window.compromised=true">';
  const browser = harness(async () => response(trip([
    route(probe, {
      bikeDistanceMiles: probe,
      transitSteps: [{ mode: 'TRANSIT', line: probe, headsign: probe, departureStop: probe, arrivalStop: probe }],
    }),
    { ...route(probe), mode: 'direct-bike', bikeDistanceMiles: probe },
  ], { warnings: [probe] })));
  await browser.submit();
  assert.match(browser.elements.results.textContent, /<img src=x/);
  assert.equal(browser.window.compromised, undefined);
  const visit = (node) => {
    assert.notEqual(node.tagName, 'img');
    assert.notEqual(node.tagName, 'script');
    node.children.forEach(visit);
  };
  visit(browser.elements.results);
  assert.doesNotMatch(browser.elements.status.className, /error/);
});

test('cards show each boarding, alighting, transfer walk, and keep direct bike last', async () => {
  const browser = harness(async () => response(trip([
    route('First stop', {
      transferCount: 1,
      walkingMinutes: 3,
      transitSteps: [
        { mode: 'TRANSIT', line: '22', headsign: 'Center', departureStop: 'First stop', arrivalStop: 'Hub east', departureTime: '2026-10-12T16:11:00Z', arrivalTime: '2026-10-12T16:20:00Z' },
        { mode: 'WALK', from: 'Hub east', to: 'Hub west', minutes: 3 },
        { mode: 'TRANSIT', line: '23', departureStop: 'Hub west', arrivalStop: 'Final stop', departureTime: '2026-10-12T16:24:00Z', arrivalTime: '2026-10-12T16:26:00Z' },
      ],
    }),
    { ...route('Direct'), mode: 'direct-bike' },
  ])));
  await browser.submit();
  const text = browser.elements.results.textContent;
  assert.match(text, /Board 22 toward Center at First stop/);
  assert.match(text, /Get off at Hub east/);
  assert.match(text, /Walk from Hub east to Hub west: 3 min/);
  assert.match(text, /Board 23 at Hub west/);
  assert.match(text, /Get off at Final stop/);
  assert.match(text, /Transfers: 1/);
  assert.match(text, /Walking: 3 min/);
  assert.match(browser.elements.results.children.at(-1).className, /direct-bike/);
});

test('departure is serialized to an explicit UTC instant', async () => {
  const browser = harness(async () => response(trip([])));
  await browser.submit({ departureTime: '2026-10-12T08:00' });
  const payload = JSON.parse(browser.calls[0].options.body);
  assert.equal(payload.departureTime, new Date('2026-10-12T08:00').toISOString());
  assert.match(payload.departureTime, /Z$/);
  assert.equal(payload.maxBikeMinutes, '');
  assert.equal(payload.bikeSpeedMph, '8');
});

test('invalid local departures are rejected before making requests', async () => {
  for (const departureTime of ['', 'invalid', '2026-02-30T08:00', '2026-10-12T25:00']) {
    const browser = harness(async () => { throw new Error('Unexpected request'); });
    await browser.submit({ departureTime });
    assert.equal(browser.calls.length, 0, departureTime);
    assert.match(browser.elements.status.textContent, /valid local departure/);
    assert.match(browser.elements.status.className, /error/);
  }
});

test('direct-only response uses its own baseline comparison and shows warnings safely', async () => {
  const browser = harness(async () => response(trip([
    { ...route('Direct'), mode: 'direct-bike', finalArrival: '2026-10-12T16:30:00Z' },
  ], {
    baseline: { finalArrival: '2026-10-12T16:40:00Z' },
    warnings: ['Transit lookup timed out; this search may be incomplete.'],
  })));
  await browser.submit();
  assert.match(browser.elements.results.textContent, /Direct bike arrival/);
  assert.match(browser.elements.results.textContent, /Estimated time saved: 10 min/);
  assert.match(browser.elements.results.textContent, /Transit lookup timed out/);
});

test('GTFS timing labels and service alerts render safely on result cards', async () => {
  const browser = harness(async () => response(trip([route('GTFS', {
    source: '511', timingStatus: 'Scheduled — no live prediction',
    alerts: [{header:'<script>alert(1)</script>',description:'<img src=x onerror=alert(1)>'}],
    transitSteps: [{mode:'TRANSIT',line:'22',departureStop:'A',arrivalStop:'B',
      departureTime:'2026-10-12T18:50:00Z',arrivalTime:'2026-10-12T19:00:00Z',
      departureSource:'scheduled',arrivalSource:'predicted',bikesAllowed:'unknown'}],
  })])));
  await browser.submit();
  const text=browser.elements.results.textContent;
  assert.match(text,/Scheduled — no live prediction/);assert.match(text,/Boarding: scheduled; alighting: predicted/);
  assert.match(text,/<script>alert\(1\)<\/script>/);assert.match(text,/Bicycle carriage is unspecified/);
});
