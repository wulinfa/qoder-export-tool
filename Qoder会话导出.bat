@echo off
rem ============================================================
rem  Qoder Session Export Tool - launcher
rem  Self-locating via %~dp0; portable across any path/machine.
rem ============================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "NODE_EXE="

rem 1) prefer bundled portable node
if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"
if defined NODE_EXE goto :run

rem 2) fallback: system node on PATH
where node >nul 2>nul
if errorlevel 1 goto :ask_download
for /f "delims=" %%i in ('where node') do if not defined NODE_EXE set "NODE_EXE=%%i"
if defined NODE_EXE goto :run

:ask_download
rem 3) offer auto-download of portable node (first run only)
echo Node.js runtime not found.
echo This tool needs Node.js to run.
echo Download portable Node.js now? (about 30 MB, one time only)
set "CONFIRM="
set /p CONFIRM=Type Y to download, anything else to exit:
if /i not "%CONFIRM%"=="Y" goto :no_node
echo Downloading portable Node.js ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lib\download_node.ps1"
if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"

:run
if not defined NODE_EXE goto :no_node
"%NODE_EXE%" "%~dp0main.js"
pause
exit /b 0

:no_node
echo.
echo Node.js is required but was not found.
echo Please install Node.js from https://nodejs.org and run again.
pause
exit /b 1
