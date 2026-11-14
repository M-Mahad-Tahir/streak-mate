@echo off
title Win Streak
cd /d "%~dp0"
echo.
echo   Starting Win Streak...
echo   Keep this window open while you use the app. Close it to stop the app.
echo.
if not exist node_modules (
  echo   Installing packages the first time, please wait...
  call npm install
)
rem Open the browser a few seconds later, once the app is ready.
start "" /min cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:5173"
call npm run dev -- --port 5173
pause
