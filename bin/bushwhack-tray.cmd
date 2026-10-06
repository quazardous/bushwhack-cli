@echo off
rem bushwhack-tray.cmd -- the tray, started from a terminal, with no window of its own.
start "" conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0bushwhack-tray.ps1"
