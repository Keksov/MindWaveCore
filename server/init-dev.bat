@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "HOST_DIR=%~dp0"
set "HOST_SERVER_DIR=%HOST_DIR%"
set "UI_DIR=%HOST_DIR%..\ui"
set "BUN_EXE=%HOST_SERVER_DIR%bun.exe"
set "BUN_URL=https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64.zip"
set "BUN_RELEASE_REPO=oven-sh/bun"
set "BUN_ASSET_NAME=bun-windows-x64.zip"
set "BUN_CACHE_DIR=%HOST_SERVER_DIR%tmp\bun"
set "BUN_CACHE_ZIP=%BUN_CACHE_DIR%\%BUN_ASSET_NAME%"
set "BUN_VERSION=unknown"
set "SERVER_STATUS=not started"
set "UI_STATUS=not started"
set "BUN_SOURCE=existing"
for %%I in ("%HOST_SERVER_DIR%..\..\VendorsCore\common\win") do set "COMMON_WIN_DIR=%%~fI"
set "RELEASE_ASSET_DOWNLOAD=%COMMON_WIN_DIR%\release_asset_download.bat"

if /I "%MW_DRY_RUN%"=="1" (
        echo HOST_DIR=%HOST_DIR%
    echo HOST_SERVER_DIR=%HOST_SERVER_DIR%
    echo UI_DIR=%UI_DIR%
        echo BUN_EXE=%BUN_EXE%
        exit /b 0
)

call :ensure_bun
if errorlevel 1 goto :fail

call :install_server_deps
if errorlevel 1 goto :fail

call :install_ui_deps
if errorlevel 1 goto :fail

call :print_summary
exit /b 0

:fail
echo [init-dev] Setup failed.
exit /b 1

:ensure_bun
if exist "%BUN_EXE%" (
    "%BUN_EXE%" --version >nul 2>nul
    if errorlevel 1 (
        echo [init-dev] Existing bun.exe is invalid. Downloading a fresh copy...
        set "BUN_SOURCE=downloaded"
        call :download_bun
        if errorlevel 1 exit /b 1
    ) else (
        echo [init-dev] Using existing local Bun: %BUN_EXE%
    )
) else (
    echo [init-dev] Local bun.exe was not found. Downloading...
    set "BUN_SOURCE=downloaded"
    call :download_bun
    if errorlevel 1 exit /b 1
)

call :capture_bun_version
if errorlevel 1 exit /b 1
exit /b 0

:download_bun
set "TEMP_DIR=%TEMP%\mindwave-bun-%RANDOM%%RANDOM%"
set "ARCHIVE_PATH=%BUN_CACHE_ZIP%"

if exist "%TEMP_DIR%" rd /s /q "%TEMP_DIR%" >nul 2>nul

if exist "%ARCHIVE_PATH%" if not exist "%RELEASE_ASSET_DOWNLOAD%" set "ARCHIVE_PATH=%TEMP%\mindwave-bun-%RANDOM%%RANDOM%.zip"
if /I "%ARCHIVE_PATH%"=="%TEMP%\mindwave-bun-%RANDOM%%RANDOM%.zip" if exist "%ARCHIVE_PATH%" del /f /q "%ARCHIVE_PATH%" >nul 2>nul

if exist "%RELEASE_ASSET_DOWNLOAD%" (
    if not exist "%BUN_CACHE_DIR%" mkdir "%BUN_CACHE_DIR%"
    if errorlevel 1 (
        echo [init-dev] Failed to create Bun cache directory: %BUN_CACHE_DIR%
        exit /b 1
    )
) else (
    set "ARCHIVE_PATH=%TEMP%\mindwave-bun-%RANDOM%%RANDOM%.zip"
    if exist "%ARCHIVE_PATH%" del /f /q "%ARCHIVE_PATH%" >nul 2>nul
)

mkdir "%TEMP_DIR%"
if errorlevel 1 (
    echo [init-dev] Failed to create temp directory: %TEMP_DIR%
    exit /b 1
)

if exist "%RELEASE_ASSET_DOWNLOAD%" (
    echo [init-dev] Preparing cached Bun archive...
    call "%RELEASE_ASSET_DOWNLOAD%" --repo "%BUN_RELEASE_REPO%" --asset "%BUN_ASSET_NAME%" --out "%ARCHIVE_PATH%" --latest
    if errorlevel 1 (
        echo [init-dev] Failed to prepare cached Bun archive.
        call :cleanup_download "" "%TEMP_DIR%"
        exit /b 1
    )
) else (
    echo [init-dev] Downloading Bun archive...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri '%BUN_URL%' -OutFile '%ARCHIVE_PATH%'"
    if errorlevel 1 (
        echo [init-dev] Failed to download Bun from %BUN_URL%
        call :cleanup_download "%ARCHIVE_PATH%" "%TEMP_DIR%"
        exit /b 1
    )
)

echo [init-dev] Extracting Bun archive...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%ARCHIVE_PATH%' -DestinationPath '%TEMP_DIR%' -Force"
if errorlevel 1 (
    echo [init-dev] Failed to extract Bun archive.
    call :cleanup_download "" "%TEMP_DIR%"
    exit /b 1
)

if not exist "%TEMP_DIR%\bun-windows-x64\bun.exe" (
    echo [init-dev] Extracted archive did not contain bun-windows-x64\bun.exe
    call :cleanup_download "" "%TEMP_DIR%"
    exit /b 1
)

copy /y "%TEMP_DIR%\bun-windows-x64\bun.exe" "%BUN_EXE%" >nul
if errorlevel 1 (
    echo [init-dev] Failed to copy bun.exe into %HOST_SERVER_DIR%
    call :cleanup_download "" "%TEMP_DIR%"
    exit /b 1
)

if /I "%ARCHIVE_PATH%"=="%BUN_CACHE_ZIP%" (
    call :cleanup_download "" "%TEMP_DIR%"
) else (
    call :cleanup_download "%ARCHIVE_PATH%" "%TEMP_DIR%"
)

"%BUN_EXE%" --version >nul 2>nul
if errorlevel 1 (
    echo [init-dev] Downloaded bun.exe did not pass verification.
    exit /b 1
)

exit /b 0

:cleanup_download
if exist "%~1" del /f /q "%~1" >nul 2>nul
if exist "%~2" rd /s /q "%~2" >nul 2>nul
exit /b 0

:capture_bun_version
set "BUN_VERSION="
for /f "usebackq delims=" %%I in (`"%BUN_EXE%" --version 2^>nul`) do if not defined BUN_VERSION set "BUN_VERSION=%%I"
if not defined BUN_VERSION (
    echo [init-dev] Failed to read Bun version from %BUN_EXE%
    exit /b 1
)
exit /b 0

:install_server_deps
echo [init-dev] Installing server dependencies...
pushd "%HOST_SERVER_DIR%" >nul
if errorlevel 1 (
    echo [init-dev] Failed to enter %HOST_SERVER_DIR%
    exit /b 1
)

"%BUN_EXE%" install
set "INSTALL_ERROR=%ERRORLEVEL%"
popd >nul

if not "%INSTALL_ERROR%"=="0" (
    echo [init-dev] Server dependency installation failed.
    exit /b 1
)

set "SERVER_STATUS=installed"
exit /b 0

:install_ui_deps
if not exist "%UI_DIR%\package.json" (
    echo [init-dev] WARNING: UI not yet scaffolded
    set "UI_STATUS=skipped (UI not yet scaffolded)"
    exit /b 0
)

echo [init-dev] Installing UI dependencies...
pushd "%UI_DIR%" >nul
if errorlevel 1 (
    echo [init-dev] Failed to enter %UI_DIR%
    exit /b 1
)

"%BUN_EXE%" install
set "INSTALL_ERROR=%ERRORLEVEL%"
popd >nul

if not "%INSTALL_ERROR%"=="0" (
    echo [init-dev] UI dependency installation failed.
    exit /b 1
)

set "UI_STATUS=installed"
exit /b 0

:print_summary
echo [init-dev] Summary
echo [init-dev] Bun version: %BUN_VERSION% (%BUN_SOURCE%)
echo [init-dev] Server deps: %SERVER_STATUS%
echo [init-dev] UI deps: %UI_STATUS%
echo [init-dev] Hint: Run products\MindWaveCore\server\dev.bat for host dev mode
exit /b 0
