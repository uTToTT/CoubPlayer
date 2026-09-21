@echo off
title Coub Player Portable Build

rem Portable build: everything the app needs sits in one folder,
rem no .NET installation required on the target machine.
rem
rem The user library (wwwroot\Data) is NOT part of the build and is never
rem overwritten - the app creates it next to the exe on first run.
rem
rem Text here is ASCII on purpose: cmd.exe mangles UTF-8 batch files.

set "OUT=D:\CoubPlayerPortable"
if not "%~1"=="" set "OUT=%~1"

echo ===============================
echo Coub Player - portable build
echo ===============================
echo.
echo Output folder: %OUT%
echo.

cd /d "%~dp0"

rem Note: a Debug instance started from Visual Studio does NOT block this -
rem Release publishes to a different folder. Only an app running from inside
rem %OUT% itself would lock the files.

dotnet publish "CoubPlayer.csproj" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o "%OUT%"

if errorlevel 1 (
    echo.
    echo [!] Build failed, see the messages above.
    echo     If it complains about a locked file - close the app
    echo     running from "%OUT%" and try again.
    echo.
    pause
    exit /b 1
)

rem Native libraries are NOT bundled into the single file - they must sit
rem next to the exe. If the app was running from %OUT%, it holds them open,
rem the publish cannot replace them, and they can end up missing altogether.
rem That failure is silent: the exe builds, the folder looks fine, and the
rem app dies on another machine. So we check.

set "MISSING="
if not exist "%OUT%\e_sqlite3.dll"   set "MISSING=%MISSING% e_sqlite3.dll"
if not exist "%OUT%\libSkiaSharp.dll" set "MISSING=%MISSING% libSkiaSharp.dll"

if defined MISSING (
    echo.
    echo [!] Build incomplete - missing native libraries:%MISSING%
    echo.
    echo     Without e_sqlite3.dll the app cannot open its database at all.
    echo     Without libSkiaSharp.dll icons and banners fail.
    echo.
    echo     Most likely the app was running from "%OUT%" and held the files.
    echo     Close it, delete the folder, and run this again.
    echo.
    pause
    exit /b 1
)

echo.
echo Done. Copy the whole "%OUT%" folder - wwwroot and the native
echo libraries (libSkiaSharp.dll, e_sqlite3.dll) must stay next to the exe.
echo.

explorer "%OUT%"
pause
