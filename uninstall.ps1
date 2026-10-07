$ErrorActionPreference='Stop'
$taskInstall=Join-Path $env:LOCALAPPDATA 'ClaudeClashGuardian'
$taskCodeRoot=Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code'
& (Join-Path $taskCodeRoot 'bin\code.cmd') --uninstall-extension jupiter-local.claude-clash-guardian
$env:ELECTRON_RUN_AS_NODE='1'
try {& (Join-Path $taskCodeRoot 'Code.exe') (Join-Path $taskInstall 'restore-launcher.cjs');if($LASTEXITCODE -ne 0){throw 'Settings restoration failed.'}}
finally {Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue}
$taskLinks=Get-Content -LiteralPath (Join-Path $taskInstall 'shortcut-backups.json') -Raw | ConvertFrom-Json
$taskShell=New-Object -ComObject WScript.Shell
foreach($taskLink in $taskLinks) {
    if(Test-Path -LiteralPath $taskLink.path){$taskCurrent=$taskShell.CreateShortcut($taskLink.path);if($taskCurrent.TargetPath -eq (Join-Path $taskInstall 'CodeClashLauncher.exe')){Copy-Item -LiteralPath $taskLink.backup -Destination $taskLink.path -Force}}
}
$taskUserPath=[Environment]::GetEnvironmentVariable('Path','User')
$taskNextPath=($taskUserPath -split ';' | Where-Object { $_.TrimEnd('\') -ne $taskInstall.TrimEnd('\') }) -join ';'
[Environment]::SetEnvironmentVariable('Path',$taskNextPath,'User')
# Remove active launch entry points so terminals with a stale PATH cannot lock
# Claude again after the guardian itself has been uninstalled. Keep backups.
$taskResolvedInstall=[IO.Path]::GetFullPath($taskInstall)
foreach($taskName in @('code.cmd','CodeClashLauncher.exe','launcher.cjs')) {
    $taskTarget=[IO.Path]::GetFullPath((Join-Path $taskResolvedInstall $taskName))
    if([IO.Path]::GetDirectoryName($taskTarget) -ne $taskResolvedInstall){throw 'Unexpected launcher cleanup path.'}
    if(Test-Path -LiteralPath $taskTarget){Remove-Item -LiteralPath $taskTarget -Force}
}
if(-not('ClaudeGuardianUndoBroadcast' -as [type])) {
    Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class ClaudeGuardianUndoBroadcast{[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,IntPtr w,string l,uint f,uint t,out IntPtr r);}'
}
$taskBroadcastResult=[IntPtr]::Zero
[ClaudeGuardianUndoBroadcast]::SendMessageTimeout([IntPtr]0xffff,0x1a,[IntPtr]::Zero,'Environment',2,1000,[ref]$taskBroadcastResult) | Out-Null
Write-Output 'Guardian removed. Fully exit VS Code and reopen; reopen terminals for the restored PATH.'
