'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {root,scratch}=require('./runtime.cjs');
const native=process.env.CLAUDE_NATIVE_EXE;
if(!native||!fs.existsSync(native))throw new Error('Set CLAUDE_NATIVE_EXE to an unmodified official Claude native executable.');
const dir=fs.mkdtempSync(path.join(scratch,'native-privacy-'));
const profile={enabled:true,timeZone:'Asia/Tokyo',locale:'ja-JP',maskDeviceInfo:true,machineId:'FAKE_PRIVACY_TEST_ID'};
const compiler=process.env.CSC_EXE||path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const source=path.join(dir,'Probe.cs'),exe=path.join(dir,'Probe.exe');
// Exercise the production C# wrapper's preload argument construction and
// fail-closed probe without invoking a logged-in Claude session.
fs.writeFileSync(source,`using System;using System.Diagnostics;using System.Reflection;using System.IO;class PrivacyProbeTest{static int Main(string[] args){var type=typeof(ClaudePluginGuard);var flags=BindingFlags.NonPublic|BindingFlags.Static;string argument=(string)type.GetMethod("PreloadArgument",flags).Invoke(null,new object[]{args[1]});if(argument==null)throw new Exception("Preload path unsupported");var start=new ProcessStartInfo(args[0]);start.EnvironmentVariables["CLAUDE_GUARD_PRIVACY_JSON"]=args[2];start.EnvironmentVariables["BUN_OPTIONS"]="--preload="+argument;bool ok=(bool)type.GetMethod("PrivacyProbe",flags).Invoke(null,new object[]{start});Console.WriteLine(ok?"PASS":"REJECTED");return ok?0:77;}}`);
let run=spawnSync(compiler,['/nologo','/target:exe','/main:PrivacyProbeTest','/out:'+exe,path.join(root,'extension/ClaudePluginGuard.cs'),source],{encoding:'utf8',windowsHide:true});assert.equal(run.status,0,run.stdout+run.stderr);
run=spawnSync(exe,[native,path.join(root,'extension/backend-privacy.cjs'),JSON.stringify(profile)],{encoding:'utf8',windowsHide:true});assert.equal(run.status,0,run.stdout+run.stderr);assert.equal(run.stdout.trim(),'PASS');
console.log('PASS: production wrapper validates the real Claude preload before its application entry point starts.');
const broken=path.join(dir,'unsupported.cjs');fs.writeFileSync(broken,"process.stdout.write('NOT_A_PRIVACY_PRELOAD\\n');process.exit(0);");
run=spawnSync(exe,[native,broken,JSON.stringify(profile)],{encoding:'utf8',windowsHide:true});assert.equal(run.status,77);assert.equal(run.stdout.trim(),'REJECTED');
console.log('PASS: an unsupported or inactive privacy preload is rejected rather than silently launching Claude.');
const inspection=path.join(dir,'inspect.cjs');
fs.writeFileSync(inspection,`const os=require('node:os');const p=Intl.DateTimeFormat().resolvedOptions();console.log(JSON.stringify({zone:p.timeZone,locale:p.locale,hostname:os.hostname(),cpu:os.cpus()[0]?.model,offset:new Date('2026-01-02T00:00:00Z').getTimezoneOffset(),local:new Date(2026,0,2,3).toISOString(),utc:new Date('2026-01-02T00:00:00Z').toISOString()}));process.exit(0);`);
run=spawnSync(native,['--version'],{encoding:'utf8',windowsHide:true,env:{...process.env,CLAUDE_GUARD_PRIVACY_JSON:JSON.stringify(profile),CLAUDE_GUARD_PRIVACY_PROBE:'0',BUN_OPTIONS:'--preload='+path.join(root,'extension/backend-privacy.cjs').replaceAll('\\','/')+' --preload='+inspection.replaceAll('\\','/')}});
assert.equal(run.status,0,run.stderr);
const result=JSON.parse(run.stdout.trim());assert.deepEqual(result,{zone:'Asia/Tokyo',locale:'ja-JP',hostname:'claude-device',cpu:'Generic CPU',offset:-540,local:'2026-01-01T18:00:00.000Z',utc:'2026-01-02T00:00:00.000Z'});
console.log('PASS: actual bundled Bun reads the selected timezone/locale and masked metadata; UTC instants remain unchanged.');
