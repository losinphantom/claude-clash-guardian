const assert=require('node:assert/strict');
const Module=require('node:module');
const path=require('node:path');
const root=path.join(require('./runtime.cjs').root,'extension');
const network=require(path.join(root,'network-guard.cjs'));
const policy=require(path.join(root,'policy.cjs'));
const events=[], settings={extensions:{allowed:{'*':true,[policy.TARGET]:false}},claudeCode:{environmentVariables:[]},claudeClashGuardian:{'privacy.mode':'manual'}};
let allowed=true, active=false;
const guard=network.createNetworkGuard({stateProvider:()=>({allowed,port:7890})});
const originalLoad=Module._load, originalFetch=globalThis.fetch, originalSocket=globalThis.WebSocket;
const state=new Map(),context={subscriptions:[],globalState:{get:key=>state.get(key),async update(key,value){state.set(key,value);}}};
const vscode={
  ConfigurationTarget:{Global:1},StatusBarAlignment:{Right:2},
  workspace:{onDidChangeConfiguration(){return{dispose(){}};},getConfiguration(section){return{get(key,fallback){return settings[section][key]??fallback;},async update(key,value){events.push(section+'.'+key+':'+JSON.stringify(value));settings[section][key]=value;if(section==='extensions'&&key==='allowed')active=!!value[policy.TARGET];}};}},
  extensions:{getExtension(){return{get isActive(){return active;},packageJSON:{main:'./extension.js',contributes:{configuration:{properties:{'claudeCode.claudeProcessWrapper':{}}}}}};}},
  window:{createOutputChannel(){return{appendLine(){},dispose(){}};},createStatusBarItem(){return{show(){},dispose(){}};},showInformationMessage(){return Promise.resolve();}},
  commands:{registerCommand(){return{dispose(){}};},async executeCommand(command){events.push(command);}}
};
Module._load=function(id,parent,isMain){
  if(id==='vscode')return vscode;
  if(id==='./network-guard.cjs' && parent?.filename===path.join(root,'extension.js'))return{createNetworkGuard:()=>guard};
  return originalLoad.call(this,id,parent,isMain);
};
const extension=require(path.join(root,'extension.js'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  const restricted=policy.nextPolicy({'microsoft':true,'some.plugin':false},false);
  assert.equal(restricted['microsoft'],true);assert.equal(restricted['some.plugin'],false);assert.equal(restricted['*'],undefined);
  await extension.activate(context);
  assert.equal(settings.extensions.allowed[policy.TARGET],true);
  const wrapperIndex=events.findIndex(value=>value.startsWith('claudeCode.claudeProcessWrapper:'));
  const enableIndex=events.findIndex(value=>value.startsWith('extensions.allowed:')&&value.includes('"anthropic.claude-code":true'));
  assert.ok(wrapperIndex>=0 && wrapperIndex<enableIndex);
  const privacyEntry=settings.claudeCode.environmentVariables.find(entry=>entry.name==='CLAUDE_GUARD_PRIVACY_JSON');
  assert.equal(JSON.parse(privacyEntry.value).locale,'en-US');
  assert.ok(events.findIndex(value=>value.startsWith('claudeCode.environmentVariables:'))<enableIndex);
  console.log('PASS: companion installs backend gate before enabling the original plugin.');
  allowed=false;await delay(350);
  assert.equal(settings.extensions.allowed[policy.TARGET],false);
  assert.ok(events.includes('workbench.action.reloadWindow'));
  console.log('PASS: switch-off disables Claude before requesting window reload.');
  allowed=true;await delay(350);
  assert.equal(settings.extensions.allowed[policy.TARGET],true);
  console.log('PASS: switch-on permits the official plugin again.');
  await extension.deactivate();
  assert.equal(settings.extensions.allowed[policy.TARGET],false);
  assert.equal(guard.status().allowed,false);
  console.log('PASS: shutdown leaves Claude blocked; unrelated extension policy remains unchanged.');
})().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>{
  guard.dispose();Module._load=originalLoad;globalThis.fetch=originalFetch;globalThis.WebSocket=originalSocket;
});
