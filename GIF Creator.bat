@echo off
rem Double-click to start GIF Creator in your browser.
rem Keep this window open while you work. Close it to stop GIF Creator.
title GIF Creator
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel% equ 0 (
  py -3 app\server.py %*
) else (
  python app\server.py %*
)

if errorlevel 1 (
  echo.
  echo GIF Creator stopped because of the problem above.
  echo If Python isn't installed, run:  winget install Python.Python.3.13
  pause
)
