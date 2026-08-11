@echo off
chcp 65001 >nul
title GROK FARM - Auto Run
cd /d "%~dp0"

echo ==============================================
echo    GROK FARM - Auto Start (tinggal klik)
echo ==============================================
echo.

rem ---- 1) Cek 9Router (port 20128) ----
curl -s -m 3 "http://127.0.0.1:20128/" >nul 2>&1
if errorlevel 1 goto cek-ezsolver
echo [OK] 9Router jalan (port 20128)
goto cek-ezsolver

:cek-ezsolver
rem ---- 2) Cek EzSolver (port 8191) ----
curl -s -m 3 "http://127.0.0.1:8191/health" >nul 2>&1
if errorlevel 1 goto start-ezsolver
echo [OK] EzSolver sudah jalan (port 8191)
goto mulai-bot

:start-ezsolver
echo [..] EzSolver belum jalan - menyalakan otomatis...
start "EzSolver" cmd /k "cd /d C:\Users\Arga\grok-farm\ezsolver && venv\Scripts\python.exe service.py"
echo      Menunggu EzSolver siap (10 detik)...
timeout /t 10 /nobreak >nul

:mulai-bot
rem ---- 3) Jalankan bot. Argumen = jumlah akun (mis. run.bat 100) ----
echo.
echo ==============================================
echo    Mulai bot: node grok_farm.js %1
echo ==============================================
echo.
if "%~1"=="" (
  node grok_farm.js
) else (
  node grok_farm.js --n %1
)

echo.
echo Bot selesai. Tekan tombol apa saja untuk menutup.
pause >nul
