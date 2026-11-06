@echo off
rem Windows entry point: double-click, or run "stack" in a terminal. One command from a clean computer to a running system.
rem 1) Node.js 22+: used if present, otherwise a portable copy is downloaded into .tools (nothing is installed system-wide).
rem 2) Dependencies: downloaded with npm install (a no-op when they are already there).
rem 3) Containers: built and started with Docker Desktop, then the addresses to open are printed.
rem The only thing it cannot install for you is Docker Desktop (it needs administrator rights): https://www.docker.com/products/docker-desktop/
rem Runs PowerShell with a one-time bypass of the script policy, so no system setting changes.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1" -Stack %*
set EXITCODE=%errorlevel%
rem Keep the window open when it was started by a double-click, so the addresses stay readable.
echo %cmdcmdline% | "%SystemRoot%\System32\find.exe" /i "%~nx0" >nul && pause
exit /b %EXITCODE%
