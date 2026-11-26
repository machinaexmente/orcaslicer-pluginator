@echo off
rem Starts Pluginator and opens it in its own window. Double-click to run.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 18+ is required: https://nodejs.org & pause & exit /b 1)
if not exist node_modules\yaml (
  echo Installing dependencies...
  call npm install --no-audit --no-fund || (pause & exit /b 1)
)
node server.js %*
