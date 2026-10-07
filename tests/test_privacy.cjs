'use strict';
const assert=require('node:assert/strict'),Module=require('node:module'),path=require('node:path'),os=require('node:os');
const {manualProfile,resolveProfile}=require('../extension/privacy-profile.cjs');
const {installRuntimePrivacy}=require('../extension/runtime-privacy.cjs');
const {createNetworkGuard}=require('../extension/network-guard.cjs');
const {installNetworkScope}=require('../extension/network-scope.cjs');
const real=Intl.DateTimeFormat().resolvedOptions(),hostname=os.hostname();
const config={enabled:true,mode:'auto',timeZone:'Etc/UTC',locale:'en-US',maskDeviceInfo:true};
(async()=>{
  let calls=0;
  const off={status:()=>({allowed:false}),fetch:()=>{calls++;throw Error('must not run');}};
  assert.equal((await resolveProfile(config,'test-seed',off)).source,'manual-fallback');assert.equal(calls,0);
  const endpoint={status:()=>({allowed:true}),async fetch(url,options){assert.equal(url,'https://claude.ai/cdn-cgi/trace');assert.equal(options.credentials,'omit');assert.equal(options.headers,undefined);return new Response('ip=192.0.2.1\nloc=JP\n');}};
  let p=await resolveProfile(config,'test-seed',endpoint);
  assert.equal(p.timeZone,'Asia/Tokyo');assert.equal(p.locale,'ja-JP');assert.equal(p.country,'JP');assert.equal(p.ip,undefined);
  assert.equal(p.machineId,manualProfile(config,'test-seed').machineId);
  const denied={status:()=>({allowed:true}),fetch:async()=>new Response('denied',{status:403})};
  const fallback=await resolveProfile(config,'test-seed',denied);assert.equal(fallback.timeZone,'UTC');assert.equal(fallback.source,'manual-fallback');
  assert.throws(()=>manualProfile({...config,timeZone:'Invalid/Zone'},'seed'));
  console.log('PASS: auto uses the claude.ai route without credentials; off does not probe; failed/unknown regions use manual fallback.');
  const privacy=installRuntimePrivacy(()=>p);
  try {
    const sample=new Date('2026-01-02T03:04:05Z');
    assert.equal(sample.getHours(),12);assert.equal(sample.getTimezoneOffset(),-540);
    assert.equal(Date.parse(sample.toString()),sample.getTime());
    assert.equal(new Date(2026,0,2,3,4,5).toISOString(),'2026-01-01T18:04:05.000Z');
    assert.equal(new Date('2026-01-02T03:04:05').toISOString(),'2026-01-01T18:04:05.000Z');
    assert.equal(new Date('2026-01-02').toISOString(),'2026-01-02T00:00:00.000Z');
    sample.setHours(14);assert.equal(sample.toISOString(),'2026-01-02T05:04:05.000Z');
    assert.equal(new Date(NaN).toString(),'Invalid Date');
    assert.equal(Intl.DateTimeFormat().resolvedOptions().locale,'ja-JP');
    assert.equal(new Intl.NumberFormat().resolvedOptions().locale,'ja-JP');
    assert.equal(new Intl.DateTimeFormat('en-US',{timeZone:'UTC'}).resolvedOptions().timeZone,'UTC');
    p=manualProfile({...config,timeZone:'America/New_York'},'seed');
    assert.equal(new Date('2026-01-01T00:00:00Z').getTimezoneOffset(),300);
    assert.equal(new Date('2026-07-01T00:00:00Z').getTimezoneOffset(),240);
  } finally {privacy.uninstall();}
  assert.deepEqual(Intl.DateTimeFormat().resolvedOptions(),real);
  console.log('PASS: Date, Intl defaults, local constructors/setters and DST use the selected profile; UTC timestamps and explicit locales remain usable.');
  p=manualProfile({...config,timeZone:'Asia/Tokyo',locale:'ja-JP'},'seed');
  const originalLoad=Module._load;
  const realVSCode={env:{machineId:'REAL_DEVICE_SENTINEL',language:'zh-CN',openExternal:async()=>true}};
  Module._load=function(id,parent,isMain){return id==='vscode'?realVSCode:originalLoad.call(this,id,parent,isMain);};
  const guard=createNetworkGuard({stateProvider:()=>({allowed:true,port:7890}),getProfile:()=>p});
  const scope=installNetworkScope(guard,()=>p);
  try {
    const fake=new Module(path.join(__dirname,'anthropic.claude-code-fixture','probe.js'));
    fake.filename=fake.id;fake.paths=Module._nodeModulePaths(__dirname);
    fake._compile("exports.inspect=()=>({zone:Intl.DateTimeFormat().resolvedOptions().timeZone,locale:Intl.DateTimeFormat().resolvedOptions().locale,host:require('os').hostname(),cpu:require('os').cpus()[0]?.model,id:require('vscode').env.machineId,language:require('vscode').env.language,offset:new Date('2026-01-02T00:00:00Z').getTimezoneOffset()});",fake.filename);
    const value=fake.exports.inspect();assert.equal(value.zone,'Asia/Tokyo');assert.equal(value.locale,'ja-JP');assert.equal(value.host,'claude-device');assert.equal(value.cpu,'Generic CPU');assert.notEqual(value.id,'REAL_DEVICE_SENTINEL');assert.equal(value.language,'ja-JP');assert.equal(value.offset,-540);
    assert.deepEqual(Intl.DateTimeFormat().resolvedOptions(),real);assert.equal(os.hostname(),hostname);assert.equal(realVSCode.env.machineId,'REAL_DEVICE_SENTINEL');
    p={...p,enabled:false};assert.equal(fake.exports.inspect().id,'REAL_DEVICE_SENTINEL');assert.equal(fake.exports.inspect().zone,real.timeZone);
  } finally {scope.uninstall();Module._load=originalLoad;guard.dispose();}
  console.log('PASS: only the Claude host receives masked metadata; unrelated extensions and the disabled mode keep original values.');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
