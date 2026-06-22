# Full combined QLoRA retraining: coding + FC positives + irrelevance negatives
# Usage: powershell -ExecutionPolicy Bypass -File scripts\retrain-combined.ps1
# Logs stdout to D:/lantern-train/retrain-combined.log (stderr goes to console/caller)
# Runtime: 4-12 hours depending on step speed + dataset size

$VENV_PY = "$PSScriptRoot\..\.venv-train\Scripts\python.exe"
if (-not (Test-Path $VENV_PY)) {
    Write-Error "venv-train not found at $VENV_PY"; exit 1
}

$LOG    = "D:\lantern-train\retrain-combined.log"
$OUTDIR = "D:\lantern-train\ouro-sigma0-combined-adapters"
$TMPDIR = "D:\lantern-train"
$REPO   = (Resolve-Path "$PSScriptRoot\..").Path

New-Item -ItemType Directory -Force -Path $TMPDIR | Out-Null

function Log($msg) {
    $ts = (Get-Date -Format "HH:mm:ss")
    $line = "$ts  $msg"
    Write-Host $line
    Add-Content -Path $LOG -Value $line -Encoding UTF8
}

# Truncate UTF-8 (no BOM) log on fresh start
[System.IO.File]::WriteAllText($LOG, "", [System.Text.UTF8Encoding]::new($false))

Log "=== combined retrain start ==="
Log "venv:   $VENV_PY"
Log "output: $OUTDIR"

# Dataset size controls — tune based on GPU step speed:
#   fast GPU (< 1 min/step): use defaults (all rows, ~15k total)
#   slow GPU (~2 min/step):  set HERMES_LIMIT=800 NEG_LIMIT=400 (12-hr budget)
#   medium (~1.5 min/step):  set HERMES_LIMIT=1200 NEG_LIMIT=600
$HERMES_LIMIT = if ($env:HERMES_LIMIT) { @("--limit", $env:HERMES_LIMIT) } else { @() }
$NEG_LIMIT    = if ($env:NEG_LIMIT)    { @("--limit", $env:NEG_LIMIT) }    else { @() }
$SEQ_LEN      = if ($env:SEQ_LEN)      { $env:SEQ_LEN }                    else { "1536" }
$LORA_R       = if ($env:LORA_R)       { $env:LORA_R }                     else { "32" }
$EPOCHS       = if ($env:EPOCHS)       { $env:EPOCHS }                     else { "3" }
# MAX_STEPS caps training to fit a time budget.
# Measured: seq=4096 → 39 min/step; seq=1536 → ~25-30 min/step (attention 7x cheaper)
# 12-hour budget: 720 min / 25 min = 28 steps.  Default 24 leaves a safety margin.
# Override: $env:MAX_STEPS = "50" for an overnight run.
$MAX_STEPS    = if ($env:MAX_STEPS)    { $env:MAX_STEPS }                   else { "24" }

Log "config: seq=$SEQ_LEN  r=$LORA_R  epochs=$EPOCHS  max_steps=$MAX_STEPS  hermes_limit=$($HERMES_LIMIT -join ' ')  neg_limit=$($NEG_LIMIT -join ' ')"

# ─── step 1: build FC hermes (positives) ──────────────────────────────────────
Log "--- step 1/4: convert hermes FC (positives) ---"
& $VENV_PY "$REPO\scripts\convert_fc_dataset.py" `
    --source hermes `
    --out    "$TMPDIR\fc-hermes.jsonl" `
    --max-chars 8000 `
    @HERMES_LIMIT
if ($LASTEXITCODE -ne 0) { Log "ERROR: hermes convert failed ($LASTEXITCODE)"; exit $LASTEXITCODE }
Log "hermes done"

# ─── step 2: build xlam-irrelevance (negatives) ────────────────────────────────
Log "--- step 2/4: convert xlam-irrelevance (negatives) ---"
& $VENV_PY "$REPO\scripts\convert_fc_dataset.py" `
    --source irrelevance `
    --out    "$TMPDIR\fc-negatives.jsonl" `
    @NEG_LIMIT
if ($LASTEXITCODE -ne 0) { Log "ERROR: irrelevance convert failed ($LASTEXITCODE)"; exit $LASTEXITCODE }
Log "irrelevance done"

# ─── step 3: merge coding + FC via Python (avoids PS BOM issue) ────────────────
Log "--- step 3/4: merge coding + FC into combined dataset ---"
$MERGE_PY = @"
import sys, json, pathlib
sources = [
    r'$($REPO.Replace("\","\\"))\models\lantern-sigma0-coder\training-data.jsonl',
    r'$($TMPDIR.Replace("\","\\"))\fc-hermes.jsonl',
    r'$($TMPDIR.Replace("\","\\"))\fc-negatives.jsonl',
]
out_path = r'$($TMPDIR.Replace("\","\\"))\combined-training.jsonl'
rows = 0
with open(out_path, 'w', encoding='utf-8') as fout:
    for src in sources:
        p = pathlib.Path(src)
        if not p.exists():
            print(f'MISSING: {p}'); sys.exit(1)
        for line in p.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if not line: continue
            try: json.loads(line)
            except: continue
            fout.write(line + '\n'); rows += 1
print(f'combined rows: {rows}  ->  {out_path}')
"@
& $VENV_PY -c $MERGE_PY
if ($LASTEXITCODE -ne 0) { Log "ERROR: merge failed ($LASTEXITCODE)"; exit $LASTEXITCODE }

$COMBINED = "$TMPDIR\combined-training.jsonl"
$rowCount  = (Get-Content $COMBINED | Measure-Object -Line).Lines
Log "combined rows: $rowCount  -> $COMBINED"

# ─── step 4: train ─────────────────────────────────────────────────────────────
Log "--- step 4/4: QLoRA training (seq=$SEQ_LEN, r=$LORA_R, epochs=$EPOCHS) ---"
Log "started: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
& $VENV_PY "$REPO\scripts\train-qlora-ouro.py" `
    --base   ByteDance/Ouro-1.4B `
    --data   $COMBINED `
    --out    $OUTDIR `
    --seq       $SEQ_LEN `
    --lora-r    $LORA_R `
    --epochs    $EPOCHS `
    --max-steps $MAX_STEPS
if ($LASTEXITCODE -ne 0) { Log "ERROR: training failed ($LASTEXITCODE)"; exit $LASTEXITCODE }

Log "=== combined retrain DONE ==="
Log "finished: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Log "adapter -> $OUTDIR\final"
Log "to serve: set OURO_ADAPTER=D:/lantern-train/ouro-sigma0-combined-adapters/final and restart ouro_serve.py"
