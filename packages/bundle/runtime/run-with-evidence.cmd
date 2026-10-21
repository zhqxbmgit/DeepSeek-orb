@echo off
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0run-with-evidence.ps1" %*
exit /b %ERRORLEVEL%
