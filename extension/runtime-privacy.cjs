'use strict';
// API-level metadata normalization, not an operating-system sandbox.
const NativeDate=Date, NativeFormat=Intl.DateTimeFormat;
const nativeGetTime=NativeDate.prototype.getTime;
const formats=new Map();
function validateProfile(profile) {
  if(!profile?.enabled)return {...profile,enabled:false};
  const timeZone=new NativeFormat('en-US',{timeZone:profile.timeZone}).resolvedOptions().timeZone;
  const locale=Intl.getCanonicalLocales(profile.locale)[0];
  if(!locale || !NativeFormat.supportedLocalesOf([locale]).length)throw new Error('Unsupported privacy locale');
  return {...profile,timeZone,locale};
}
function parts(date,zone) {
  const epoch=nativeGetTime.call(date);
  if(!Number.isFinite(epoch))return null;
  let format=formats.get(zone);
  if(!format){format=new NativeFormat('en-US',{timeZone:zone,calendar:'gregory',numberingSystem:'latn',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});formats.set(zone,format);}
  const values=Object.fromEntries(format.formatToParts(date).map(part=>[part.type,part.value]));
  return {year:+values.year,month:+values.month-1,day:+values.day,hour:+values.hour,minute:+values.minute,second:+values.second,millisecond:((epoch%1000)+1000)%1000};
}
function shadow(date,zone) {
  const p=parts(date,zone);
  if(!p)return new NativeDate(NaN);
  const result=new NativeDate(0);
  result.setUTCFullYear(p.year,p.month,p.day);result.setUTCHours(p.hour,p.minute,p.second,p.millisecond);
  return result;
}
function fromLocal(epoch,zone) {
  let actual=epoch;
  // Resolve the selected zone's offset, including changes across DST boundaries.
  for(let i=0;i<3;i++){const shift=nativeGetTime.call(shadow(new NativeDate(actual),zone))-actual;const next=epoch-shift;if(next===actual)break;actual=next;}
  return actual;
}
function localParse(text,zone) {
  if(typeof text!=='string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?$/.test(text))return NativeDate.parse(text);
  return fromLocal(NativeDate.parse(text+'Z'),zone);
}
exports.validateProfile=validateProfile;
exports.installRuntimePrivacy=function installRuntimePrivacy(getProfile,applies=()=>true) {
  const undos=[];
  function profile(){const value=getProfile();return value?.enabled&&applies()?value:null;}
  function replace(object,key,value) {
    const descriptor=Object.getOwnPropertyDescriptor(object,key);
    Object.defineProperty(object,key,{...descriptor,value});
    undos.push(()=>Object.defineProperty(object,key,descriptor));
  }
  for(const name of ['DateTimeFormat','NumberFormat','RelativeTimeFormat','Collator','PluralRules','ListFormat','DisplayNames','Segmenter']) {
    const original=Intl[name];if(typeof original!=='function')continue;
    function argsFor(args){const p=profile();if(!p)return args;const next=[...args];if(next[0]===undefined||next[0]===null)next[0]=p.locale;if(name==='DateTimeFormat')next[1]={...next[1],timeZone:next[1]?.timeZone??p.timeZone};return next;}
    const wrapped=new Proxy(original,{apply(target,receiver,args){return Reflect.apply(target,receiver,argsFor(args));},construct(target,args,newTarget){return Reflect.construct(target,argsFor(args),newTarget===wrapped?target:newTarget);}});
    replace(Intl,name,wrapped);
  }
  const getters={getFullYear:'getUTCFullYear',getYear:null,getMonth:'getUTCMonth',getDate:'getUTCDate',getDay:'getUTCDay',getHours:'getUTCHours',getMinutes:'getUTCMinutes',getSeconds:'getUTCSeconds'};
  for(const [name,utc] of Object.entries(getters)) {
    const original=NativeDate.prototype[name];
    replace(NativeDate.prototype,name,function(...args){const p=profile();if(!p)return original.apply(this,args);const converted=shadow(this,p.timeZone);return utc?converted[utc]():converted.getUTCFullYear()-1900;});
  }
  const originalOffset=NativeDate.prototype.getTimezoneOffset;
  replace(NativeDate.prototype,'getTimezoneOffset',function(){const p=profile();return p?(nativeGetTime.call(this)-nativeGetTime.call(shadow(this,p.timeZone)))/60000:originalOffset.call(this);});
  for(const [name,utc] of Object.entries({setFullYear:'setUTCFullYear',setMonth:'setUTCMonth',setDate:'setUTCDate',setHours:'setUTCHours',setMinutes:'setUTCMinutes',setSeconds:'setUTCSeconds',setMilliseconds:'setUTCMilliseconds'})) {
    const original=NativeDate.prototype[name];
    replace(NativeDate.prototype,name,function(...args){const p=profile();if(!p)return original.apply(this,args);const converted=shadow(this,p.timeZone);const value=converted[utc](...args);return this.setTime(fromLocal(value,p.timeZone));});
  }
  for(const name of ['toLocaleString','toLocaleDateString','toLocaleTimeString']) {
    const original=NativeDate.prototype[name];
    replace(NativeDate.prototype,name,function(locale,options){const p=profile();return p?original.call(this,locale??p.locale,{...options,timeZone:options?.timeZone??p.timeZone}):original.call(this,locale,options);});
  }
  for(const name of ['toString','toDateString','toTimeString']) {
    const original=NativeDate.prototype[name];
    replace(NativeDate.prototype,name,function(){const p=profile();if(!p)return original.call(this);const converted=shadow(this,p.timeZone);if(!Number.isFinite(nativeGetTime.call(converted)))return 'Invalid Date';const value=converted.toUTCString();const date=value.slice(0,3)+' '+value.slice(8,11)+' '+value.slice(5,7)+' '+value.slice(12,16);const offset=(nativeGetTime.call(converted)-nativeGetTime.call(this))/60000,absolute=Math.abs(offset),pad=number=>String(Math.floor(number)).padStart(2,'0');const time=value.slice(17,25)+' GMT'+(offset<0?'-':'+')+pad(absolute/60)+pad(absolute%60)+' ('+p.timeZone+')';return name==='toDateString'?date:name==='toTimeString'?time:date+' '+time;});
  }
  const wrappedDate=new Proxy(NativeDate,{
    apply(target,receiver,args){return profile()?new NativeDate().toString():Reflect.apply(target,receiver,args);},
    construct(target,args,newTarget){const p=profile();let next=args;if(p&&args.length>1){next=[fromLocal(NativeDate.UTC(...args),p.timeZone)];}else if(p&&args.length===1&&typeof args[0]==='string'){next=[localParse(args[0],p.timeZone)];}return Reflect.construct(target,next,newTarget===wrappedDate?target:newTarget);},
    get(target,key,receiver){if(key==='parse')return text=>{const p=profile();return p?localParse(text,p.timeZone):target.parse(text);};return Reflect.get(target,key,receiver);}
  });
  replace(globalThis,'Date',wrappedDate);
  return {uninstall(){for(const undo of undos.reverse())undo();}};
};
exports.scopedOs=function scopedOs(original,getProfile) {
  const clone={...original};
  const hostname=original.hostname.bind(original),cpus=original.cpus.bind(original);
  clone.hostname=()=>getProfile()?.enabled&&getProfile().maskDeviceInfo?'claude-device':hostname();
  clone.cpus=()=>getProfile()?.enabled&&getProfile().maskDeviceInfo?cpus().map(cpu=>({...cpu,model:'Generic CPU'})):cpus();
  return clone;
};
