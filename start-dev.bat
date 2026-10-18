@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title R2 Ledger Dev

set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
  ) else (
    echo Node.js was not found. Please install Node.js 24 or newer.
    pause
    exit /b 1
  )
)

if not exist "node_modules\vite\bin\vite.js" (
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
  echo Installing frontend dependencies...
  call "%NPM_CMD%" install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

set NODE_NO_WARNINGS=1
"%NODE_EXE%" scripts\dev.js

if errorlevel 1 (
  echo Development server exited with an error.
  pause
)
