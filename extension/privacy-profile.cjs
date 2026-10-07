'use strict';
const crypto=require('node:crypto');
const {validateProfile}=require('./runtime-privacy.cjs');
// A country is not a city. These are documented representative defaults.
const REGIONS={US:['America/New_York','en-US'],CA:['America/Toronto','en-CA'],GB:['Europe/London','en-GB'],JP:['Asia/Tokyo','ja-JP'],SG:['Asia/Singapore','en-SG'],HK:['Asia/Hong_Kong','zh-HK'],TW:['Asia/Taipei','zh-TW'],KR:['Asia/Seoul','ko-KR'],DE:['Europe/Berlin','de-DE'],FR:['Europe/Paris','fr-FR'],NL:['Europe/Amsterdam','nl-NL'],AU:['Australia/Sydney','en-AU'],IN:['Asia/Kolkata','en-IN'],CN:['Asia/Shanghai','zh-CN'],SE:['Europe/Stockholm','sv-SE'],CH:['Europe/Zurich','de-CH'],FI:['Europe/Helsinki','fi-FI'],IT:['Europe/Rome','it-IT'],ES:['Europe/Madrid','es-ES'],BR:['America/Sao_Paulo','pt-BR'],IE:['Europe/Dublin','en-IE']};
function manual(config,seed) {
  return validateProfile({enabled:config.enabled!==false,timeZone:config.timeZone||'Etc/UTC',locale:config.locale||'en-US',maskDeviceInfo:config.maskDeviceInfo!==false,machineId:crypto.createHash('sha256').update('claude-guardian:'+seed).digest('hex'),source:'manual',country:null});
}
exports.manualProfile=manual;
exports.REGIONS=REGIONS;
exports.resolveProfile=async function resolveProfile(config,seed,guard) {
  const fallback=manual(config,seed);
  if(!fallback.enabled||config.mode!=='auto')return fallback;
  if(!guard.status().allowed)return {...fallback,source:'manual-fallback',reason:'Clash 未开启'};
  try {
    // No token, cookie, local machine identifier or third-party geolocation API.
    // The destination is claude.ai itself so Clash applies its claude.ai route.
    const response=await guard.fetch('https://claude.ai/cdn-cgi/trace',{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(4000)});
    if(!response.ok)throw new Error('trace-unavailable');
    const body=await response.text();
    if(body.length>16384)throw new Error('trace-too-large');
    const country=body.match(/^loc=([A-Z]{2})\r?$/m)?.[1];
    const region=REGIONS[country];
    if(!region)throw new Error('country-unmapped');
    return validateProfile({...fallback,timeZone:region[0],locale:region[1],source:'auto-country',country});
  } catch {
    return {...fallback,source:'manual-fallback',reason:'出口国家无法识别，使用手动兜底'};
  }
};
