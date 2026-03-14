@echo off
title Coub Player Dev Server

echo ===============================
echo Starting Coub Player Dev Server
echo ===============================

REM Переход в папку проекта
cd /d "%~dp0"

echo.
echo Restoring .NET packages...
dotnet restore

echo.
echo Starting server with hot reload...
echo.

REM Открываем браузер через 3 секунды
start "" cmd /c "timeout /t 2 >nul && start http://localhost:5000"

REM Запуск сервера
dotnet watch run

pause
