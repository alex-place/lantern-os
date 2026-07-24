#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Authenticate ChatGPT for the Lantern OS GPT Web API.
.DESCRIPTION
    Launches a visible Chrome browser via Playwright, navigates to chat.openai.com,
    and lets you log in interactively. The authenticated profile is saved to
    ~/.chatgpt-profile so the GPT Web API (port 3000) can use it headlessly.

    Run this once. After auth, the GPT Web API will auto-detect the profile
    and skip the login prompt on subsequent starts.

    Prerequisites:
      - Node.js >=16
      - Playwright installed in integrations/gm-agent-orchestrator/tools/gpt-web-api
      - Internet access to reach chat.openai.com
#>

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$gptWebApiDir = Join-Path $repoRoot "integrations" "gm-agent-orchestrator" "tools" "gpt-web-api"
$profilePath = Join-Path $env:USERPROFILE ".chatgpt-profile"
$authScript = Join-Path $PSScriptRoot "authenticate-chatgpt.js"

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  Lantern OS — ChatGPT Authentication" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
Write-Host "Checking Node.js..." -ForegroundColor Gray
try {
    $nodeVer = node --version 2>$null
    Write-Host "  Node.js found: $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "  Node.js not found. Install from https://nodejs.org/" -ForegroundColor Red
    exit 1
}

# Check Playwright
Write-Host "Checking Playwright..." -ForegroundColor Gray
$pwPath = Join-Path $gptWebApiDir "node_modules" "playwright"
if (-not (Test-Path $pwPath)) {
    Write-Host "  Playwright not found. Installing..." -ForegroundColor Yellow
    npm --prefix $gptWebApiDir install --no-audit --no-fund 2>&1 | Select-Object -Last 3
}
Write-Host "  Playwright OK" -ForegroundColor Green

# If profile already exists, ask to overwrite
if (Test-Path $profilePath) {
    Write-Host ""
    Write-Host "Existing profile found at: $profilePath" -ForegroundColor Yellow
    $overwrite = Read-Host "Overwrite? [y/N]"
    if ($overwrite -notmatch '^[Yy]') {
        Write-Host "Aborted. Existing profile kept." -ForegroundColor Cyan
        exit 0
    }
    Remove-Item -Recurse -Force $profilePath -ErrorAction SilentlyContinue
}

# Create the Node.js auth script inline
$jsContent = @"
const { chromium } = require('playwright');
const path = require('path');

const profilePath = path.join(process.env.USERPROFILE || process.env.HOME, '.chatgpt-profile');

(async () => {
  console.log('[Auth] Launching Chrome with persistent profile...');
  console.log('[Auth] Profile will be saved to:', profilePath);

  const context = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    viewport: { width: 1280, height: 800 }
  });

  const page = await context.newPage();
  console.log('[Auth] Navigating to chat.openai.com...');

  await page.goto('https://chat.openai.com', { waitUntil: 'networkidle', timeout: 60000 });

  const url = page.url();
  if (url.includes('login') || url.includes('auth')) {
    console.log('[Auth] Please log in to ChatGPT in the browser window.');
    console.log('[Auth] After you are fully logged in and see the chat interface,');
    console.log('[Auth] press Enter in this terminal to save the session.');
  } else {
    console.log('[Auth] Already authenticated! Press Enter to save and exit.');
  }

  process.stdin.once('data', async () => {
    await context.close();
    console.log('[Auth] Session saved to:', profilePath);
    console.log('[Auth] You can now start the GPT Web API headlessly.');
    process.exit(0);
  });
})();
"@

Set-Content -Path $authScript -Value $jsContent -Encoding UTF8

Write-Host ""
Write-Host "Starting authentication..." -ForegroundColor Cyan
Write-Host "A Chrome window will open. Log in to ChatGPT, then return here and press Enter."
Write-Host ""

# Run the auth script using the gpt-web-api's node_modules
$env:NODE_PATH = Join-Path $gptWebApiDir "node_modules"
node $authScript

# Clean up the temp script
Remove-Item $authScript -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  Authentication complete." -ForegroundColor Cyan
Write-Host "  Profile saved to: $profilePath" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Start GPT Web API:" -ForegroundColor Gray
Write-Host "    npm start --prefix $gptWebApiDir" -ForegroundColor White
Write-Host ""
Write-Host "  Or restart all services:" -ForegroundColor Gray
Write-Host "    npm start" -ForegroundColor White
Write-Host "==============================================" -ForegroundColor Cyan
