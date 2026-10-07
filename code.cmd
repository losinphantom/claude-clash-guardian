@echo off
setlocal
set VSCODE_DEV=
set ELECTRON_RUN_AS_NODE=1
"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" "%LOCALAPPDATA%\ClaudeClashGuardian\launcher.cjs" %*
exit /b %ERRORLEVEL%
