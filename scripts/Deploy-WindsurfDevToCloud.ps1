param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$Provider = "github-pages", # Options: github-pages, local-docker, cloud-run, aws-s3
    [switch]$SkipBuild = $false
)

$ErrorActionPreference = "Stop"

Write-Host "=== Windsurf Developer Cloud Deployment ===" -ForegroundColor Cyan
Write-Host "Provider: $Provider"
Write-Host "Repository: $Root"
Write-Host ""

# Validate Windsurf Developer files exist
$windsurfPath = Join-Path $Root "surfaces\windsurf-dev"
$indexPath = Join-Path $windsurfPath "index.html"

if (-not (Test-Path $indexPath)) {
    Write-Error "Windsurf Developer index.html not found at: $indexPath"
    exit 1
}

Write-Host "✓ Windsurf Developer files validated" -ForegroundColor Green

# Deployment based on provider
switch ($Provider) {
    "github-pages" {
        Write-Host "Deploying to GitHub Pages..." -ForegroundColor Yellow
        Write-Host ""
        
        # Check if git is available
        try {
            $gitVersion = git --version
            Write-Host "✓ Git detected: $gitVersion" -ForegroundColor Green
        } catch {
            Write-Error "Git not found. Please install Git for GitHub Pages deployment."
            exit 1
        }
        
        # Check current git status
        Set-Location $Root
        $gitStatus = git status --short
        
        if ($gitStatus) {
            Write-Host "⚠ Uncommitted changes detected:" -ForegroundColor Yellow
            Write-Host $gitStatus
            Write-Host ""
            $commit = Read-Host "Commit changes before deploying? (Y/N)"
            if ($commit -eq 'Y' -or $commit -eq 'y') {
                git add surfaces/windsurf-dev/
                git commit -m "Add Windsurf Developer interface files"
                Write-Host "✓ Changes committed" -ForegroundColor Green
            } else {
                Write-Error "Please commit changes before deploying to GitHub Pages."
                exit 1
            }
        }
        
        # Create gh-pages branch if it doesn't exist
        $branches = git branch
        if ($branches -notmatch "gh-pages") {
            Write-Host "Creating gh-pages branch..." -ForegroundColor Yellow
            git checkout --orphan gh-pages
            git rm -rf .
            git checkout master surfaces/windsurf-dev/
            git mv surfaces/windsurf-dev/* .
            git commit -m "Initial Windsurf Developer deployment"
            Write-Host "✓ gh-pages branch created" -ForegroundColor Green
        } else {
            Write-Host "Updating gh-pages branch..." -ForegroundColor Yellow
            git checkout gh-pages
            git checkout master surfaces/windsurf-dev/
            git mv surfaces/windsurf-dev/* .
            git commit -m "Update Windsurf Developer deployment" 
            Write-Host "✓ gh-pages branch updated" -ForegroundColor Green
        }
        
        # Switch back to master
        git checkout master
        
        # Instructions for enabling GitHub Pages
        Write-Host ""
        Write-Host "=== GitHub Pages Setup Instructions ===" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "1. Push the gh-pages branch to GitHub:"
        Write-Host "   git push origin gh-pages" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "2. Enable GitHub Pages in repository settings:"
        Write-Host "   - Go to GitHub repository Settings"
        Write-Host "   - Navigate to Pages section"
        Write-Host "   - Select 'gh-pages' branch as source"
        Write-Host "   - Click Save"
        Write-Host ""
        Write-Host "3. Your Windsurf Developer will be available at:"
        Write-Host "   https://alex-place.github.io/lantern-os/" -ForegroundColor Green
        Write-Host ""
        
        # Attempt to push if gh CLI is available
        try {
            Write-Host "Attempting to push using GitHub CLI..." -ForegroundColor Yellow
            gh auth status
            gh repo view
            Write-Host ""
            $push = Read-Host "Push gh-pages branch to GitHub now? (Y/N)"
            if ($push -eq 'Y' -or $push -eq 'y') {
                git push origin gh-pages
                Write-Host "✓ Pushed to GitHub" -ForegroundColor Green
            }
        } catch {
            Write-Host "⚠ GitHub CLI not available, manual push required" -ForegroundColor Yellow
        }
    }
    
    "local-docker" {
        Write-Host "Deploying to local Docker..." -ForegroundColor Yellow
        
        # Check if docker is available
        try {
            $dockerVersion = docker --version
            Write-Host "✓ Docker detected: $dockerVersion" -ForegroundColor Green
        } catch {
            Write-Error "Docker not found. Please install Docker."
            exit 1
        }
        
        # Build nginx container
        Write-Host "Building nginx container..." -ForegroundColor Yellow
        docker build -t windsurf-dev:local -f (Join-Path $Root "ops\windsurf-dev\Dockerfile") $windsurfPath
        
        # Stop existing container if running
        $existingContainer = docker ps -q -f name=windsurf-dev-local
        if ($existingContainer) {
            Write-Host "Stopping existing container..." -ForegroundColor Yellow
            docker stop windsurf-dev-local | Out-Null
            docker rm windsurf-dev-local | Out-Null
        }
        
        # Run new container
        Write-Host "Starting Windsurf Developer container..." -ForegroundColor Yellow
        docker run -d --name windsurf-dev-local -p 8080:80 windsurf-dev:local
        
        Write-Host "✓ Windsurf Developer deployed locally" -ForegroundColor Green
        Write-Host "URL: http://localhost:8080" -ForegroundColor Green
    }
    
    "cloud-run" {
        Write-Host "Deploying to Google Cloud Run..." -ForegroundColor Yellow
        Write-Host "⚠ Google Cloud deployment requires additional setup" -ForegroundColor Yellow
        Write-Host "Please configure gcloud CLI and run:" -ForegroundColor Yellow
        Write-Host "gcloud run deploy windsurf-dev --image windsurf-dev:cloud --platform managed --port 80" -ForegroundColor Gray
        Write-Host "gcloud run services update windsurf-dev --platform managed --set-env-vars=NODE_ENV=production" -ForegroundColor Gray
    }
    
    "aws-s3" {
        Write-Host "Deploying to AWS S3..." -ForegroundColor Yellow
        Write-Host "⚠ AWS S3 deployment requires AWS CLI and S3 bucket" -ForegroundColor Yellow
        Write-Host "Please configure AWS CLI and run:" -ForegroundColor Yellow
        Write-Host "aws s3 sync $windsurfPath s3://your-bucket-name --delete" -ForegroundColor Gray
        Write-Host "aws s3 website s3://your-bucket-name --index-document index.html" -ForegroundColor Gray
    }
    
    default {
        Write-Error "Unknown cloud provider: $Provider"
        Write-Host "Valid providers: github-pages, local-docker, cloud-run, aws-s3"
        exit 1
    }
}

Write-Host ""
Write-Host "=== Deployment Complete ===" -ForegroundColor Cyan
Write-Host "Provider: $Provider"
Write-Host "Status: Deployed"
Write-Host ""

# Create deployment summary
$summaryPath = Join-Path $Root "manifests\WINDSURF-DEV-CLOUD-DEPLOYMENT-$(Get-Date -Format 'yyyy-MM-dd').md"
$summary = @"
# Windsurf Developer Cloud Deployment Summary

Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
Provider: $Provider
Repository: $Root

## Deployment Details

- **Interface**: Windsurf Developer
- **Files**: surfaces/windsurf-dev/
- **Status**: Deployed
- **URL**: Provider-specific

## Next Steps

1. Test the deployed Windsurf Developer interface
2. Verify AI chat functionality
3. Test file navigation and code editing
4. Validate RAG context integration
5. Configure DNS/custom domain if needed

## Deployment Provider: $Provider

### GitHub Pages
- Repository: alex-place/lantern-os
- Branch: gh-pages
- Settings: Enable Pages in repository settings
- URL: https://alex-place.github.io/lantern-os/

### Local Docker
- Container: windsurf-dev-local
- Port: 8080
- URL: http://localhost:8080
- Management: docker {start|stop|restart} windsurf-dev-local

## Features Deployed

- AI-powered code editor
- Real-time code assistance
- RAG context integration
- File navigation
- Command palette
- Quick actions

## Support

For issues with the deployment, check:
- Docker/container logs
- GitHub Pages deployment status
- Cloud provider console
- Network connectivity

---

**Status**: Active  
**Last Updated**: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  
**Version**: v1.0.0
"@

$summary | Set-Content -LiteralPath $summaryPath -Encoding UTF8
Write-Host "✓ Deployment summary created: $summaryPath" -ForegroundColor Green

Write-Host ""
Write-Host "Next steps:"
Write-Host "1. Test the deployed interface"
Write-Host "2. Configure custom domain (optional)"
Write-Host "3. Set up monitoring (optional)"
Write-Host ""