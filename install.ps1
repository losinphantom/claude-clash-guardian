$ErrorActionPreference='Stop'
$taskSource=$PSScriptRoot
$taskInstall=Join-Path $env:LOCALAPPDATA 'ClaudeClashGuardian'
$taskCodeRoot=Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code'
$taskCodeExe=Join-Path $taskCodeRoot 'Code.exe'
$taskSettings=Join-Path $env:APPDATA 'Code\User\settings.json'
New-Item -ItemType Directory -Force -Path $taskInstall | Out-Null
Copy-Item -LiteralPath (Join-Path $taskSource 'extension\launcher.cjs'),(Join-Path $taskSource 'extension\policy.cjs'),(Join-Path $taskSource 'restore-launcher.cjs'),(Join-Path $taskSource 'code.cmd'),(Join-Path $taskSource 'uninstall.ps1') -Destination $taskInstall -Force
Copy-Item -LiteralPath (Join-Path $taskSource 'extension\node_modules') -Destination $taskInstall -Recurse -Force
& 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:winexe /reference:System.Windows.Forms.dll ('/out:'+(Join-Path $taskInstall 'CodeClashLauncher.exe')) (Join-Path $taskSource 'CodeClashLauncher.cs')
if($LASTEXITCODE -ne 0){throw 'Launcher compilation failed.'}
$taskBefore=Get-Content -LiteralPath $taskSettings -Raw | ConvertFrom-Json
$taskHadAllowed=$taskBefore.PSObject.Properties.Name -contains 'extensions.allowed'
$taskOriginalAllowed=$taskBefore.'extensions.allowed'
$taskElectronBefore=$env:ELECTRON_RUN_AS_NODE
$env:ELECTRON_RUN_AS_NODE='1'
try {& $taskCodeExe (Join-Path $taskInstall 'launcher.cjs') --lock-only;if($LASTEXITCODE -ne 0){throw 'Pre-start lock failed.'}}
finally {if($null -eq $taskElectronBefore){Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue}else{$env:ELECTRON_RUN_AS_NODE=$taskElectronBefore}}
# Restore the earlier package modification, if still present, under the lock.
$taskLegacy=Join-Path $env:LOCALAPPDATA 'ClaudePluginGuard'
$taskLegacyState=Join-Path $taskLegacy 'package-patch-state.json'
if(Test-Path -LiteralPath $taskLegacyState) {
    $taskState=Get-Content -LiteralPath $taskLegacyState -Raw | ConvertFrom-Json
    $taskOldMain=Join-Path (Join-Path $env:USERPROFILE '.vscode\extensions') ($taskState.relativeLocation+'\extension.js')
    if((Test-Path -LiteralPath $taskOldMain) -and [IO.File]::ReadAllText($taskOldMain).StartsWith('/* CLAUDE_PLUGIN_NETWORK_GUARD_V1 */')) {
        & (Join-Path $taskLegacy 'restore-settings.ps1')
    }
}
if(-not(Test-Path -LiteralPath (Join-Path $taskInstall 'settings-before.json'))) {
    $taskBaseline=Get-Content -LiteralPath $taskSettings -Raw | ConvertFrom-Json
    $taskBaseline.PSObject.Properties.Remove('extensions.allowed')
    if($taskHadAllowed){$taskBaseline | Add-Member -NotePropertyName 'extensions.allowed' -NotePropertyValue $taskOriginalAllowed}
    $taskBaseline | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath (Join-Path $taskInstall 'settings-before.json') -Encoding UTF8
}
$taskManifest=Get-Content -LiteralPath (Join-Path $taskSource 'extension\package.json') -Raw | ConvertFrom-Json
& (Join-Path $taskCodeRoot 'bin\code.cmd') --install-extension (Join-Path $taskSource ('claude-clash-guardian-'+$taskManifest.version+'.vsix')) --force
if($LASTEXITCODE -ne 0){throw 'Guardian VSIX installation failed; Claude remains locked.'}
$taskInventory=Get-Content -LiteralPath (Join-Path $env:USERPROFILE '.vscode\extensions\extensions.json') -Raw | ConvertFrom-Json
$taskEntry=$taskInventory | Where-Object {$_.identifier.id -eq 'jupiter-local.claude-clash-guardian'} | Select-Object -First 1
if(-not $taskEntry){throw 'Installed guardian not found.'}
$taskGuardian=Join-Path (Join-Path $env:USERPROFILE '.vscode\extensions') $taskEntry.relativeLocation
$taskCurrent=Get-Content -LiteralPath $taskSettings -Raw | ConvertFrom-Json
$taskCurrent | Add-Member -NotePropertyName 'claudeCode.claudeProcessWrapper' -NotePropertyValue (Join-Path $taskGuardian 'ClaudePluginGuard.exe') -Force
$taskEntries=@($taskCurrent.'claudeCode.environmentVariables' | Where-Object {$_ -and $_.name -ne 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'})
$taskEntries+=@([pscustomobject]@{name='CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC';value='1'})
$taskCurrent | Add-Member -NotePropertyName 'claudeCode.environmentVariables' -NotePropertyValue $taskEntries -Force
$taskCurrent | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $taskSettings -Encoding UTF8
$taskBackupFile=Join-Path $taskInstall 'shortcut-backups.json'
$taskBackups=@()
if(Test-Path -LiteralPath $taskBackupFile){$taskBackups=@(Get-Content -LiteralPath $taskBackupFile -Raw | ConvertFrom-Json)}
$taskShell=New-Object -ComObject WScript.Shell
$taskLinks=@((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Visual Studio Code\Visual Studio Code.lnk'))
$taskPinned=Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
if(Test-Path -LiteralPath $taskPinned){$taskLinks+=@(Get-ChildItem -LiteralPath $taskPinned -Filter '*.lnk' | ForEach-Object {$_.FullName})}
foreach($taskPath in $taskLinks) {
    if(-not(Test-Path -LiteralPath $taskPath)){continue}
    $taskLink=$taskShell.CreateShortcut($taskPath)
    if($taskLink.TargetPath -ne $taskCodeExe){continue}
    if(-not($taskBackups | Where-Object path -eq $taskPath)) {
        $taskBackup=Join-Path $taskInstall ('shortcut-'+$taskBackups.Count+'.lnk')
        Copy-Item -LiteralPath $taskPath -Destination $taskBackup -Force
        $taskBackups+=@([pscustomobject]@{path=$taskPath;backup=$taskBackup})
    }
    $taskLink.TargetPath=Join-Path $taskInstall 'CodeClashLauncher.exe'
    $taskLink.WorkingDirectory=$taskCodeRoot
    $taskLink.IconLocation=$taskCodeExe+',0'
    $taskLink.Description='VS Code：启动前锁定 Claude，由保护插件检查 Clash 后解锁'
    $taskLink.Save()
}
ConvertTo-Json -InputObject $taskBackups -Depth 5 | Set-Content -LiteralPath $taskBackupFile -Encoding UTF8
$taskUserPath=[Environment]::GetEnvironmentVariable('Path','User')
if(-not(@($taskUserPath -split ';' | Where-Object {$_.TrimEnd('\') -eq $taskInstall.TrimEnd('\')}).Count)) {
    [Environment]::SetEnvironmentVariable('Path',($taskInstall+';'+$taskUserPath),'User')
}
if(-not('ClaudeGuardEnvironmentBroadcast' -as [type])) {
    Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class ClaudeGuardEnvironmentBroadcast{[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,IntPtr w,string l,uint f,uint t,out IntPtr r);}'
}
$taskBroadcastResult=[IntPtr]::Zero
[ClaudeGuardEnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff,0x1a,[IntPtr]::Zero,'Environment',2,1000,[ref]$taskBroadcastResult) | Out-Null
[pscustomobject]@{InstalledGuardian=$taskGuardian;OfficialPluginModified=$false;StartMenuProtected=$true;CommandShimInstalled=$true;RestartVSCodeRequired=$true} | ConvertTo-Json
