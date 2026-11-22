@echo off
cd /d "%~dp0gui"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron binary missing. Run: npm install
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .