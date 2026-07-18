@echo off
taskkill /F /IM msedge.exe >nul 2>&1
timeout /t 2 /nobreak >nul
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir="%TEMP%\edge_debug" --no-first-run
