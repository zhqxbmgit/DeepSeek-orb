@echo off
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0read-evidence.ps1" %*
exit /b %ERRORLEVEL%
