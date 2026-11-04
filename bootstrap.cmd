@echo off
rem Windows entry point: double-click, or run from a terminal. Arguments pass through (for example -NoStart).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1" %*
if errorlevel 1 pause
