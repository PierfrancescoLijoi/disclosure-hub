@echo off
rem Windows entry point: double-click, or run "stack" in a terminal. Starts the containers and prints the addresses to open.
rem Needs Node.js 22+ and Docker Desktop running. Uses node directly, so PowerShell's script policy does not matter.
cd /d "%~dp0"
if not exist node_modules\.package-lock.json (
  echo Installing dependencies...
  call npm.cmd install --silent --no-audit --no-fund
)
node scripts\stack.mjs %*
set EXITCODE=%errorlevel%
rem Keep the window open when it was started by a double-click, so the addresses stay readable.
echo %cmdcmdline% | "%SystemRoot%\System32\find.exe" /i "%~nx0" >nul && pause
exit /b %EXITCODE%
