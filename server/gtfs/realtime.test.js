const test = require('node:test');
const assert = require('node:assert/strict');
const bindings = require('gtfs-realtime-bindings');
const { fixture } = require('./fixtures');
const { decode, validateSnapshot, compatibility, realtimeView } = require('./realtime');
const { scanJourneys } = require('./planner');
const now = Date.parse('2026-10-12T11:38:00-07:00');
const base = { trip: { tripId:'T1', startDate:'20261012' }, stopTimeUpdate:[{stopSequence:1,stopId:'A',departure:{delay:300}}] };
const snapshot = (updates, timestamp = now) => validateSnapshot({header:{timestamp:timestamp/1000},entity:updates.map((tripUpdate,i)=>({id:String(i),tripUpdate}))},null,now);
const run = (feed, view, minutes = 13) => scanJourneys(feed,[{stopId:'A',minutes}],now,{transform:view.transform}).candidates;

test('real protobuf sample decodes without inventing absent scalar predictions', () => {
  const Feed=bindings.transit_realtime.FeedMessage;
  const buffer=Feed.encode(Feed.fromObject(snapshot([base]).message)).finish();
  const result=decode(buffer);
  assert.equal(result.entity[0].tripUpdate.stopTimeUpdate[0].departure.delay,300);
  assert.equal(Object.hasOwn(result.entity[0].tripUpdate.stopTimeUpdate[0].departure,'time'),false);
});
test('actual trip/stop agreement gates compatibility, not provider name', () => {
  const f=fixture(); assert.equal(compatibility(f,snapshot([base])).verified,true);
  assert.equal(compatibility(f,snapshot([{...base,stopTimeUpdate:[{stopSequence:1,stopId:'B'}]}])).verified,false);
  assert.equal(compatibility({...f,source:'vta-direct'},snapshot([base])).verified,false);
  assert.equal(compatibility(f,snapshot([{trip:base.trip}])).verified,false);
});
test('cancellation-only snapshots use earlier verified samples tied to the same static hash', () => {
  const f=fixture();const evidence=compatibility(f,snapshot([base]));
  const canceled=snapshot([{trip:{...base.trip,scheduleRelationship:'CANCELED'}}]);
  assert.equal(run(f,realtimeView(f,canceled,null,{now,compatibilityEvidence:evidence}),10).length,0);
  assert.equal(run({...f,hash:'changed'},realtimeView({...f,hash:'changed'},canceled,null,{now,compatibilityEvidence:evidence}),10).length,1);
});
test('delay applied before catchability, arrival ranking, and propagation', () => {
  const f=fixture();assert.equal(run(f,{},13).length,0);
  const result=run(f,realtimeView(f,snapshot([base]),null,{now}));
  assert.equal(result.length,1);assert.equal(new Date(result[0].time).toISOString(),'2026-10-12T19:05:00.000Z');
  assert.equal(result[0].segments[0].instance.times[1].arrivalSource,'predicted (propagated delay)');
});
test('early departure makes a previously catchable bus uncatchable', () => {
  const f=fixture(); const view=realtimeView(f,snapshot([{...base,stopTimeUpdate:[{stopId:'A',departure:{delay:-180}}]}]),null,{now});
  assert.equal(run(f,view,10).length,0);
});
test('cancellations and skipped boarding/alighting suppress journeys', () => {
  const f=fixture();
  for (const update of [
    {...base,trip:{...base.trip,scheduleRelationship:'CANCELED'}},
    {...base,stopTimeUpdate:[{stopId:'A',scheduleRelationship:'SKIPPED'}]},
    {...base,stopTimeUpdate:[{stopId:'B',scheduleRelationship:'SKIPPED'}]},
  ]) assert.equal(run(f,realtimeView(f,snapshot([update]),null,{now}),10).length,0);
});
test('missing, stale feed, and stale per-trip predictions fall back to labeled schedules', () => {
  const f=fixture();
  for (const updates of [null,snapshot([base],now-301000),snapshot([{...base,timestamp:(now-301000)/1000}])]) {
    const view=realtimeView(f,updates,null,{now});const result=run(f,view,10);
    assert.equal(result[0].segments[0].instance.times[0].departureSource,'scheduled');
    assert.equal(run(f,view,13).length,0);
  }
});
test('service-day mismatch and ambiguous missing date are not applied to another day', () => {
  const f=fixture();
  for (const trip of [{tripId:'T1'}, {...base.trip,startDate:'20261013'}]) {
    assert.equal(run(f,realtimeView(f,snapshot([{...base,trip}]),null,{now}),13).length,0);
  }
});
test('NO_DATA clears propagated delay; skipped intermediate stop permits staying aboard', () => {
  const f=fixture({trips:[{id:'T1',stops:[['A','11:50:00'],['B','12:00:00'],['C','12:10:00']]}]});
  const updates=snapshot([{...base,stopTimeUpdate:[...base.stopTimeUpdate,{stopId:'B',scheduleRelationship:'NO_DATA'}]}]);
  const result=run(f,realtimeView(f,updates,null,{now}),10).find(c=>c.stopId==='C');
  assert.equal(result.segments[0].instance.times[2].arrivalSource,'scheduled');
  const skipped=snapshot([{...base,stopTimeUpdate:[{stopId:'B',scheduleRelationship:'SKIPPED'}]}]);
  assert.equal(run(f,realtimeView(f,skipped,null,{now}),10).some(c=>c.stopId==='C'),true);
});
test('out-of-order/future/differential snapshots rejected', () => {
  const old=snapshot([base]);
  for (const header of [{timestamp:now/1000-1},{timestamp:now/1000+61},{timestamp:now/1000,incrementality:'DIFFERENTIAL'},{}]) {
    assert.throws(()=>validateSnapshot({header,entity:[]},old,now));
  }
});
test('invalid nonchronological predictions do not manufacture a journey', () => {
  const f=fixture();const update={...base,stopTimeUpdate:[...base.stopTimeUpdate,{stopId:'B',arrival:{time:(now-10000)/1000}}]};
  assert.equal(run(f,realtimeView(f,snapshot([update]),null,{now}),13).length,0);
});
test('Service Alerts use active periods and AND selectors; NO_SERVICE affects routing', () => {
  const f=fixture();const alert={activePeriod:[{start:now/1000,end:now/1000+3600}],informedEntity:[{routeId:'22'}],effect:'NO_SERVICE',headerText:{translation:[{language:'en',text:'Canceled <script>'}]}};
  const alerts=validateSnapshot({header:{timestamp:now/1000},entity:[{id:'a',alert}]},null,now);
  assert.equal(run(f,realtimeView(f,snapshot([base]),alerts,{now}),10).length,0);
  alert.informedEntity=[{routeId:'other',stopId:'A'}];
  assert.equal(run(f,realtimeView(f,snapshot([base]),alerts,{now}),10).length,1);
  alert.informedEntity=[{routeId:'22'}];alert.effect='SIGNIFICANT_DELAYS';
  const view=realtimeView(f,snapshot([base]),alerts,{now});const result=run(f,view,10);
  assert.equal(view.alertsFor(result[0].segments)[0].header,'Canceled <script>');
  assert.equal(run(f,realtimeView(f,snapshot([base]),{...alerts,timestamp:now-901000},{now}),10).length,1);
});
