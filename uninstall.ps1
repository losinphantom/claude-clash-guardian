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
Write-Output 'Guardian removed. Fully exit VS Code and reopen; reopen terminals for the restored PATH.'
