@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Action Install %*
set "egress_exit=%errorlevel%"
echo.
pause
exit /b %egress_exit%
