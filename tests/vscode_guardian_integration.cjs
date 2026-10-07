'use strict';
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),http=require('node:http'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const assert=require('node:assert/strict');
const root=fs.mkdtempSync(path.join(require('./runtime.cjs').scratch,'vscode-integration-')),extensions=path.join(root,'extensions'),userData=path.join(root,'user');
const guardianPath=path.join(extensions,'jupiter-local.claude-clash-guardian-0.1.1');
const targetPath=path.join(extensions,'anthropic.claude-code-fixture');
const probePath=path.join(extensions,'jupiter-local.guardian-probe-0.1.0');
const phaseFile=path.join(root,'phase.json'),resultFile=path.join(root,'result.json'),stateFile=path.join(root,'state.json'),eventsFile=path.join(root,'events.jsonl');
fs.mkdirSync(root,{recursive:true});fs.mkdirSync(extensions,{recursive:true});fs.mkdirSync(path.join(userData,'User'),{recursive:true});
if(fs.existsSync(resultFile))fs.unlinkSync(resultFile);
if(fs.existsSync(eventsFile))fs.unlinkSync(eventsFile);
fs.writeFileSync(phaseFile,JSON.stringify({phase:'initial'}));
fs.cpSync(path.join(require('./runtime.cjs').root,'extension'),guardianPath,{recursive:true});
const flags=path.join(root,'verge.yaml');fs.writeFileSync(flags,'enable_system_proxy: true\nenable_tun_mode: false\n');
const guardSource=fs.readFileSync(path.join(guardianPath,'network-guard.cjs'),'utf8');
fs.writeFileSync(path.join(guardianPath,'network-guard.cjs'),guardSource.replace("const flags = path.join(process.env.APPDATA, 'io.github.clash-verge-rev.clash-verge-rev', 'verge.yaml');",'const flags = '+JSON.stringify(flags)+';'));
fs.writeFileSync(path.join(userData,'User','settings.json'),JSON.stringify({
  'extensions.allowed':{'*':true,'anthropic.claude-code':false,'jupiter-local.claude-clash-guardian':true},
  'extensions.autoUpdate':false,'extensions.autoCheckUpdates':false,'update.mode':'none','telemetry.telemetryLevel':'off',
  'http.proxySupport':process.env.GUARD_TEST_PROXY_SUPPORT || 'override','workbench.startupEditor':'none','security.workspace.trust.enabled':false
},null,2));
const requests=[];
const tlsServer=https.createServer({key:fs.readFileSync(path.join(require('./runtime.cjs').scratch,'test-key.pem')),cert:fs.readFileSync(path.join(require('./runtime.cjs').scratch,'test-cert.pem'))},(req,res)=>{
  requests.push({time:Date.now(),auth:req.headers.authorization});
  fs.appendFileSync(eventsFile,JSON.stringify({kind:'request',time:Date.now(),fakeToken:req.headers.authorization==='Bearer FAKE_INTEGRATION_TOKEN'})+'\n');
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true}));
});
const proxy=http.createServer();proxy.on('connect',(req,socket,head)=>{
  const upstream=net.connect(tlsServer.address().port,'127.0.0.1',()=>{
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);
  });upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());
});
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
function updateState(value){const tmp=stateFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value));fs.renameSync(tmp,stateFile);}
function writePackage(folder,manifest,source){fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'package.json'),JSON.stringify(manifest));fs.writeFileSync(path.join(folder,'extension.js'),source);}
let code;
(async()=>{
  await listen(tlsServer);await listen(proxy);
  updateState({allowed:true,port:proxy.address().port});
  const helperSource=`using System;using System.Diagnostics;using System.IO;using System.Threading;class FixtureState{static int Main(string[] args){if(args.Length!=2||args[0]!="--watch-state")return 1;using(var p=Process.GetProcessById(int.Parse(args[1]))){while(!p.HasExited){try{Console.WriteLine(File.ReadAllText(@"${stateFile}"));Console.Out.Flush();}catch{return 1;}Thread.Sleep(100);}}return 0;}}`;
  fs.writeFileSync(path.join(root,'FixtureState.cs'),helperSource);
  const compile=spawnSync(process.env.CSC_EXE || path.join(process.env.SystemRoot || 'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/out:'+path.join(guardianPath,'ClaudePluginGuard.exe'),path.join(root,'FixtureState.cs')],{encoding:'utf8',windowsHide:true});
  assert.equal(compile.status,0,compile.stdout+compile.stderr);
  const literals={phaseFile,resultFile,stateFile,eventsFile,port:proxy.address().port,url:'https://unit-anthropic.test:'+tlsServer.address().port,cert:path.join(require('./runtime.cjs').scratch,'test-cert.pem')};
  writePackage(targetPath,{name:'claude-code',publisher:'anthropic',displayName:'LOCAL TEST ONLY Claude',version:'0.0.1',engines:{vscode:'^1.96.0'},main:'./extension.js',activationEvents:['*'],contributes:{configuration:{properties:{'claudeCode.claudeProcessWrapper':{type:'string',scope:'machine'},'claudeCode.environmentVariables':{type:'array',scope:'machine',default:[]}}}}},`
const vscode=require('vscode'),https=require('https'),fs=require('fs');const cfg=${JSON.stringify(literals)};let interval;
exports.activate=()=>{fs.appendFileSync(cfg.eventsFile,JSON.stringify({kind:'activated',time:Date.now(),pid:process.pid})+'\\n');function send(){try{const req=https.get(cfg.url+'/api/oauth/profile',{ca:fs.readFileSync(cfg.cert),headers:{Authorization:'Bearer FAKE_INTEGRATION_TOKEN'}},res=>res.resume());req.on('error',()=>{});}catch{}}send();interval=setInterval(send,100);};exports.deactivate=()=>clearInterval(interval);
`);
  writePackage(probePath,{name:'guardian-probe',publisher:'jupiter-local',displayName:'Guardian isolated integration probe',version:'0.1.0',engines:{vscode:'^1.96.0'},main:'./extension.js',activationEvents:['*']},`
const vscode=require('vscode'),fs=require('fs');const cfg=${JSON.stringify(literals)};const delay=ms=>new Promise(r=>setTimeout(r,ms));function write(file,value){const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value));fs.renameSync(tmp,file);}function requests(){if(!fs.existsSync(cfg.eventsFile))return 0;return fs.readFileSync(cfg.eventsFile,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse).filter(e=>e.kind==='request').length;}async function until(fn){for(let i=0;i<80;i++){if(fn())return;await delay(100);}throw Error('Condition timed out.');}
exports.activate=async()=>{try{const phase=JSON.parse(fs.readFileSync(cfg.phaseFile));if(phase.phase==='initial'){await until(()=>requests()>=3);const doc=await vscode.workspace.openTextDocument({content:'TEST_UNSAVED_BUFFER_KEEP'});const editor=await vscode.window.showTextDocument(doc);await editor.edit(edit=>edit.insert(new vscode.Position(0,0),'UNSAVED:'));write(cfg.phaseFile,{phase:'after-restart',uri:doc.uri.toString(),text:doc.getText(),count:requests(),oldPid:process.pid});write(cfg.stateFile,{allowed:false,port:cfg.port});return;}if(phase.phase==='after-restart'){await delay(700);if(process.pid===phase.oldPid)throw Error('Extension host did not restart.');const doc=vscode.workspace.textDocuments.find(d=>d.uri.toString()===phase.uri);if(!doc||doc.getText()!==phase.text)throw Error('Unsaved editor buffer was lost.');const policy=vscode.workspace.getConfiguration('extensions').get('allowed');if(policy['anthropic.claude-code']!==false)throw Error('Claude not disabled.');const before=requests();await delay(500);if(requests()!==before)throw Error('Authenticated fixture requests continued while off.');write(cfg.stateFile,{allowed:true,port:cfg.port});await until(()=>requests()>before+2);write(cfg.resultFile,{success:true,startupEnable:true,requestProxy:true,hostRestart:true,unsavedBufferPreserved:true,offRequestsStopped:true,reenable:true});await vscode.window.showTextDocument(doc);await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');await vscode.commands.executeCommand('workbench.action.closeWindow');}}catch(error){write(cfg.resultFile,{success:false,error:error.stack});await vscode.commands.executeCommand('workbench.action.closeWindow');}};
`);
  const exe=require('./runtime.cjs').codeExe();const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  code=spawn(exe,['--user-data-dir',userData,'--extensions-dir',extensions,'--new-window','--skip-welcome','--skip-release-notes','--disable-workspace-trust'],{env,stdio:'ignore',windowsHide:true});
  const until=Date.now()+45000;
  while(Date.now()<until&&!fs.existsSync(resultFile))await new Promise(resolve=>setTimeout(resolve,500));
  if(!fs.existsSync(resultFile))throw new Error('VS Code integration timed out; inspect isolated logs.');
  const result=JSON.parse(fs.readFileSync(resultFile));assert.equal(result.success,true,result.error);
  assert.ok(requests.length>=6);assert.ok(requests.every(item=>item.auth==='Bearer FAKE_INTEGRATION_TOKEN'));
  console.log(JSON.stringify(result));
  await new Promise(resolve=>setTimeout(resolve,1000));
  tlsServer.close();proxy.close();
})().catch(error=>{console.error(error.stack);code?.kill();tlsServer.close();proxy.close();process.exitCode=1;});
