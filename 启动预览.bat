@echo off
setlocal
cd /d "%~dp0"
set PORT=8000
set PY=
where python >nul 2>nul && set PY=python
if not defined PY (where py >nul 2>nul && set PY=py)
if not defined PY (
  echo Python not found. Please install Python, or open index.html directly.
  pause
  exit /b 1
)
:tryport
netstat -ano | findstr /r ":%PORT% .*LISTENING" >nul 2>nul
if errorlevel 1 goto run
set /a PORT+=100
if %PORT% leq 8500 goto tryport
:run
start "Roadbook preview server" /min cmd /c "%PY% -m http.server %PORT%"
timeout /t 2 /nobreak >nul
start "" "http://localhost:%PORT%/"
echo.
echo Roadbook preview: http://localhost:%PORT%
echo If the map fails to load, add "localhost:%PORT%" (or "localhost") to the
echo AMap key referer whitelist, then refresh the page.
echo Close the minimized server window to stop the preview.
pause
