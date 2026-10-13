const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const bindings = require('gtfs-realtime-bindings');
const { RequestBudget, discoverVta, createCoordinator } = require('./poller');
const { fixture } = require('./fixtures');

test('discovers identifier from returned operator record, not a hardcoded VTA guess', () => {
  assert.equal(discoverVta(Buffer.from(JSON.stringify([{Id:'TEST_ID',Name:'Santa Clara Valley Transportation Authority'}]))).id,'TEST_ID');
  assert.throws(()=>discoverVta(Buffer.from('[]')));
  assert.throws(()=>discoverVta(Buffer.from('[{"Id":"a","Name":"VTA"},{"Id":"b","Name":"VTA"}]')));
});
test('one aggregate rolling budget charges success and failure across all endpoints', async () => {
  let now=100;let saved;const budget=new RequestBudget({limit:2,now:()=>now,save:async s=>{saved=structuredClone(s);}});
  await budget.run(async()=>1);await assert.rejects(budget.run(async()=>{throw new Error('failed download');}));
  await assert.rejects(budget.run(async()=>1),/budget/);
  const restarted=new RequestBudget({limit:2,now:()=>now,state:saved});await assert.rejects(restarted.run(async()=>1));
  now+=3600000;assert.equal(await restarted.run(async()=>2),2);
});
test('429 backs off all endpoints and prevents overlapping transport', async () => {
  let now=100;let active=0;let max=0;const budget=new RequestBudget({now:()=>now});
  const action=async()=>{active++;max=Math.max(max,active);await new Promise(r=>setImmediate(r));active--;};
  await Promise.all([budget.run(action),budget.run(action)]);assert.equal(max,1);
  await assert.rejects(budget.run(async()=>{throw Object.assign(new Error('limited'),{status:429,retryAfterMs:120000});}));
  await assert.rejects(budget.run(action));now+=120000;await budget.run(action);
});
test('polls reuse snapshots, respect intervals, and second local coordinator cannot poll token', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bike-transit-poller-test-'));
  let now=Date.parse('2026-10-12T11:38:00-07:00');const calls=[];
  const Feed=bindings.transit_realtime.FeedMessage;
  const downloadFeed=async url=>{
    const endpoint=new URL(url).pathname.split('/').at(-1);calls.push(endpoint);
    if(endpoint==='gtfsoperators')return Buffer.from('[{"Id":"discovered","Name":"VTA"}]');
    if(endpoint==='datafeeds')return Buffer.from('zip-fixture');
    return Feed.encode(Feed.fromObject({header:{gtfsRealtimeVersion:'2.0',timestamp:now/1000},entity:[{id:'t',tripUpdate:{trip:{tripId:'T1',startDate:'20261012'},stopTimeUpdate:[{stopId:'A',stopSequence:1,departure:{delay:60}}]}}]})).finish();
  };
  const owner=await createCoordinator('test-token',{directory:dir,downloadFeed,now:()=>now});
  const follower=await createCoordinator('test-token',{directory:dir,downloadFeed,now:()=>now});
  t.after(async()=>{await owner.stop();await follower.stop();await fs.rm(dir,{recursive:true,force:true});});
  await owner.staticFeed();owner.setFeed(fixture());
  await owner.tick();
  assert.deepEqual(calls,['gtfsoperators','datafeeds','tripupdates','servicealerts']);
  assert.equal(owner.snapshot().status.compatibility.verified,true);
  await Promise.all([owner.tick(),owner.tick()]);assert.equal(calls.length,4);
  now+=120000;await owner.tick();assert.equal(calls.at(-1),'tripupdates');assert.equal(calls.length,5);
  follower.setFeed(fixture());await follower.tick();assert.equal(calls.length,5);
});
