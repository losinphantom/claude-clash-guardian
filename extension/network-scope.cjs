'use strict';
const Module=require('node:module');
const ws=require('./node_modules/ws');
const {installRuntimePrivacy}=require('./runtime-privacy.cjs');

function targetFile(file) {
  return /[\\/]anthropic\.claude-code-[^\\/]+[\\/]/i.test(String(file || ''));
}
exports.targetFile=targetFile;
exports.installNetworkScope=function installNetworkScope(guard,getProfile=()=>({enabled:false})) {
  const originalLoad=Module._load, originalFetch=globalThis.fetch, originalSocket=globalThis.WebSocket;
  const ScopedSocket=guard.makeWebSocket(ws);
  function callerIsTarget() {return targetFile(new Error().stack);}
  const privacy=installRuntimePrivacy(getProfile,callerIsTarget);
  const loader=function(request,parent,isMain) {
    if(targetFile(parent?.filename)) {
      const original=id=>originalLoad.call(this,id,parent,isMain);
      return guard.wrapRequire(original)(request);
    }
    return originalLoad.call(this,request,parent,isMain);
  };
  const fetcher=function(...args) {
    return callerIsTarget()?guard.fetch(...args):originalFetch.apply(this,args);
  };
  let Socket;
  if(typeof originalSocket==='function') {
    Socket=class extends originalSocket {
      constructor(...args) {
        if(callerIsTarget()) return new ScopedSocket(...args);
        return Reflect.construct(originalSocket,args,new.target);
      }
    };
  }
  Module._load=loader;
  if(typeof originalFetch==='function') globalThis.fetch=fetcher;
  if(Socket) globalThis.WebSocket=Socket;
  return {
    uninstall() {
      privacy.uninstall();
      if(Module._load===loader)Module._load=originalLoad;
      if(globalThis.fetch===fetcher)globalThis.fetch=originalFetch;
      if(Socket && globalThis.WebSocket===Socket)globalThis.WebSocket=originalSocket;
    }
  };
};
