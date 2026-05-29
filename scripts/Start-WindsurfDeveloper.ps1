# Simple Windsurf Developer Launcher
# Open the Windsurf Developer interface directly

$windsurfPath = "d:\tmp\lantern-os\surfaces\windsurf-dev\index.html"

if (Test-Path $windsurfPath) {
    Write-Host "Opening Windsurf Developer..." -ForegroundColor Cyan
    Start-Process $windsurfPath
    Write-Host "Windsurf Developer opened in browser" -ForegroundColor Green
} else {
    Write-Error "Windsurf Developer not found at: $windsurfPath"
    Write-Host "Make sure you are in the Lantern OS repository directory" -ForegroundColor Yellow
}