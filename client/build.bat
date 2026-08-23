@echo off
setlocal
rem Work from any CWD: locate ui\ and this dir relative to build.bat (client\)
cd /d "%~dp0..\ui"
echo === [1/2] Building UI (vite) ===
call pnpm build || goto :error

cd /d "%~dp0"
echo === [2/2] Building Tauri app ===
call pnpm build || goto :error

echo.
echo Build finished successfully.
exit /b 0

:error
echo.
echo Build FAILED.
exit /b 1
