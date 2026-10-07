'use strict';
// Bun loads this external file before the unmodified Claude entry point.
const {validateProfile,installRuntimePrivacy,scopedOs}=require('./runtime-privacy.cjs');
const raw=process.env.CLAUDE_GUARD_PRIVACY_JSON;
if(raw) {
  const profile=validateProfile(JSON.parse(raw));
  if(profile.enabled) {
    process.env.TZ=profile.timeZone;
    process.env.LANG=profile.locale.replaceAll('-','_')+'.UTF-8';
    process.env.LC_ALL=process.env.LANG;
    if(profile.maskDeviceInfo)process.env.COMPUTERNAME='claude-device';
    installRuntimePrivacy(()=>profile);
    const os=require('node:os'),masked=scopedOs(os,()=>profile);
    os.hostname=masked.hostname;os.cpus=masked.cpus;
    // Node and Bun differ here; the compiled-Bun probe tests its actual imports.
    require('node:module').syncBuiltinESMExports?.();
    if(process.env.CLAUDE_GUARD_PRIVACY_PROBE==='1') {
      const actual=Intl.DateTimeFormat().resolvedOptions();
      if(actual.timeZone!==profile.timeZone||actual.locale!==profile.locale||(profile.maskDeviceInfo&&os.hostname()!=='claude-device'))throw new Error('Privacy preload validation failed');
      process.stdout.write('CLAUDE_GUARD_PRIVACY_READY\n');process.exit(0);
    }
  }
}
