const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures');
const { tripInstances } = require('./static');
const { scanJourneys } = require('./planner');
const { serviceEpoch, gtfsSeconds } = require('./time');
const { createGtfsProvider } = require('./provider');
const departure = Date.parse('2026-10-12T11:38:00-07:00');
const access = [{ stopId: 'A', minutes: 10, distanceMeters: 1000 }];
const scan = (feed, options) => scanJourneys(feed, access, departure, options).candidates;

test('enumerates Bus 22 even when another line departs first', () => {
  const f = fixture({ trips: [{ id: '23', route: '23', stops: [['A','11:49:00'],['B','12:15:00']] },
    { id: '22', route: '22', stops: [['A','11:50:00'],['B','12:00:00']] }] });
  assert.deepEqual(scan(f).filter(c => c.stopId === 'B').map(c => c.tripKeys[0].split(':')[1]), ['22', '23']);
});
test('catchability, calendar exceptions, and bicycle prohibition', () => {
  assert.equal(scan(fixture(), { }).length, 1);
  assert.equal(scanJourneys(fixture(), [{ stopId: 'A', minutes: 13 }], departure).candidates.length, 0);
  assert.equal(scan(fixture({ calendarDates: [{ service_id: 'weekday', date: '20261012', exception_type: '2' }] })).length, 0);
  assert.equal(scan(fixture({ trips: [{ id:'x', bikes:'2', stops:[['A','11:50:00'],['B','12:00:00']] }] })).length, 0);
});
test('transfer count and forbidden/minimum transfer rules are respected', () => {
  const trips = [{ id:'a', stops:[['A','11:50:00'],['B','12:00:00']] }, { id:'b', stops:[['B','12:02:00'],['C','12:10:00']] }];
  assert.equal(scan(fixture({trips})).find(c=>c.stopId==='C').tripKeys.length, 2);
  for (const rule of [{transfer_type:'3'}, {transfer_type:'2',min_transfer_time:'180'}]) {
    assert.equal(scan(fixture({trips,transfers:[{from_stop_id:'B',to_stop_id:'B',...rule}]})).some(c=>c.stopId==='C'), false);
  }
  assert.equal(scan(fixture({trips}), {maxTransfers:0}).some(c=>c.stopId==='C'), false);
});
test('pickup/dropoff restrictions do not prevent staying aboard', () => {
  const f=fixture({trips:[{id:'x',stops:[['A','11:50:00'],['B','12:00:00',{pickup_type:'1',drop_off_type:'1'}],['C','12:10:00']]}]});
  assert.equal(scan(f).some(c=>c.stopId==='B'),false);
  assert.equal(scan(f).some(c=>c.stopId==='C'),true);
});
test('overnight service belongs to prior service day; DST uses noon minus 12h', () => {
  const f=fixture({trips:[{id:'night',stops:[['A','24:10:00'],['B','25:00:00']]}]});
  const start=Date.parse('2026-10-13T00:00:00-07:00');
  assert.equal(tripInstances(f,start,start+3600_000)[0].date,'20261012');
  assert.equal(new Date(serviceEpoch('20261101','America/Los_Angeles')).toISOString(),'2026-11-01T08:00:00.000Z');
  assert.equal(gtfsSeconds('25:01:00'),90060);
});
test('exact frequencies expand, non-exact headways explicitly excluded', () => {
  const trips=[{id:'freq',stops:[['A','10:00:00'],['B','10:10:00']]},{id:'normal',stops:[['A','11:50:00'],['B','12:00:00']]}];
  const frequencies=[{trip_id:'freq',start_time:'11:45:00',end_time:'12:15:00',headway_secs:'600',exact_times:'1'}];
  assert.equal(tripInstances(fixture({trips,frequencies}),departure,departure+3600_000).length,4);
  frequencies[0].exact_times='0';
  assert.equal(fixture({trips,frequencies}).stats.excludedTrips,1);
});
test('provider evaluates road egress, deduplicates vehicle sequence, and labels schedules', async () => {
  const feed=fixture(); const warnings=[];
  const matrix=stops=>stops.map((_,i)=>({destinationIndex:i,originIndex:0,condition:'ROUTE_EXISTS',duration:'60s',distanceMeters:100}));
  const client={computeBikeMatrix:async(_,stops)=>matrix(stops),computeBikeEgressMatrix:async(stops)=>matrix(stops).map(e=>({...e,originIndex:e.destinationIndex,destinationIndex:0}))};
  const provider=createGtfsProvider({snapshot:async()=>({feed})},client);
  const result=await provider.findTransitRoutes({departureTime:new Date(departure).toISOString(),bikeSpeedMph:8,maxBikeMinutes:30},feed.stops.get('A'),feed.stops.get('B'),new AbortController().signal,warnings);
  assert.equal(result.length,1);assert.match(result[0].timingStatus,/Scheduled/);
  assert.equal(result[0].transferCount,0);assert.equal(result[0].transitSteps[0].tripId,'T1');
});

test('same vehicle can be boarded later with less cycling without false transfer', () => {
  const f=fixture({trips:[{id:'T1',stops:[['A','11:50:00'],['B','12:00:00'],['C','12:10:00']]}]});
  const result=scanJourneys(f,[{stopId:'A',minutes:10},{stopId:'B',minutes:2}],departure).candidates.find(c=>c.stopId==='C');
  assert.equal(result.access.stopId,'B');assert.equal(result.tripKeys.length,1);
});

test('missing matrix data and element budget are explicit, never zero-time access', async () => {
  const feed=fixture();const warnings=[];
  const client={computeBikeMatrix:async()=>[],computeBikeEgressMatrix:async()=>{throw new Error('No access should survive');}};
  const provider=createGtfsProvider({snapshot:async()=>({feed})},client,{matrixBudget:1});
  const result=await provider.findTransitRoutes({departureTime:new Date(departure).toISOString(),bikeSpeedMph:8,maxBikeMinutes:30},feed.stops.get('A'),feed.stops.get('B'),new AbortController().signal,warnings);
  assert.deepEqual(result,[]);assert.ok(warnings.some(w=>/incomplete/.test(w)));assert.ok(warnings.some(w=>/budget/.test(w)));
});
