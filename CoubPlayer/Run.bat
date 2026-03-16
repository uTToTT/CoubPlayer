@echo off
title Coub Player Dev Server

echo ===============================
echo Starting Coub Player Dev Server
echo ===============================

cd /d "%~dp0"

echo.
echo Restoring .NET packages...
dotnet restore

echo.
echo Starting server with hot reload...
echo.

start http://localhost:5000/index.html

dotnet run

pause