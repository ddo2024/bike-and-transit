const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {zipSync,strToU8}=require('fflate');
const {createTransitRuntime}=require('./runtime');
const {download}=require('./transport');
const {loadGtfsZip}=require('./static');
function zip() {
  const files={
    agency:'agency_id,agency_timezone\nVTA,America/Los_Angeles',
    stops:'stop_id,stop_name,stop_lat,stop_lon\na,"Quoted, stop",37,-122\nb,Other,37.1,-122',
    routes:'route_id,route_short_name\nr,22',
    trips:'route_id,service_id,trip_id\nr,s,t',
    stop_times:'trip_id,stop_id,stop_sequence,arrival_time,departure_time\nt,a,1,11:00:00,11:00:00\nt,b,2,12:00:00,12:00:00',
    calendar_dates:'service_id,date,exception_type\ns,20261012,1',
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([key,value])=>[`${key}.txt`,strToU8(value)])));
}
test('ZIP parser handles quoted CSV and exception-only calendars',()=>{
  const f=loadGtfsZip(zip());assert.equal(f.stops.get('a').name,'Quoted, stop');
  assert.equal(f.activeServices('20261012').has('s'),true);assert.equal(f.activeServices('20261013').has('s'),false);
  assert.throws(()=>loadGtfsZip(Buffer.from('not a zip')));
});
test('no-token runtime shares a single static load and can restart from cache offline',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'bike-transit-runtime-test-'));let calls=0;
  const runtime=createTransitRuntime({env:{},dataDir,downloadFeed:async()=>{calls++;return zip();}});
  t.after(async()=>{runtime.stop();await fs.rm(dataDir,{recursive:true,force:true});});
  const [a,b]=await Promise.all([runtime.snapshot(),runtime.snapshot()]);
  assert.equal(calls,1);assert.equal(a.feed,b.feed);assert.equal(a.feed.source,'vta-direct');assert.equal(a.realtime,undefined);
  const offline=createTransitRuntime({env:{},dataDir,downloadFeed:async()=>{throw new Error('offline');}});
  const cached=await offline.snapshot();assert.equal(cached.feed.hash,a.feed.hash);offline.stop();
});
test('binary transport bounds size, sanitizes errors, and preserves 429 retry delay',async()=>{
  await assert.rejects(download('https://example.test/?api_key=secret',{fetchImpl:async()=>new Response('x',{status:429,headers:{'retry-after':'120'}})}),e=>e.status===429&&e.retryAfterMs===120000&&!e.message.includes('secret'));
  await assert.rejects(download('https://example.test',{maxBytes:1,fetchImpl:async()=>new Response('too big')}),/download failed/);
  const value=await download('https://example.test',{fetchImpl:async()=>new Response('zip')});assert.equal(value.toString(),'zip');
});
