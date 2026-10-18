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

if /I not "%NODE_EXE%"=="node" (
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
)

"%NODE_EXE%" -e "require('node:sqlite')" >nul 2>nul
if errorlevel 1 (
  echo The installed Node.js does not support built-in SQLite. Please install Node.js 24 or newer.
  pause
  exit /b 1
)

set "NPM_CMD="
if exist "%ProgramFiles%\nodejs\npm.cmd" (
  set "NPM_CMD=%ProgramFiles%\nodejs\npm.cmd"
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
) else (
  for /f "delims=" %%I in ('where npm.cmd 2^>nul') do (
    set "NPM_CMD=%%I"
    set "PATH=%%~dpI;%PATH%"
  )
)
if not defined NPM_CMD (
  echo npm was not found. Please reinstall Node.js 24 or newer.
  pause
  exit /b 1
)

if not exist "node_modules\vue\package.json" (
  echo Installing frontend dependencies...
  call "%NPM_CMD%" install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

echo Building frontend...
call "%NPM_CMD%" run build
if errorlevel 1 (
  echo Frontend build failed.
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
