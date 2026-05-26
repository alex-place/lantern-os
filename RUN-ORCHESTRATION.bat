@echo off
REM Lantern OS Master Orchestration Executor
REM This script runs the complete incubator consolidation pipeline
REM Unified batch framework + 9 skills + convergence → master branch

setlocal enabledelayedexpansion

cd /d "%~dp0"

echo.
echo ================================================================================
echo LANTERN OS - ORCHESTRATION EXECUTOR
echo ================================================================================
echo.
echo Starting complete incubator lifecycle...
echo Consolidation → Validation → Git Push → GitHub PR
echo.
echo Location: %cd%
echo.

REM Execute the PowerShell orchestration script
powershell -NoProfile -ExecutionPolicy Bypass -File .\lantern-os-master-orchestration.ps1

REM Capture exit code
set EXITCODE=%ERRORLEVEL%

echo.
echo ================================================================================
if %EXITCODE% equ 0 (
    echo ORCHESTRATION COMPLETED SUCCESSFULLY
    echo Task #23: Push consolidated lantern-os to master - COMPLETE
) else (
    echo ORCHESTRATION COMPLETED WITH ERRORS
    echo Exit Code: %EXITCODE%
)
echo ================================================================================
echo.

pause
