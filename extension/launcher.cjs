'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const jsonc=require('./node_modules/jsonc-parser');
const {nextPolicy}=require('./policy.cjs');
const args=process.argv.slice(2);
const dataIndex=args.indexOf('--user-data-dir');
const dataRoot=dataIndex>=0?path.resolve(args[dataIndex+1]):path.join(process.env.APPDATA,'Code');
const settings=path.join(dataRoot,'User','settings.json');
function lockBeforeStart() {
  const text=fs.existsSync(settings)?fs.readFileSync(settings,'utf8').replace(/^\uFEFF/,''):'{}';
  const errors=[],parsed=jsonc.parse(text,errors,{allowTrailingComma:true});
  if(errors.length)throw new Error('VS Code 设置存在 JSON 错误，不能安全锁定 Claude。请先修复 settings.json。');
  const value=nextPolicy(parsed?.['extensions.allowed'],false);
  const edits=jsonc.modify(text,['extensions.allowed'],value,{formattingOptions:{insertSpaces:true,tabSize:4,eol:text.includes('\r\n')?'\r\n':'\n'}});
  const updated=jsonc.applyEdits(text,edits);
  const temporary=settings+'.claude-guardian.tmp';
  fs.mkdirSync(path.dirname(settings),{recursive:true});fs.writeFileSync(temporary,updated);fs.renameSync(temporary,settings);
}
try {
  if(args.includes('--lock-only')){lockBeforeStart();console.log('Claude locked before extension-host startup.');process.exit(0);}
  const manage=['--help','-h','--version','-v','--list-extensions','--install-extension','--uninstall-extension','--update-extensions','--status','-s','--locate-shell-integration-path','--telemetry'];
  if(!args.some(arg=>manage.includes(arg)))lockBeforeStart();
  const exe=process.env.CLAUDE_GUARD_CODE_EXE || path.join(process.env.LOCALAPPDATA,'Programs','Microsoft VS Code','Code.exe');
  const env={...process.env,ELECTRON_RUN_AS_NODE:'1'};
  if(args.includes('--gate-dry-run')){console.log(JSON.stringify({code:exe,args:args.filter(arg=>arg!=='--gate-dry-run'),locked:true}));process.exit(0);}
  const root=path.dirname(exe),cmd=fs.readFileSync(path.join(root,'bin','code.cmd'),'utf8');
  const match=cmd.match(/"%~dp0\.\.\\([^"\r\n]+\\resources\\app\\out\\cli\.js)"/i);
  if(!match)throw new Error('无法定位当前 VS Code CLI，保持锁定。');
  const cli=path.join(root,match[1]);
  const child=spawn(exe,[cli,...args],{env,stdio:'inherit',windowsHide:true});
  child.once('error',error=>{console.error(error.message);process.exitCode=1;});
  child.once('exit',code=>{process.exitCode=code || 0;});
} catch(error){console.error(error.message);process.exitCode=1;}
