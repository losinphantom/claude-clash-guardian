'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const http=require('node:http'), https=require('node:https'), net=require('node:net');
const guardModule=require('../extension/network-guard.cjs');
const Module=require('node:module');
const scopeModule=require('../extension/network-scope.cjs');
if(!process.env.CLAUDE_EXTENSION_JS) throw new Error('Set CLAUDE_EXTENSION_JS to an unmodified Claude Code 2.1.289 extension.js; the official bundle is not part of this repository.');
const originalPath=path.resolve(process.env.CLAUDE_EXTENSION_JS);
let original=fs.readFileSync(originalPath,'utf8');
if(original.startsWith('/* CLAUDE_PLUGIN_NETWORK_GUARD_V1 */')) throw new Error('Network test requires an unmodified official extension bundle.');
const requests=[], connects=[];
let allowed=false, proxyPort;
const fixture=guardModule.createNetworkGuard({stateProvider:()=>({allowed,port:proxyPort})});
const modules={};
function stub() {
  return new Proxy(function(){}, {
    get(t,key){if(key==='then')return undefined;if(key===Symbol.toPrimitive)return ()=>'';if(key===Symbol.iterator)return function*(){};return stub();},
    apply(){return stub();},construct(){return stub();}
  });
}
const vscode={};
const aliases=[...original.matchAll(/([\w$]+)=(?:C\()?require\("vscode"\)/g)].map(match=>match[1]);
for(const alias of aliases) {
  const escaped=alias.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  for(const match of original.matchAll(new RegExp(escaped+'\\.([A-Za-z_$][\\w$]*)','g'))) vscode[match[1]]=stub();
}
vscode.NotebookCellOutputItem={error:()=>({mime:'application/vnd.code.notebook.error',data:Buffer.alloc(0)})};
const guardedFs=Object.assign({},fs,{readFileSync(file,...args){if(/credentials|\.claude\.json|state\.vscdb/i.test(String(file)))throw new Error('Real credential reads prohibited in this test.');return fs.readFileSync(file,...args);}});
const originalLoad=Module._load;
Module._load=function(id,parent,isMain){
  if(scopeModule.targetFile(parent?.filename)) {
    if(id==='vscode')return vscode;
    if(id==='fs')return guardedFs;
    if(id==='os')return {...require('node:os'),homedir:()=>path.join(require('./runtime.cjs').scratch,'test-home')};
  }
  return originalLoad.call(this,id,parent,isMain);
};
const scope=scopeModule.installNetworkScope(fixture);
const testParent={filename:originalPath,paths:Module._nodeModulePaths(path.dirname(originalPath))};
const customRequire=id=>Module._load(id,testParent,false);
Object.assign(customRequire,require);
const source=original+'\nmodule.exports.__testAxios=l8;module.exports.__testWS=xC();module.exports.__testFetch=(url,init)=>fetch(url,init);module.exports.__testGlobalWS=(url,options)=>new WebSocket(url,options);';
const moduleFixture={exports:{}};
const context={fetch:(...args)=>globalThis.fetch(...args),WebSocket:class {constructor(...args){return new globalThis.WebSocket(...args);}},require:customRequire,module:moduleFixture,exports:moduleFixture.exports,__filename:originalPath,__dirname:path.dirname(originalPath),console,Buffer,URL,URLSearchParams,Request,Response,Headers,ReadableStream,TextEncoder,TextDecoder,AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,setInterval,clearInterval,setImmediate,clearImmediate,queueMicrotask,process:Object.assign(Object.create(process),{env:{USERPROFILE:path.join(require('./runtime.cjs').scratch,'test-home'),APPDATA:path.join(require('./runtime.cjs').scratch,'test-home'),HOME:path.join(require('./runtime.cjs').scratch,'test-home')}})};
context.global=context;context.globalThis=context;
try {vm.runInNewContext(source,context,{filename:originalPath,timeout:20000});}
catch(error){console.error(String(error));console.error(error.stack.split('\n').filter(line=>line.trim().startsWith('at ')).slice(0,3).join('\n'));fixture.dispose();process.exit(1);}
const axios=moduleFixture.exports.__testAxios, WS=moduleFixture.exports.__testWS;
const stockFetch=moduleFixture.exports.__testFetch;
const tlsServer=https.createServer({key:fs.readFileSync(path.join(require('./runtime.cjs').scratch,'test-key.pem')),cert:fs.readFileSync(path.join(require('./runtime.cjs').scratch,'test-cert.pem'))},(req,res)=>{
  let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    requests.push({path:req.url,auth:req.headers.authorization,body});
    if(req.url==='/slow'){res.writeHead(200);res.write('first');req.once('close',()=>res.end());return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({organization:{uuid:'TEST_ORG'},ok:true}));
  });
});
tlsServer.on('upgrade',(req,socket,head)=>{
  requests.push({path:req.url,auth:req.headers.authorization});
  const accept=require('node:crypto').createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  let buffered=head;
  socket.on('data',chunk=>{
    buffered=Buffer.concat([buffered,chunk]);
    if(buffered.length<6)return;
    const opcode=buffered[0]&15,length=buffered[1]&127;
    if(length>125 || buffered.length<6+length)return;
    const mask=buffered.subarray(2,6), payload=Buffer.from(buffered.subarray(6,6+length));
    for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];
    buffered=buffered.subarray(6+length);
    if(opcode===8){socket.end(Buffer.from([0x88,0]));return;}
    socket.write(Buffer.concat([Buffer.from([0x81,payload.length]),payload]));
  });
  socket.on('error',()=>{});
});
const proxy=http.createServer();
proxy.on('connect',(req,socket,head)=>{
  connects.push(req.url);
  const upstream=net.connect(tlsServer.address().port,'127.0.0.1',()=>{
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if(head.length)upstream.write(head);
    socket.pipe(upstream);upstream.pipe(socket);
  });
  upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());
  socket.on('close',()=>upstream.destroy());
});
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  await listen(tlsServer);await listen(proxy);proxyPort=proxy.address().port;
  const url='https://unit-anthropic.test:'+tlsServer.address().port;
  const auth='Bearer FAKE_TEST_TOKEN';
  const closed=()=>axios.get(url+'/api/oauth/profile',{headers:{Authorization:auth},proxy:false,timeout:2000});
  await assert.rejects(closed,/network blocked/);
  assert.equal(connects.length,0);assert.equal(requests.length,0);
  console.log('PASS: UNMODIFIED bundled Axios proxy:false sends no token or connection while disabled.');
  allowed=true;
  const profile=await closed();assert.equal(profile.data.organization.uuid,'TEST_ORG');
  assert.equal(requests.at(-1).auth,auth);assert.equal(connects.length,1);
  await axios.post(url+'/v1/oauth/token',{grant_type:'refresh_token',refresh_token:'FAKE_REFRESH_TOKEN'},{proxy:false,timeout:2000});
  assert.ok(requests.at(-1).body.includes('FAKE_REFRESH_TOKEN'));assert.equal(connects.length,2);
  console.log('PASS: simulated profile and token-refresh requests use local CONNECT proxy and verified TLS.');
  const response=await stockFetch(url+'/fetch',{headers:{Authorization:auth}});assert.equal((await response.json()).ok,true);
  assert.equal(connects.length,3);
  console.log('PASS: fetch also uses the local proxy.');
  const Socket=WS;
  const socket=new Socket('wss://unit-anthropic.test:'+tlsServer.address().port+'/socket',{headers:{Authorization:auth}});
  await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  assert.equal(requests.at(-1).auth,auth);assert.equal(connects.length,4);
  socket.send('test');const echoed=await new Promise(resolve=>socket.once('message',resolve));assert.equal(echoed.toString(),'test');
  console.log('PASS: authenticated WebSocket uses local CONNECT proxy.');
  await axios.get(url+'/override-proxy',{headers:{Authorization:auth},proxy:{host:'unreachable.proxy.test',port:1,protocol:'http'},timeout:2000});
  assert.equal(requests.at(-1).path,'/override-proxy');assert.equal(requests.at(-1).auth,auth);
  await axios.get(url+'/fetch-adapter',{headers:{Authorization:auth},adapter:'fetch',proxy:false,timeout:2000});
  assert.equal(requests.at(-1).path,'/fetch-adapter');
  await assert.rejects(axios.get('https://wrong-host.test:'+tlsServer.address().port+'/tls-mismatch',{proxy:false,timeout:2000}),/certificate|Hostname|AltName|altnames/i);
  console.log('PASS: per-request proxy override cannot bypass local proxy; TLS hostname validation remains enabled.');
  const closePromise=new Promise(resolve=>socket.once('close',resolve));allowed=false;
  await Promise.race([closePromise,delay(1500).then(()=>{throw new Error('Socket was not terminated after switch-off.');})]);
  const before={connects:connects.length,requests:requests.length};
  await assert.rejects(closed,/network blocked/);
  await assert.rejects(stockFetch(url+'/fetch'),/network blocked/);
  assert.throws(()=>new Socket('wss://unit-anthropic.test:'+tlsServer.address().port),/network blocked/);
  await delay(150);assert.equal(connects.length,before.connects);assert.equal(requests.length,before.requests);
  console.log('PASS: switch-off closes existing socket and rejects new Axios/fetch/WebSocket traffic.');
  const scopedNet=fixture.wrapRequire(require)('net');
  assert.throws(()=>scopedNet.connect(443,'unit-anthropic.test'),/network blocked/);
  assert.throws(()=>new scopedNet.Socket().connect(443,'unit-anthropic.test'),/network blocked/);
  console.log('PASS: raw non-loopback sockets cannot bypass the guard.');
  // Other modules retain their original networking objects.
  assert.equal(require('node:http'),http);assert.notEqual(fixture.wrapRequire(require)('http'),http);
  console.log('PASS: guard changes only extension-scoped module imports.');
  let browserOpens=0;
  const realVSCode={env:{openExternal:async()=>{browserOpens++;return true;}}};
  const browserGuard=guardModule.createNetworkGuard({stateProvider:()=>({allowed,port:proxyPort})});
  const scopedVSCode=browserGuard.wrapRequire(id=>id==='vscode'?realVSCode:require(id))('vscode');
  await assert.rejects(scopedVSCode.env.openExternal('https://claude.ai/'),/network blocked/);
  assert.equal(browserOpens,0);
  allowed=true;await scopedVSCode.env.openExternal('https://claude.ai/');assert.equal(browserOpens,1);
  browserGuard.dispose();
  console.log('PASS: extension cannot open an external login page while disabled.');
  scope.uninstall();Module._load=originalLoad;fixture.dispose();tlsServer.close();proxy.close();
})().catch(error=>{console.error(error.stack);scope.uninstall();Module._load=originalLoad;fixture.dispose();tlsServer.close();proxy.close();process.exitCode=1;});
