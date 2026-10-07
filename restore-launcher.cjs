'use strict';
const fs=require('node:fs'),path=require('node:path');
const jsonc=require('./node_modules/jsonc-parser');
const install=__dirname;
const before=JSON.parse(fs.readFileSync(path.join(install,'settings-before.json'),'utf8').replace(/^\uFEFF/,''));
const file=path.join(process.env.APPDATA,'Code','User','settings.json');
let text=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''),errors=[];
const current=jsonc.parse(text,errors,{allowTrailingComma:true});if(errors.length)throw new Error('Cannot restore malformed settings.');
const keys=['claudeCode.claudeProcessWrapper','claudeCode.environmentVariables'];
for(const key of keys)text=jsonc.applyEdits(text,jsonc.modify(text,[key],before[key],{formattingOptions:{insertSpaces:true,tabSize:4}}));
let allowed=current['extensions.allowed'];
if(allowed&&typeof allowed==='object'&&!Array.isArray(allowed)) {
  allowed={...allowed};const old=before['extensions.allowed'];
  for(const key of ['anthropic.claude-code','jupiter-local.claude-clash-guardian']) {
    if(old&&typeof old==='object'&&Object.hasOwn(old,key))allowed[key]=old[key];else delete allowed[key];
  }
  if(old===undefined&&Object.keys(allowed).length===1&&allowed['*']===true)allowed=undefined;
  text=jsonc.applyEdits(text,jsonc.modify(text,['extensions.allowed'],allowed,{formattingOptions:{insertSpaces:true,tabSize:4}}));
}
const tmp=file+'.guardian-restore.tmp';fs.writeFileSync(tmp,text);fs.renameSync(tmp,file);
console.log('Restored guardian-owned Claude settings and permission entries.');
