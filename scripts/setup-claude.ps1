#!/usr/bin/env pwsh
# One-line setup for Claude-assisted Lantern OS environments.
# Usage: irm https://raw.githubusercontent.com/alex-place/lantern-os/master/scripts/setup-claude.ps1 | iex
# Or locally: pwsh -ExecutionPolicy Bypass -File scripts/setup-claude.ps1

param(
  [string]$AnthropicKey = $env:ANTHROPIC_API_KEY,
  [string]$GeminiKey    = $env:GEMINI_API_KEY,
  [string]$OpenAIKey    = $env:OPENAI_API_KEY
)

$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root ".env"

Write-Host "[lantern] Setting up environment..." -ForegroundColor Cyan

# --- npm install ---
Write-Host "[lantern] Installing Node dependencies..."
Push-Location (Join-Path $root ".")
npm install --silent
Pop-Location

# --- .env patching ---
if (-not (Test-Path $envPath)) {
  Copy-Item (Join-Path $root ".env.example") $envPath
}

$content = Get-Content $envPath -Raw

# Inject keys from Claude Code env if available (never prints key to stdout)
$patchKey = {
  param($raw, $varName, $val)
  if ($val) {
    $raw -replace "(?m)^$varName=.*$", "$varName=$val"
  } else {
    $raw
  }
}

# Pull ANTHROPIC_API_KEY from the running Claude Code session if not passed
if (-not $AnthropicKey) {
  # claude CLI stores key in keychain / env; attempt silent read
  $AnthropicKey = (claude config get apiKey 2>$null)
}

$content = & $patchKey $content "ANTHROPIC_API_KEY" $AnthropicKey
$content = & $patchKey $content "GEMINI_API_KEY"    $GeminiKey
$content = & $patchKey $content "OPENAI_API_KEY"    $OpenAIKey

$content | Set-Content $envPath

Write-Host "[lantern] Keys registered in .env" -ForegroundColor Green

# --- Run convergence loop to validate node registration ---
Write-Host "[lantern] Running convergence loop..."
$result = node (Join-Path $root "scripts/convergence-manager.js") --json 2>$null | ConvertFrom-Json
Write-Host "[lantern] Convergence status: $($result.status) | Issues: $($result.finalIssueCount)" -ForegroundColor $(if ($result.status -eq "ok") { "Green" } else { "Yellow" })

# --- Start server ---
Write-Host "[lantern] Starting server on http://127.0.0.1:4177 ..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "npm start --prefix `"$root/.`""

Write-Host "[lantern] Setup complete. Open http://127.0.0.1:4177" -ForegroundColor Green
