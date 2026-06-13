@echo off
title Leo work
cd /d "D:\Leo work"
echo.
echo   Starting Leo work...
echo.
echo   * Keep this window OPEN  = app is running
echo   * CLOSE this window      = stop the app
echo.
REM Stop any previous instance still holding the ports (always fresh start)
powershell -NoProfile -ExecutionPolicy Bypass -Command "foreach($p in 1420,8765){Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }}"
REM Open the browser after the servers have had a few seconds to boot
start "" cmd /c "timeout /t 8 >nul & start http://localhost:1420"
call npm run dev
echo.
echo   Leo work stopped. You can close this window.
pause >nul
