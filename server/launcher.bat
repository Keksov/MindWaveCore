@echo off
setlocal

set "HOST_DIR=%~dp0"
set "HOST_PACKAGE_JSON=%HOST_DIR%package.json"
set "SERVER_ENTRY=%HOST_DIR%server.ts"
set "SERVER_URL=http://localhost:3300/"

set "BUN_CMD=%HOST_DIR%bun.exe"
if not exist "%BUN_CMD%" set "BUN_CMD=bun"

if /I "%MW_DRY_RUN%"=="1" (
    echo HOST_DIR=%HOST_DIR%
    echo HOST_PACKAGE_JSON=%HOST_PACKAGE_JSON%
    echo SERVER_ENTRY=%SERVER_ENTRY%
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

call "%BUN_CMD%" --version >nul 2>nul
if errorlevel 1 (
    echo [launcher] Bun was not found.
    echo [launcher] Install Bun or place bun.exe next to launcher.bat.
    exit /b 1
)

echo [launcher] Starting server from host package:
echo [launcher]   %HOST_PACKAGE_JSON%
start "MindWave Server" cmd /k "cd /d %HOST_DIR% && %BUN_CMD% run start"

timeout /t 2 /nobreak >nul
start "" "%SERVER_URL%"

echo [launcher] Browser opened: %SERVER_URL%
echo [launcher] Close the "MindWave Server" window to stop the server.
exit /b 0
