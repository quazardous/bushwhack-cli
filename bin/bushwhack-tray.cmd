@echo off
rem bushwhack-tray.cmd -- the tray, started from a terminal (hidden PowerShell).
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0bushwhack-tray.ps1"
