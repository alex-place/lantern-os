# DEPRECATED shim — kept so existing muscle-memory / links don't break.
#
# The old version of this file hard-coded a OneDrive path
# (C:\Users\...\OneDrive\Documents\GitHub\lantern-os) and ran both servers from
# the main checkout on `master`. Both are wrong: never serve from OneDrive, and
# the dual-boot must run from dedicated worktrees so the automation churning the
# main checkout can't yank code/env out from under a running server.
#
# The canonical launcher is scripts/Start-DualServers.ps1 (worktree-based).
# This shim just forwards to it, passing through any args (e.g. -NoChrome).

$canonical = Join-Path $PSScriptRoot "scripts/Start-DualServers.ps1"
Write-Host "[deprecated] start-dual-servers.ps1 -> scripts/Start-DualServers.ps1" -ForegroundColor Yellow
& pwsh -NoProfile -ExecutionPolicy Bypass -File $canonical @args
