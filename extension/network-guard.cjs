'use strict';
// Scoped to the official extension module; never changes global networking APIs.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const {spawn} = require('node:child_process');
const {urlToHttpOptions} = require('node:url');
const {Readable} = require('node:stream');
const {scopedOs}=require('./runtime-privacy.cjs');

exports.createNetworkGuard = function createNetworkGuard(options = {}) {
  const active = new Set();
  let state = {allowed:false, port:-1}, seen = 0, watcher, disposed=false;
  let markReady;
  const initialized=options.stateProvider?Promise.resolve():new Promise(resolve=>{markReady=resolve;const timeout=setTimeout(resolve,1500);timeout.unref();});
  const install = options.installDir || path.join(process.env.LOCALAPPDATA, 'ClaudePluginGuard');
  const flags = path.join(process.env.APPDATA, 'io.github.clash-verge-rev.clash-verge-rev', 'verge.yaml');
  function denied() { const e = new Error('Claude plugin network blocked: Clash system proxy and TUN must not both be off.'); e.code='ECLAUDEPROXYDISABLED'; return e; }
  function local(host) {
    host = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || (net.isIP(host) === 4 && host.startsWith('127.'));
  }
  function permitted() {
    if(disposed)return false;
    if (options.stateProvider) { state=options.stateProvider(); return state.allowed && state.port>0; }
    if (!state.allowed || state.port<1 || Date.now()-seen>1500) return false;
    try {
      const text=fs.readFileSync(flags, 'utf8');
      return /^(?:enable_system_proxy|enable_tun_mode):[ \t]*true[ \t]*(?:#.*)?\r?$/m.test(text);
    } catch { return false; }
  }
  function track(item) {
    active.add(item); item.once('close', () => active.delete(item)); return item;
  }
  function stop() { for(const item of active) item.destroy(denied()); active.clear(); }
  if (!options.stateProvider) {
    watcher=spawn(path.join(install,'ClaudePluginGuard.exe'), ['--watch-state',String(process.pid)], {windowsHide:true, stdio:['ignore','pipe','ignore']});
    let buffer='';
    watcher.stdout.on('data', chunk => {
      buffer+=chunk.toString();
      while(buffer.includes('\n')) {
        const end=buffer.indexOf('\n'), line=buffer.slice(0,end); buffer=buffer.slice(end+1);
        try { state=JSON.parse(line); seen=Date.now(); markReady?.(); if(!state.allowed) stop(); } catch { state.allowed=false; markReady?.(); stop(); }
      }
    });
    watcher.on('error', () => {state.allowed=false;markReady?.();stop();});
    watcher.on('exit', () => {state.allowed=false;markReady?.();stop();});
    watcher.unref(); watcher.stdout.unref?.();
  }
  const timer=setInterval(() => {if(!permitted()) stop();},100); timer.unref();
  function assertAllowed() {if(!permitted()) throw denied();}
  function tunnel(destination, secure, callback) {
    try {assertAllowed();} catch(e) {queueMicrotask(() => callback(e));return;}
    const host=String(destination.hostname || destination.host || 'localhost').replace(/^\[|\]$/g,'');
    const port=Number(destination.port || (secure?443:80));
    const authority=(host.includes(':')?'['+host+']':host)+':'+port;
    const connect=track(new http.ClientRequest({host:'127.0.0.1',port:state.port,method:'CONNECT',path:authority,headers:{Host:authority},agent:new http.Agent({keepAlive:false})}));
    let finished=false;
    const done=(error,socket) => {if(finished){if(socket) socket.destroy();return;} finished=true;callback(error,socket);};
    connect.setTimeout(10000,()=>connect.destroy(new Error('Local Clash proxy connection timed out.')));
    connect.once('error', error=>done(error));
    connect.once('response',()=>connect.destroy(new Error('Local proxy refused CONNECT.')));
    connect.once('connect',(response,socket,head)=>{
      if(response.statusCode!==200){socket.destroy();done(new Error('Local proxy refused CONNECT.'));return;}
      try {assertAllowed();} catch(e){socket.destroy();done(e);return;}
      if(head.length) socket.unshift(head);
      if(!secure){track(socket);done(null,socket);return;}
      const encrypted=track(tls.connect({...destination,socket,servername:destination.servername || (net.isIP(host)?undefined:host)}));
      encrypted.once('error',error=>done(error));
      encrypted.once('secureConnect',()=>{try{assertAllowed();done(null,encrypted);}catch(e){encrypted.destroy();done(e);}});
    });
    connect.end();
  }
  class PlainAgent extends http.Agent {createConnection(opts,cb){tunnel(opts,false,cb);}}
  class SecureAgent extends https.Agent {createConnection(opts,cb){tunnel(opts,true,cb);}}
  const plainAgent=new PlainAgent({keepAlive:false}), secureAgent=new SecureAgent({keepAlive:false});
  function normalize(input, extra, fallback) {
    let opts;
    if(typeof input==='string' || input instanceof URL) opts=urlToHttpOptions(new URL(input));
    else opts={...input};
    if(extra && typeof extra==='object') opts={...opts,...extra};
    opts.protocol=opts.protocol || fallback;
    if(/^https?:\/\//i.test(opts.path || '')) {
      const target=urlToHttpOptions(new URL(opts.path));
      opts={...opts,...target,headers:{...opts.headers}};
      for(const key of Object.keys(opts.headers)) if(key.toLowerCase()==='proxy-authorization') delete opts.headers[key];
    }
    return opts;
  }
  function request(fallback,input,extra,callback) {
    if(typeof extra==='function'){callback=extra;extra=undefined;}
    const opts=normalize(input,extra,fallback);
    const remote=!opts.socketPath && !local(opts.hostname || opts.host || 'localhost');
    if(remote){assertAllowed();opts.agent=opts.protocol==='https:'?secureAgent:plainAgent;delete opts.createConnection;}
    const implementation=opts.protocol==='https:'?https:http;
    // VS Code's proxySupport=override can replace a custom agent in request().
    // Use the native ClientRequest constructor with our explicit tunnel agent.
    const req=remote?new http.ClientRequest(opts,callback):implementation.request(opts,callback);
    if(remote) track(req);
    return req;
  }
  const modules={};
  for(const [name,original] of [['http',http],['https',https]]) {
    const clone=Object.assign(Object.create(Object.getPrototypeOf(original)),original);
    clone.request=(input,extra,callback)=>request(name+':',input,extra,callback);
    clone.get=(input,extra,callback)=>{const req=clone.request(input,extra,callback);req.end();return req;};
    modules[name]=clone;
  }
  function allowedSocket(args) {
    const first=args[0];
    if(typeof first==='object') {
      if(first.path || first.socket) return true;
      return local(first.host || first.hostname || 'localhost');
    }
    if(typeof first==='string' && !/^\d+$/.test(first)) return true; // Named pipe.
    return local(typeof args[1]==='string'?args[1]:'localhost');
  }
  for(const [name,original] of [['net',net],['tls',tls]]) {
    const clone=Object.assign(Object.create(Object.getPrototypeOf(original)),original);
    clone.connect=clone.createConnection=(...args)=>{if(!allowedSocket(args)) throw denied();return original.connect(...args);};
    if(name==='net') clone.Socket=class ScopedSocket extends net.Socket {connect(...args){if(!allowedSocket(args)) throw denied();return super.connect(...args);}};
    modules[name]=clone;
  }
  async function scopedFetch(input, init, count=0) {
    await initialized;
    const original=new Request(input,init), url=new URL(original.url);
    if(!local(url.hostname)) assertAllowed();
    const body=['GET','HEAD'].includes(original.method)?null:Buffer.from(await original.arrayBuffer());
    return new Promise((resolve,reject)=>{
      let req;
      try {
        req=request(url.protocol,url,{method:original.method,headers:Object.fromEntries(original.headers),signal:original.signal},response=>{
          const location=response.headers.location;
          if(location && [301,302,303,307,308].includes(response.statusCode) && original.redirect!=='manual') {
            response.resume();
            if(original.redirect==='error' || count>=20){reject(new Error('Redirect refused.'));return;}
            const target=new URL(location,url), headers=new Headers(original.headers);
            if(target.origin!==url.origin){headers.delete('authorization');headers.delete('cookie');}
            const get=response.statusCode===303 || ([301,302].includes(response.statusCode)&&original.method==='POST');
            scopedFetch(target,{method:get?'GET':original.method,headers,body:get?undefined:body,signal:original.signal,redirect:original.redirect},count+1).then(resolve,reject);return;
          }
          const noBody=original.method==='HEAD' || [204,205,304].includes(response.statusCode);
          const result=new Response(noBody?null:Readable.toWeb(response),{status:response.statusCode,statusText:response.statusMessage,headers:response.headers});
          Object.defineProperty(result,'url',{value:original.url});
          if(noBody) response.resume();
          resolve(result);
        });
      } catch(e){reject(e);return;}
      req.once('error',reject); req.end(body);
    });
  }
  let scopedVSCode;
  function scopedRequire(original) {
    const scoped=id=>{
      const name=id.replace(/^node:/,'');
      if(modules[name]) return modules[name];
      if(name==='os'&&options.getProfile)return scopedOs(original(id),options.getProfile);
      if(name==='module') return Object.assign(Object.create(original(id)), {createRequire:(...args)=>scopedRequire(original(id).createRequire(...args))});
      if(name==='vscode') {
        if(scopedVSCode) return scopedVSCode;
        const real=original(id), descriptors=Object.getOwnPropertyDescriptors(real);
        delete descriptors.env;
        scopedVSCode=Object.defineProperties({},descriptors);
        const envDescriptors=Object.getOwnPropertyDescriptors(real.env || {});
        delete envDescriptors.openExternal;
        if(options.getProfile) {
          delete envDescriptors.machineId;delete envDescriptors.language;
        }
        const env=Object.defineProperties({},envDescriptors);
        if(options.getProfile) {
          Object.defineProperty(env,'machineId',{enumerable:true,get:()=>{const p=options.getProfile();return p?.enabled&&p.maskDeviceInfo?p.machineId:real.env.machineId;}});
          Object.defineProperty(env,'language',{enumerable:true,get:()=>{const p=options.getProfile();return p?.enabled?p.locale:real.env.language;}});
        }
        Object.defineProperty(env,'openExternal',{enumerable:true,value:async(uri,...args)=>{
          await initialized;
          const url=new URL(String(uri));
          if(['http:','https:'].includes(url.protocol)&&!local(url.hostname)) assertAllowed();
          return real.env.openExternal(uri,...args);
        }});
        Object.defineProperty(scopedVSCode,'env',{enumerable:true,value:env});
        return scopedVSCode;
      }
      return original(id);
    };
    Object.assign(scoped,original);return scoped;
  }
  return {
    wrapRequire(original) {
      return scopedRequire(original);
    },
    fetch:scopedFetch,
    ready(){return initialized;},
    makeWebSocket(WebSocket) {
      return class ScopedWebSocket extends WebSocket {
        constructor(url,protocols,opts) {
          const target=new URL(url), remote=!local(target.hostname);
          if(remote) assertAllowed();
          if(protocols && typeof protocols==='object' && !Array.isArray(protocols)){opts=protocols;protocols=undefined;}
          super(url,protocols,{...opts,...remote?{agent:target.protocol==='wss:'?secureAgent:plainAgent}:{}});
          if(remote) {active.add(this);this.once('close',()=>active.delete(this));}
        }
        destroy(){this.terminate();}
      };
    },
    dispose(){disposed=true;state.allowed=false;clearInterval(timer);stop();plainAgent.destroy();secureAgent.destroy();watcher?.kill();},
    status(){return {allowed:permitted(),port:state.port};}
  };
};
