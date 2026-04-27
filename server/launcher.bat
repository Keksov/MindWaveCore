@echo off
setlocal

set "HOST_DIR=%~dp0"
set "HOST_PACKAGE_JSON=%HOST_DIR%package.json"
set "SERVER_ENTRY=%HOST_DIR%server.ts"
set "SERVER_URL=http://localhost:3300/"
set "SERVER_READY_MAX_ATTEMPTS=15"
set "HOST_PUBLIC_INDEX=%HOST_DIR%public\index.html"
set "UI_DIR=%HOST_DIR%..\ui"

set "BUN_CMD=%HOST_DIR%bun.exe"
if not exist "%BUN_CMD%" set "BUN_CMD=bun"

if /I "%MW_DRY_RUN%"=="1" (
    echo HOST_DIR=%HOST_DIR%
    echo HOST_PACKAGE_JSON=%HOST_PACKAGE_JSON%
    echo SERVER_ENTRY=%SERVER_ENTRY%
    echo HOST_PUBLIC_INDEX=%HOST_PUBLIC_INDEX%
    echo UI_DIR=%UI_DIR%
    echo BUN_CMD=%BUN_CMD%
    echo SERVER_URL=%SERVER_URL%
    exit /b 0
)

if not exist "%HOST_PACKAGE_JSON%" (
    echo [launcher] Host package manifest not found:
    echo [launcher]   %HOST_PACKAGE_JSON%
    exit /b 1
)

if not exist "%SERVER_ENTRY%" (
    echo [launcher] Server entry not found:
    echo [launcher]   %SERVER_ENTRY%
    exit /b 1
)

if not exist "%UI_DIR%\package.json" (
    echo [launcher] UI project not found:
    echo [launcher]   %UI_DIR%
    exit /b 1
)

call "%BUN_CMD%" --version >nul 2>nul
if errorlevel 1 (
    echo [launcher] Bun was not found.
    echo [launcher] Install Bun or place bun.exe next to launcher.bat.
    exit /b 1
)

if /I "%MW_SKIP_UI_BUILD%"=="1" goto start_server

:build_ui
echo [launcher] Rebuilding frontend bundle...
pushd "%UI_DIR%" >nul
if errorlevel 1 (
    echo [launcher] Failed to enter UI directory:
    echo [launcher]   %UI_DIR%
    exit /b 1
)

call "%BUN_CMD%" run build
set "UI_BUILD_ERROR=%ERRORLEVEL%"
popd >nul

if not "%UI_BUILD_ERROR%"=="0" (
    echo [launcher] UI build failed.
    exit /b 1
)

if not exist "%HOST_PUBLIC_INDEX%" (
    echo [launcher] UI build completed but index.html is still missing:
    echo [launcher]   %HOST_PUBLIC_INDEX%
    exit /b 1
)

:start_server

echo [launcher] Starting server from host package:
echo [launcher]   %HOST_PACKAGE_JSON%
start "MindWave Server" cmd /k "cd /d %HOST_DIR% && %BUN_CMD% run start"

:wait_for_server
where curl.exe >nul 2>nul
if errorlevel 1 (
    echo [launcher] curl.exe not found. Skipping readiness wait.
    goto open_browser
)

set /a SERVER_READY_ATTEMPT=0

:wait_for_server_retry
set /a SERVER_READY_ATTEMPT+=1
curl.exe -s -o nul -m 1 "%SERVER_URL%" >nul 2>nul
if not errorlevel 1 (
    echo [launcher] Server is ready.
    goto open_browser
)

if %SERVER_READY_ATTEMPT% geq %SERVER_READY_MAX_ATTEMPTS% (
    echo [launcher] Server did not respond after %SERVER_READY_MAX_ATTEMPTS% attempts. Opening browser anyway.
    goto open_browser
)

echo [launcher] Waiting for server... attempt %SERVER_READY_ATTEMPT%/%SERVER_READY_MAX_ATTEMPTS%
timeout /t 1 /nobreak >nul
goto wait_for_server_retry

:open_browser
start "" "%SERVER_URL%"

echo [launcher] Browser opened: %SERVER_URL%
echo [launcher] Close the "MindWave Server" window to stop the server.
exit /b 0
