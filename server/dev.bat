@echo off
setlocal

set "HOST_DIR=%~dp0"
set "BUN=%HOST_DIR%bun.exe"
set "HOST_PACKAGE_JSON=%HOST_DIR%package.json"
set "SERVER_ENTRY=%HOST_DIR%server.ts"
set "UI_DIR=%HOST_DIR%..\ui"

if /I "%MW_DRY_RUN%"=="1" (
    echo HOST_DIR=%HOST_DIR%
    echo BUN=%BUN%
    echo HOST_PACKAGE_JSON=%HOST_PACKAGE_JSON%
    echo SERVER_ENTRY=%SERVER_ENTRY%
    echo UI_DIR=%UI_DIR%
    exit /b 0
)

if not exist "%BUN%" (
    echo [dev] ERROR: bun.exe not found at "%BUN%"
    echo [dev] Run init-dev.bat first.
    exit /b 1
)

if not exist "%SERVER_ENTRY%" (
    echo [dev] ERROR: Host server entry not found at "%SERVER_ENTRY%"
    exit /b 1
)

if not exist "%HOST_PACKAGE_JSON%" (
    echo [dev] ERROR: Host package manifest not found at "%HOST_PACKAGE_JSON%"
    exit /b 1
)

if not exist "%UI_DIR%\package.json" (
    echo [dev] ERROR: UI project not found at "%UI_DIR%"
    exit /b 1
)

echo [dev] Starting MindWave development processes...
echo [dev] Backend: bun run dev (from %HOST_PACKAGE_JSON%)
echo [dev] UI:      bun run dev (quasar dev)

start "MindWave Backend (watch)" cmd /k "cd /d %HOST_DIR% && %BUN% run dev"
start "MindWave UI (dev)" cmd /k "cd /d %UI_DIR% && %BUN% run dev"

echo [dev] Started.
echo [dev] Close spawned terminal windows to stop processes.

endlocal
