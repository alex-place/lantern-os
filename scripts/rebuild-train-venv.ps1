<#
rebuild-train-venv.ps1 - recreate the GPU serving/training venv for ouro_serve.py.

Why this exists: the venv lives at D:\lantern-venv-train (surfaced into the repo as the
.venv-train junction) and the HF cache at D:\hf-cache. A D:-drive space cleanup has wiped
both at least once (2026-07-04), leaving a dangling junction and "no module named torch".
This script rebuilds them idempotently so recovery is one command, not archaeology.

Pins: torch cu121 (matches the historical build; runs fine on newer drivers) and
transformers==4.55.0 (matches the Ouro model config). Ouro's remote cache assigns to
key_cache/value_cache, which are read-only properties on transformers>=4.54 - so NO stock
version fixes it (older transformers lacks Ouro's other imports); ouro_serve.py patches the
class at runtime via ouro_compat.patch_universal_transformer_cache(). fp16 load needs no
bitsandbytes; pass -FourBit to add it for the OURO_4BIT NF4 path.

Usage:  powershell -ExecutionPolicy Bypass -File scripts/rebuild-train-venv.ps1 [-FourBit]
#>
param([switch]$FourBit)
$ErrorActionPreference = "Stop"

$VenvTarget = "D:\lantern-venv-train"
$Junction   = "C:\dev\lantern-os\.venv-train"
$HfHome     = "D:\hf-cache"

Write-Host "== 1. HF cache dir =="
Write-Host "   $HfHome"
if (-not (Test-Path $HfHome)) { New-Item -ItemType Directory -Force -Path $HfHome | Out-Null; Write-Host "   created" } else { Write-Host "   exists" }

Write-Host "== 2. venv target =="
Write-Host "   $VenvTarget"
if (Test-Path "$VenvTarget\Scripts\python.exe") {
    Write-Host "   venv already present, skipping create (delete the dir to force rebuild)"
} else {
    if (Test-Path $VenvTarget) { Remove-Item -Recurse -Force $VenvTarget }
    Write-Host "   creating venv with py -3.12 ..."
    & cmd /c "py -3.12 -m venv `"$VenvTarget`""
    if (-not (Test-Path "$VenvTarget\Scripts\python.exe")) { throw "venv creation failed" }
}
$VPy = "$VenvTarget\Scripts\python.exe"

Write-Host "== 3. repo junction =="
Write-Host "   $Junction to $VenvTarget"
if (Test-Path "$Junction\Scripts\python.exe") {
    Write-Host "   junction resolves"
} else {
    if (Test-Path $Junction) { cmd /c "rmdir `"$Junction`"" }
    cmd /c "mklink /J `"$Junction`" `"$VenvTarget`"" | Out-Null
    Write-Host "   (re)linked"
}

Write-Host "== 4. pip deps =="
& $VPy -m pip install --upgrade pip --quiet
Write-Host "   installing torch (cu121), the long pole ..."
& $VPy -m pip install torch --index-url https://download.pytorch.org/whl/cu121
Write-Host "   installing transformers==4.55.0 + serving deps ..."
& $VPy -m pip install "transformers==4.55.0" "accelerate>=1.0" safetensors sentencepiece protobuf "peft>=0.13"
if ($FourBit) { Write-Host "   installing bitsandbytes (4-bit path) ..."; & $VPy -m pip install bitsandbytes }

Write-Host "== 5. verify torch sees the GPU =="
& $VPy -c "import torch, transformers; print('torch', torch.__version__, 'cuda', torch.cuda.is_available(), '| transformers', transformers.__version__)"

Write-Host "== DONE. Load-test: <venv>\Scripts\python.exe scripts/ouro_serve_smoketest.py =="
