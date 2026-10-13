# Bike → Transit → Bike

A personal Express/vanilla-JavaScript planner for carrying a bicycle on VTA transit. Production routing uses a local GTFS schedule graph, not Google's first transit itinerary. Google supplies geocoding, bicycle road distances/geometry, and a separate normal-transit comparison.

## Run locally

```sh
npm install
# If .env does not already exist, copy .env.example to .env and fill in keys.
npm start
```

Open http://localhost:3000. Use modern Node.js; validation uses Node 24. Do not overwrite an existing .env.

- GOOGLE_MAPS_API_KEY: server key with Places API (New) and Routes API enabled.
- GOOGLE_MAPS_BROWSER_API_KEY: optional separate browser key restricted to Maps JavaScript API and your local website origin. The server key is never sent to the browser.
- TRANSIT_511_API_KEY: optional 511 token. Keep it in .env, never source control or chat.
- PORT: defaults to 3000.

## Data sources and phases

Phase 1 implements static schedules, calendars/exceptions, overnight service, exact-frequency expansion, bicycle access/egress, and transfers. Phase 2 adds Trip Updates and Service Alerts before catchability and arrival ranking. Vehicle Positions are not used.

With a token, the primary source is [511 GTFS](https://511.org/open-data/transit). The adapter queries gtfsoperators, selects the unique VTA record by name, and uses its returned Id for datafeeds, tripupdates, and servicealerts. No guessed operator ID is embedded.

Without a token, the app uses [VTA's direct static ZIP](https://gtfs.vta.org/gtfs_vta.zip), scheduled-only. Downloads are cached in ignored data/, parsed once, and refreshed in the background. Refresh failure retains the last valid schedule; dates outside its stated coverage do not return transit itineraries.

### Identifier verification is a gate

Actual decoded trip and stop identifiers must match the loaded 511 static feed before predictions are enabled. Supplied stop ID and sequence must agree; route/direction are checked when supplied. Unmatched updates are quarantined. Result realtime.compatibility metadata contains the static ZIP hash, match/rejection counts, and up to five actual matched trip/stop examples.

Evidence belongs to that static hash. Cancellation-only or empty snapshots may reuse earlier matching evidence for the same hash. A changed static feed requires new evidence. Merely downloading both feeds from 511 never enables predictions.

**Live verification, October 11, 2026:** gtfsoperators returned VTA identifier SC. The 511 static feed (version 20261005, SHA-256 4acfc959d3feaaf226c85bdffa80d22a508a2359174cb195ee8906bb3a32e45c) contained 9,123 trips and 3,332 stops, covering August 10–October 25. A Trip Updates sample timestamped 2026-10-11T23:22:38Z matched 319 trips and 7,596 stop references; 15 updates were quarantined. For example, trip 3979319 / sequence 56 / stop 65472 matched. In trip 3980764, sequence 42 referred to live stop 60418 but static stop 60419, so its predictions were not applied. This is partial, measured compatibility—not universal compatibility. A two-hour instance scan applied predictions to 272 instances. Service Alerts were also downloaded and their SC agency, route, and stop selectors inspected. Live cancellations/skipped stops were not observed; those behaviors are regression-tested synthetically.

Direct VTA IDs are never automatically combined with 511 predictions. That would require actual samples and a versioned, unambiguous mapping of trip service date/start time, route/direction, and ordered stops (including repeated stops). Similar names, stop codes, or stripped prefixes alone are insufficient. Prefer matching 511 static and real-time feeds.

Concrete source difference: on shared trip 3979562, stop sequence 17 (Alum Rock & King) is direct-VTA stop 426 but 511 stop 60426. The two sampled static feeds also have different trip counts/versions. This single correspondence does not establish a general prefix mapping.

## Routing policies and supported scope

- Every served stop within the straight-line bike reach bound is eligible for road-distance evaluation. The former twelve-Google-candidate restriction no longer drives production routing.
- Speed defaults to 8 mph. Blank initial bike limit means 30 minutes; explicit values above 60 are capped. The limit does not apply to final cycling or direct biking.
- Bicycle times use routed road distance divided by configured speed. Missing/failed matrix elements never become free rides.
- No extra parking/boarding buffer is added. Arriving exactly at departure is catchable.
- Default search scope: six hours and at most two transfers, configurable and disclosed.
- Pickup/dropoff restrictions and bikes_allowed=2 exclude unusable rides. Unspecified bicycle permission is labeled; rack capacity is not modeled.
- Same-stop transfers add no artificial buffer. Stops within 75 m use estimated straight-line walking at 1.2 m/s. Explicit transfer prohibitions/minimums are checked. These walks are not pedestrian-network or accessibility validation.
- Candidate alighting stops are evaluated for final cycling. A straight-line lower bound, unique-stop cache, and top-three arrival threshold reduce exit-matrix calls. Direct biking does not suppress slower transit options.
- Rank by earliest final arrival. Deduplicate identical vehicle sequences across access/exit choices, retaining their best arrival. Show up to three transit results, with direct cycling always last.
- The separate normal-transit comparison remains Google-derived and can differ from consumer Google Maps.

“Complete” means the supported scheduled VTA graph within disclosed horizon/transfer/bicycle limits, not all agencies or every optional GTFS extension. Non-exact headways are excluded rather than inventing departures; malformed trips produce coverage warnings. On-demand pickup/dropoff, pathways/accessibility, interlining/in-seat transfers, added/replacement real-time trips, and detour geometry are not implemented. The sampled VTA direct feed had zero excluded trips and no transfers.txt.

## Real-time semantics

Updates are applied before sorting connections, checking bike catchability/transfers, and ranking arrival. Canceled/deleted trips are removed. Skipped stops prohibit boarding/alighting but allow staying aboard. Delay propagation is labeled; NO_DATA clears it until a usable later prediction. Missing predictions remain scheduled, never “on time.”

Updates require an explicit service date; frequency instances additionally require start time. Ambiguous dates, stale trip timestamps, unsupported added/replacement trips, mismatched IDs, and contradictory chronology do not invent journeys. Those predictions fall back to the schedule. Without a trip timestamp, feed time is the available freshness bound, not proof of a newer vehicle observation.

Active Service Alerts match agency/route/trip/stop selectors. NO_SERVICE suppresses matching trips or boarding/alighting stops before routing. Other alerts are displayed as plain text. Missing/stale alerts warn that disruptions may be unreported. Each boarding/alighting labels its own scheduled/predicted source.

### Shared polling and aggregate budget

One coordinator per token serves all route searches. A per-user/token lock in the OS temporary directory prevents duplicate polling by another local Node process; followers read shared snapshots. A persisted rolling-hour ledger covers **every 511 attempt**: discovery, static downloads, polls, refreshes, failures, and later retries. It is written before sending requests. One serialized queue prevents overlapping requests; polling ticks cannot overlap. HTTP 429 applies global exponential backoff honoring Retry-After.

Defaults: updates every 120 seconds and alerts every 300 seconds, approximately 42 periodic requests/hour plus discovery/static requests. The aggregate budget defaults to 54/hour, below [511's default 60 per 3600 seconds](https://511.org/open-data/transit). No immediate retry loop is used. Polling runs while the server is active; stop the server to stop polling.

The latest valid snapshots survive failures but expire by feed age. Invalid, out-of-order, future-dated, and differential snapshots are rejected. Failed polls never refresh feed timestamps. Local locking does not coordinate other machines or unrelated apps sharing the token. Clearing the temporary ledger removes restart quota history.

| Setting | Default | Meaning |
| --- | --- | --- |
| TRANSIT_511_HOURLY_BUDGET | 54 | Aggregate rolling-hour attempts; maximum 60 |
| GTFS_RT_TRIP_INTERVAL_SECONDS | 120 | Updates polling |
| GTFS_RT_ALERT_INTERVAL_SECONDS | 300 | Alerts polling |
| GTFS_RT_TRIP_MAX_AGE_SECONDS | 300 | Feed and per-trip freshness |
| GTFS_RT_ALERT_MAX_AGE_SECONDS | 900 | Alert freshness |
| GTFS_STATIC_REFRESH_SECONDS | 86400 | Static refresh; minimum 3600 |
| GTFS_SEARCH_HOURS | 6 | Search horizon |
| GTFS_MAX_TRANSFERS | 2 | Maximum transfers, 0–4 |
| BIKE_MATRIX_ELEMENT_BUDGET | 3000 | Access + exit matrix elements per search |

## Efficiency, costs, and failures

GTFS transit routing is local. Google matrices batch up to 50 elements: one origin/many access stops or many exit stops/one destination. Access is spatially filtered; calendars are cached; static out-of-window trips avoid allocation; a spatial grid finds transfer neighbors; equivalent labels are pruned; exit distances are cached per search and evaluated against lower bounds.

A broader search can cost more Google matrix elements than the old twelve-stop prototype. The element budget is a cost ceiling, not a claim of optimality when reached: truncated/failed matrices produce explicit incomplete-coverage warnings. A sampled real search used 687 elements and 24 Google HTTP requests including comparisons and geometry; this is an observation, not a fixed per-search cost.

Google HTTP deadlines are 10 seconds; search deadlines are 90 seconds. Disconnecting or superseding a browser search cancels its outstanding calls. Optional comparison/geometry failures preserve completed routes. Feed downloads have bounded size: 60-second deadlines for static ZIPs, 20 seconds for other endpoints. Local parsing/scanning is synchronous and briefly blocks the Node event loop; this is a single-user app, not a multi-user routing service.

Transit map geometry uses GTFS shapes where stop shape distances permit slicing; otherwise it is labeled as a stop-to-stop schematic. Live detours are not reconstructed. Bicycle geometry remains optional Google output.

## Tests and module boundaries

```sh
npm test
rg --files -g '*.js' -g '!node_modules' -g '!.git' | xargs -n 1 node --check
git diff --check
```

Tests use synthetic feeds/Google responses, loopback HTTP, and fake-browser checks; they do not load .env or spend quota. No build, lint, or type-check script exists.

- server/gtfs/static.js and time.js: ZIP/CSV validation, schedule/calendar/spatial indexes, service days.
- server/gtfs/planner.js: connection scan and transfers.
- server/gtfs/provider.js: bicycle matrices, bounds, ranking, response conversion.
- server/gtfs/runtime.js and transport.js: static cache lifecycle and bounded downloads.
- server/gtfs/realtime.js: protobuf decoding, compatibility gate, freshness, updates, alerts.
- server/gtfs/poller.js: discovery, token owner, aggregate budget, backoff, shared snapshots.
- server/index.js: production wiring; app.js: injectable Express endpoints.
- server/searchService.js: search deadline and optional comparison/geometry. Legacy Google discovery remains for existing injected-client tests, not production.
- server/validation.js: input contract; public/app.js: safe text rendering and stale-request guards.

## Live validation checklist

1. Enter origin/destination, date/time, speed, and access limit. The browser interprets input in its local timezone and submits UTC.
2. Compare bike-ready time with actual boarding departure; inspect every transfer and final cycling leg. There is no extra boarding margin.
3. Check scheduled/predicted labels and coverage/alert warnings. Tomorrow's schedule is not a current live prediction.
4. With a 511 token, inspect realtime.operator and realtime.compatibility: returned operator ID, matched samples, and static hash. Check timestamps and stale/missing cases before trusting live routing.
5. Compare the same departure against VTA/Google Maps, considering feed versions, service dates, distances, and boarding margin.

Secrets, dependencies, downloads, and personal trip fixtures stay out of Git. ASTRA_HANDOFF.md preserves the historical design; this README describes the current implementation.
