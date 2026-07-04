#!/usr/bin/env pwsh
# Install-MonoworkstreamHooks.ps1
# Activates the repo-managed git hooks (workstream + slop + change-record + sprawl).
#
# The hooks live in scripts/hooks/ and are version-controlled. Rather than copying
# them into .git/hooks (which drifts and must be re-run whenever a hook changes),
# this points git at the tracked directory via core.hooksPath — so a hook edit takes
# effect for everyone on their next pull, and a fresh clone is one command away.
#
# This normally runs automatically from the `prepare` npm script on `npm install`.
# Run it by hand after cloning if you skipped install.

$ErrorActionPreference = "Stop"
$repoRoot = git rev-parse --show-toplevel
Set-Location $repoRoot

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node -and (Test-Path "scripts/setup-hooks.mjs")) {
    # One source of truth: the node setup also marks the hooks executable in git.
    node scripts/setup-hooks.mjs
} else {
    git config core.hooksPath scripts/hooks
    foreach ($h in @("pre-commit","commit-msg","prepare-commit-msg","pre-push","post-merge","post-checkout","post-commit")) {
        $p = "scripts/hooks/$h"
        if (Test-Path $p) { git update-index --chmod=+x $p }
    }
    Write-Host "[hooks] set core.hooksPath = scripts/hooks - repo-managed git hooks active."
}

Write-Host ""
Write-Host "Repo-managed hooks active. Enforced on commit/push:"
Write-Host "  - pre-commit:         per-lane workstream gate + slop scan (secrets/debug/sqli/exec/size) + consolidation"
Write-Host "  - commit-msg:         blocks slop messages (empty, <8 chars, wip, placeholder, temp, ...)"
Write-Host "  - prepare-commit-msg: injects conventional-commit template on blank commits"
Write-Host "  - pre-push:           master protection + change-record/version gate + STALE-CLOBBER gate"
Write-Host "                        + SPRAWL TRIPWIRE (new public surface must declare a loop stage, #1561)"
Write-Host "                        + per-lane workstream gate + STALENESS block (>50 behind master) + git-lfs"
Write-Host "  - post-merge:         stale-branch + pending-changelog-fragment warnings"
Write-Host ""
Write-Host "Each branch prefix is its own lane (one concurrent PR per lane):"
Write-Host "  - agent prefixes:      claude/ gemini/ codex/ devin/ grok/ openai/"
Write-Host "  - dynamic human lanes: alex/ kriskin/ mookman11/ or any NAME/ - unlimited contributors"
Write-Host "  - unprefixed branches (no slash) share the fallback human lane."
Write-Host ""
Write-Host "Bypass workstream gate:    SKIP_MONOWORKSTREAM=1 git commit/push ..."
Write-Host "Bypass sprawl tripwire:    SKIP_SPRAWL_CHECK=1 git push ..."
Write-Host "Bypass change-record gate: SKIP_VERSION_CHECK=1 git push ..."
Write-Host "Bypass stale-clobber gate: SKIP_CLOBBER_CHECK=1 git push ..."
Write-Host "Override master push:      OVERRIDE_MERGE=1 git push origin master"
Write-Host ""
Write-Host "To deactivate: git config --unset core.hooksPath"
