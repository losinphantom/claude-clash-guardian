'use strict';
const vscode=require('vscode');
const path=require('node:path');
const fs=require('node:fs');
const {createNetworkGuard}=require('./network-guard.cjs');
const {installNetworkScope}=require('./network-scope.cjs');
const {TARGET,nextPolicy}=require('./policy.cjs');
const jsonc=require('./node_modules/jsonc-parser');
const crypto=require('node:crypto');
const {manualProfile,resolveProfile}=require('./privacy-profile.cjs');
let guard, timer, disposed=false, queue=Promise.resolve(), lastAllowed, output, status, scope;
let privacy={enabled:false},privacyConfig,privacySeed,activationContext;
function readPrivacyConfig() {
  const config=vscode.workspace.getConfiguration('claudeClashGuardian');
  return {enabled:config.get('privacy.enabled',true),mode:config.get('privacy.mode','auto'),timeZone:config.get('privacy.timeZone','Etc/UTC'),locale:config.get('privacy.locale','en-US'),maskDeviceInfo:config.get('privacy.maskDeviceInfo',true)};
}
async function configurePrivacy() {
  const next=await resolveProfile(privacyConfig,privacySeed,guard);
  const changed=['enabled','timeZone','locale','maskDeviceInfo','machineId'].some(key=>privacy[key]!==next[key]);
  if(changed&&vscode.extensions.getExtension(TARGET)?.isActive){await reloadForPrivacy();return;}
  privacy=next;
  const config=vscode.workspace.getConfiguration('claudeCode');
  const managed=new Set(['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC','DISABLE_TELEMETRY','DISABLE_ERROR_REPORTING','CLAUDE_GUARD_PRIVACY_JSON']);
  const entries=config.get('environmentVariables',[]).filter(entry=>!managed.has(String(entry.name).toUpperCase()));
  for(const name of ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC','DISABLE_TELEMETRY','DISABLE_ERROR_REPORTING'])entries.push({name,value:'1'});
  if(privacy.enabled)entries.push({name:'CLAUDE_GUARD_PRIVACY_JSON',value:JSON.stringify(privacy)});
  await updateClaudeSetting(activationContext,'environmentVariables',entries);
  output.appendLine(privacy.enabled?'隐私模式：'+privacy.source+'；'+privacy.timeZone+'；'+privacy.locale+(privacy.country?'；国家 '+privacy.country:'')+(privacy.reason?'；'+privacy.reason:''):'隐私模式已关闭。');
}
async function reloadForPrivacy() {
  disposed=true;clearInterval(timer);guard?.dispose();
  await setPolicy(false);
  await vscode.commands.executeCommand('workbench.action.reloadWindow');
}
async function updateClaudeSetting(context,key,value) {
  const config=vscode.workspace.getConfiguration('claudeCode');
  if(JSON.stringify(config.get(key))===JSON.stringify(value))return;
  let updateError;
  if(vscode.extensions.getExtension(TARGET)) {
    try {await config.update(key,value,vscode.ConfigurationTarget.Global);return;}
    catch(error){updateError=error;}
  }
  {
    // Disabled extensions do not register their setting schema. Preserve JSONC
    // and set only our key before permitting the target to activate.
    const file=path.join(path.dirname(path.dirname(context.globalStorageUri.fsPath)),'settings.json');
    const text=fs.existsSync(file)?fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''):'{}',errors=[];
    jsonc.parse(text,errors,{allowTrailingComma:true});
    if(errors.length)throw updateError || new Error('VS Code 用户设置存在 JSON 错误。');
    const edited=jsonc.applyEdits(text,jsonc.modify(text,['claudeCode.'+key],value,{formattingOptions:{insertSpaces:true,tabSize:4,eol:text.includes('\r\n')?'\r\n':'\n'}}));
    const temporary=file+'.guardian.tmp';fs.writeFileSync(temporary,edited);fs.renameSync(temporary,file);
    for(let i=0;i<60;i++) {
      if(JSON.stringify(vscode.workspace.getConfiguration('claudeCode').get(key))===JSON.stringify(value))return;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    throw new Error('Claude 后端保护设置尚未生效，保持禁用。');
  }
}

function targetMetadata() {
  const known=vscode.extensions.getExtension(TARGET);
  if(known) return known.packageJSON;
  const root=path.join(process.env.USERPROFILE,'.vscode','extensions');
  const items=JSON.parse(fs.readFileSync(path.join(root,'extensions.json'),'utf8'));
  const item=items.find(item=>item.identifier.id.toLowerCase()===TARGET);
  return item?JSON.parse(fs.readFileSync(path.join(root,item.relativeLocation,'package.json'),'utf8')):null;
}
function supportedTarget() {
  if(vscode.env?.remoteName)return false;
  const meta=targetMetadata();
  if(!meta) return false;
  const configs=Array.isArray(meta.contributes?.configuration)?meta.contributes.configuration:[meta.contributes?.configuration];
  return meta.type!=='module' && String(meta.main||'').endsWith('.js') && configs.some(config=>config?.properties?.['claudeCode.claudeProcessWrapper']);
}
async function setPolicy(allowed) {
  const config=vscode.workspace.getConfiguration('extensions');
  const current=config.get('allowed'),next=nextPolicy(current,allowed);
  if(JSON.stringify(current)!==JSON.stringify(next)) await config.update('allowed',next,vscode.ConfigurationTarget.Global);
}
function paint(allowed) {
  status.text=allowed?'$(shield) Claude：允许':'$(shield) Claude：已锁定';
  status.tooltip=allowed?'Clash 系统代理或 TUN 已确认开启；官方插件的宿主请求走本地代理。':'系统代理和 TUN 都关闭、状态未知或版本不支持时，Claude 被禁用。';
}
async function synchronize(allowed,initial=false) {
  if(disposed)return;
  const wasActive=!!vscode.extensions.getExtension(TARGET)?.isActive;
  if(allowed && !supportedTarget()) {
    allowed=false;
    output.appendLine('当前 Claude 插件的入口格式或后端包装设置不受支持，保持禁用。');
  }
  if(!initial && allowed===lastAllowed)return;
  // Resolve the route and set backend privacy before allowing any activation.
  if(allowed)await configurePrivacy();
  if(disposed)return;
  allowed=allowed&&guard.status().allowed;
  lastAllowed=allowed;
  await setPolicy(allowed);
  paint(allowed);
  output.appendLine(allowed?'Clash 已开启：允许官方 Claude 插件。':'Clash 未开启或状态未知：锁定官方 Claude 插件。');
  if(!allowed && wasActive) {
    output.appendLine('请求已阻断；重载窗口以应用禁用状态，编辑内容由 VS Code 恢复。');
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}
function schedule(initial=false) {
  const allowed=guard.status().allowed;
  queue=queue.then(()=>synchronize(allowed,initial)).catch(error=>{
    lastAllowed=false;paint(false);output.appendLine('无法更新启停策略：'+error.message);
    // Network guard and backend wrapper remain fail-closed independently.
  });
  return queue;
}
exports.activate=async function activate(context) {
  if(process.platform!=='win32')throw new Error('本地 Clash 保护目前只支持 Windows。');
  disposed=false;lastAllowed=undefined;
  activationContext=context;privacyConfig=readPrivacyConfig();
  privacySeed=context.globalState.get('privacySeed');
  if(!privacySeed){privacySeed=crypto.randomBytes(32).toString('hex');await context.globalState.update('privacySeed',privacySeed);}
  privacy=manualProfile(privacyConfig,privacySeed);
  output=vscode.window.createOutputChannel('Claude Clash Guardian');
  status=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,90);
  status.command='claudeClashGuardian.status';paint(false);status.show();
  context.subscriptions.push(output,status);
  guard=createNetworkGuard({installDir:__dirname,getProfile:()=>privacy});
  scope=installNetworkScope(guard,()=>privacy);
  // Install hooks and backend gate before lifting the initial allow-list block.
  const claude=vscode.workspace.getConfiguration('claudeCode');
  const wrapper=path.join(__dirname,'ClaudePluginGuard.exe');
  if(claude.get('claudeProcessWrapper')!==wrapper)await updateClaudeSetting(context,'claudeProcessWrapper',wrapper);
  await configurePrivacy();
  context.subscriptions.push(vscode.commands.registerCommand('claudeClashGuardian.status',()=>{
    const current=guard.status();
    return vscode.window.showInformationMessage((current.allowed?'Clash 已开启':'Clash 未开启或无法确认')+'；本地代理端口 '+current.port+'。Claude 许可：'+(lastAllowed?'允许':'锁定')+'。隐私：'+(privacy.enabled?privacy.source+' / '+privacy.timeZone+' / '+privacy.locale:'关闭')+(privacy.reason?'；'+privacy.reason:'')+'。');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('claudeClashGuardian.checkNow',()=>schedule(true)));
  context.subscriptions.push(vscode.commands.registerCommand('claudeClashGuardian.refreshPrivacy',()=>reloadForPrivacy()));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event=>{
    if(event.affectsConfiguration('claudeClashGuardian.privacy'))queue=queue.then(()=>reloadForPrivacy()).catch(error=>output.appendLine('隐私配置重载失败：'+error.message));
  }));
  await guard.ready();
  await schedule(true);
  timer=setInterval(()=>schedule(),100);timer.unref();
};
exports.deactivate=async function deactivate() {
  disposed=true;clearInterval(timer);guard?.dispose();
  // Keep scoped hooks fail-closed until the host exits, including shutdown requests.
  try{await setPolicy(false);}catch{}
};
