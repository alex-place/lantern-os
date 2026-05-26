$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$htmlPath = Join-Path $root "surfaces\tony-garage\index.html"
$cssPath = Join-Path $root "surfaces\tony-garage\styles.css"
$jsPath = Join-Path $root "surfaces\tony-garage\garage.js"

foreach ($path in @($htmlPath, $cssPath, $jsPath)) {
    if (-not (Test-Path $path)) { throw "Missing surface file: $path" }
}

$html = Get-Content -LiteralPath $htmlPath -Raw
$css = Get-Content -LiteralPath $cssPath -Raw
$js = Get-Content -LiteralPath $jsPath -Raw

$checks = @(
    [pscustomobject]@{ name = "doctype"; ok = $html -match "(?is)<!doctype html>" },
    [pscustomobject]@{ name = "viewport"; ok = $html -match 'name="viewport"' },
    [pscustomobject]@{ name = "skip-link"; ok = $html -match 'class="skip-link"' },
    [pscustomobject]@{ name = "main-target"; ok = $html -match '<main id="main"' },
    [pscustomobject]@{ name = "cache-busted-css"; ok = $html -match 'styles\.css\?v=' },
    [pscustomobject]@{ name = "deferred-js"; ok = $html -match 'garage\.js\?v=' },
    [pscustomobject]@{ name = "new-tab-class"; ok = $html -match 'class="[^"]*new-tab' },
    [pscustomobject]@{ name = "image-alt"; ok = $html -match '<img [^>]*alt="[^"]{12,}"' },
    [pscustomobject]@{ name = "focus-visible"; ok = $css -match ':focus-visible' },
    [pscustomobject]@{ name = "reduced-motion"; ok = $css -match 'prefers-reduced-motion' },
    [pscustomobject]@{ name = "mobile-media"; ok = $css -match 'max-width: 560px' },
    [pscustomobject]@{ name = "noopener"; ok = $js -match 'noopener noreferrer' },
    [pscustomobject]@{ name = "target-blank"; ok = $js -match 'target", "_blank"' },
    [pscustomobject]@{ name = "cache-bust-js"; ok = $js -match 'v=" \+ stamp' }
)

$failed = @($checks | Where-Object { -not $_.ok })
$result = [pscustomobject]@{
    generatedAt = (Get-Date).ToString("o")
    ok = ($failed.Count -eq 0)
    failed = $failed
    checks = $checks
}

$outPath = Join-Path $root "manifests\validation\TONY-GARAGE-SURFACE-LATEST.json"
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $outPath -Encoding UTF8

if ($failed.Count -gt 0) {
    $failed | Format-Table -AutoSize
    throw "Tony Garage surface validation failed."
}

Write-Output $outPath
