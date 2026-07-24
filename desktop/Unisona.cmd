@echo off
REM ── unisona.ai desktop launcher (Windows double-click wrapper) ───────────────
REM Boots the local Convergence Core in chat-only mode and opens your browser.
REM Requires Node.js >= 20 on PATH and `npm install` already run in the garage app.
REM Phase 1 (dev): runs against this checkout. Phase 1 (shipped): a signed .exe
REM built from launcher.js replaces this wrapper. See docs/adr/0014.
setlocal
cd /d "%~dp0"
node launcher.js %*
if errorlevel 1 (
  echo.
  echo [unisona] Launcher exited with an error. See the message above.
  pause
)
endlocal
