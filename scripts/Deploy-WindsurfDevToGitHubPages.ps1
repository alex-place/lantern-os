# Windsurf Developer GitHub Pages Deployment
# Deploy to GitHub Pages for cloud URL access

$ErrorActionPreference = "Stop"

Write-Host "=== Windsurf Developer GitHub Pages Deployment ===" -ForegroundColor Cyan

# Navigate to repository
Set-Location (Split-Path $PSScriptRoot -Parent)

Write-Host "Current directory: $(Get-Location)" -ForegroundColor Green
Write-Host ""

# Create gh-pages branch with Windsurf Developer files
Write-Host "Creating gh-pages branch..." -ForegroundColor Yellow

try {
    # Check if gh-pages branch exists
    $branches = git branch
    if ($branches -match "gh-pages") {
        Write-Host "gh-pages branch already exists, updating..." -ForegroundColor Yellow
        git checkout gh-pages
        git checkout master -- surfaces/windsurf-dev/
        
        # Move files to root
        if (Test-Path "index.html") {
            Remove-Item "index.html" -Force
        }
        if (Test-Path "styles.css") {
            Remove-Item "styles.css" -Force
        }
        if (Test-Path "windsurf-dev.js") {
            Remove-Item "windsurf-dev.js" -Force
        }
        
        Copy-Item "surfaces\windsurf-dev\index.html" -Destination "."
        Copy-Item "surfaces\windsurf-dev\styles.css" -Destination "."
        Copy-Item "surfaces\windsurf-dev\windsurf-dev.js" -Destination "."
        
        git add index.html styles.css windsurf-dev.js
        git commit -m "Update Windsurf Developer on GitHub Pages"
        Write-Host "✓ gh-pages branch updated" -ForegroundColor Green
    } else {
        Write-Host "Creating new gh-pages branch..." -ForegroundColor Yellow
        git checkout --orphan gh-pages
        git rm -rf .
        Copy-Item "surfaces\windsurf-dev\index.html" -Destination "."
        Copy-Item "surfaces\windsurf-dev\styles.css" -Destination "."
        Copy-Item "surfaces\windsurf-dev\windsurf-dev.js" -Destination "."
        git add index.html styles.css windsurf-dev.js
        git commit -m "Initial Windsurf Developer deployment"
        Write-Host "✓ gh-pages branch created" -ForegroundColor Green
    }
    
    # Switch back to master
    git checkout master
    
    # Push to GitHub
    Write-Host ""
    Write-Host "=== Pushing to GitHub ===" -ForegroundColor Cyan
    git push origin gh-pages --force
    Write-Host "✓ Pushed to GitHub" -ForegroundColor Green
    
    Write-Host ""
    Write-Host "=== GitHub Pages Setup ===" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "1. Go to your GitHub repository Settings" -ForegroundColor Yellow
    Write-Host "2. Navigate to Pages section (left sidebar)" -ForegroundColor Yellow  
    Write-Host "3. Source: Deploy from a branch" -ForegroundColor Yellow
    Write-Host "4. Branch: gh-pages" -ForegroundColor Yellow
    Write-Host "5. Folder: / (root)" -ForegroundColor Yellow
    Write-Host "6. Click Save" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Your Windsurf Developer will be available at:" -ForegroundColor Green
    Write-Host "https://alex-place.github.io/lantern-os/" -ForegroundColor Green
    Write-Host ""
    
} catch {
    Write-Error "Deployment failed: $_"
    git checkout master
    exit 1
}

Write-Host "=== Deployment Complete ===" -ForegroundColor Green
Write-Host "Enable GitHub Pages in repository settings to activate" -ForegroundColor Yellow
Write-Host ""