'use strict';
const TARGET='anthropic.claude-code', SELF='jupiter-local.claude-clash-guardian';
exports.TARGET=TARGET;exports.SELF=SELF;
exports.nextPolicy=(current,allowed)=>{
  const result=current && typeof current==='object' && !Array.isArray(current)?{...current}:{'*':true};
  result[SELF]=true;result[TARGET]=Boolean(allowed);return result;
};
