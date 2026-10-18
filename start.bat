@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
  ) else (
    echo Node.js was not found. Please install Node.js 24 or newer.
    pause
    exit /b 1
  )
)

"%NODE_EXE%" -e "require('node:sqlite')" >nul 2>nul
if errorlevel 1 (
  echo The installed Node.js does not support built-in SQLite. Please install Node.js 24 or newer.
  pause
  exit /b 1
)

powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8765/api/health' -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>nul
if not errorlevel 1 (
  start "" "http://127.0.0.1:8765"
  exit /b 0
)

set NODE_NO_WARNINGS=1
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 900; Start-Process 'http://127.0.0.1:8765'"
"%NODE_EXE%" server.js

pause
