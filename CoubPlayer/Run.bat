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


dotnet watch run

pause
