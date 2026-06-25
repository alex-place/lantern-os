# Weekly Training Orchestration

## Overview

The Keystone OS now has a **weekly self-improvement loop** that:

1. **Dispatches training jobs** to free GPU providers (Kaggle + Lightning = 52 h/week)
2. **Runs HumanEval benchmarks** on the trained Ouro model
3. **Updates GitHub issues** with performance metrics and convergence findings

This is the **Act + Verify + Converge** stages of the Σ₀ loop, automated every Monday at 00:00 UTC.

## Architecture

### Scheduled Task: `KeystoneWeeklyTraining`

**When**: Every Monday at 00:00 UTC  
**What**: `scripts/weekly-training-orchestrator.py`  
**Location**: Windows Task Scheduler

Register manually:
```powershell
.\scripts\Schedule-WeeklyTraining.ps1
```

Or run immediately:
```powershell
.\scripts\Schedule-WeeklyTraining.ps1 -Run
```

### Components

#### 1. Training Dispatcher
**File**: `apps/lantern-garage/lib/training-dispatcher.js`

Routes training jobs to free providers in rotation:

| Provider | Priority | Quota | Automatable | Notes |
|----------|----------|-------|-------------|-------|
| Kaggle | 1 | 30 h/wk | ✓ Yes | T4/P100 GPU, Python CLI push |
| Colab | 2 | 22 h/wk | ✗ Manual | T4 GPU, 8h session cap |
| SageMaker | 3 | 28 h/wk | ✗ Manual | T4 GPU, 4h session cap |
| Lightning | 5 | 22 h/wk | ✓ Yes | T4/A10 GPU, API-driven |
| Paperspace | 4 | 0 h/wk | ✗ Paid | 8GB VRAM, requires PRO |

**Total free**: 102 h/week across all providers

#### 2. Checkpoint Transport
CSF archives → HuggingFace Hub → next provider

- **Pack**: Python `csf.pack()` on completed training
- **Upload**: `huggingface_hub.upload_file()` to `HF_TRAINING_REPO`
- **Download**: Next provider pulls via `hf_hub_download()`

**Repository**: `HF_TRAINING_REPO` (env var, default: `ouro-checkpoints`)

#### 3. Benchmarking
**File**: `experiments/humaneval_runner.py`

Runs HumanEval code-completion tasks:
- **Metrics**: pass@1, pass@10, pass@100
- **Output**: JSON with per-task breakdown
- **Cost**: ~30min on T4 GPU

#### 4. Issue Updates
**File**: `scripts/research-and-update-issues.py`

Researches and updates open issues with findings:

- **#1127** — Test matrix coverage analysis
- **#1167** — Chat routing mode collapse diagnosis

Posts comments with:
- Performance metrics
- Coverage gaps
- Convergence confidence scores ([claim, evidence, confidence, source])

## Orchestration Flow

```
Monday 00:00 UTC
    ↓
dispatch-all → Kaggle + Lightning
    ↓
[while not done]
    ↓ (poll every 5 min)
    ↓ wait for job completion
    ↓
    ↓ (timeout: 24h)
    ↓
✓ Training complete → run HumanEval
    ↓
✓ Benchmarks complete → update issues #1127, #1167
    ↓
✓ Done — archive convergence records
```

## Environment Variables

**Must set before first run:**

```powershell
# GitHub API access (for updating issues)
[System.Environment]::SetEnvironmentVariable('GITHUB_TOKEN', 'ghp_...', 'User')

# Hugging Face checkpoint storage
[System.Environment]::SetEnvironmentVariable('HF_TOKEN', 'hf_...', 'User')

# Optional: HF training repo override (default: ouro-checkpoints)
[System.Environment]::SetEnvironmentVariable('HF_TRAINING_REPO', 'your-org/repo', 'User')
```

**Kaggle + Lightning credentials** (synced from User scope automatically):

```powershell
# Kaggle (required for dispatch)
[System.Environment]::SetEnvironmentVariable('KAGGLE_API_TOKEN', 'KGAT_...', 'User')
# or legacy:
[System.Environment]::SetEnvironmentVariable('KAGGLE_USERNAME', 'your-username', 'User')
[System.Environment]::SetEnvironmentVariable('KAGGLE_KEY', 'your-key', 'User')

# Lightning (optional, for extra quota)
[System.Environment]::SetEnvironmentVariable('LIGHTNING_USER_ID', 'your-id', 'User')
[System.Environment]::SetEnvironmentVariable('LIGHTNING_API_KEY', 'your-key', 'User')
```

## Running Manually

### Full training + benchmarking cycle:
```bash
python scripts/weekly-training-orchestrator.py
```

### Just research + issue updates:
```bash
python scripts/research-and-update-issues.py --all
```

### Test a specific provider:
```bash
curl -X POST http://127.0.0.1:4177/api/gpu-training/dispatch \
  -H "Content-Type: application/json" \
  -d '{"provider": "kaggle", "steps": 600}'
```

### Poll job status:
```bash
curl -X POST http://127.0.0.1:4177/api/gpu-training/poll \
  -H "Content-Type: application/json" \
  -d '{"provider": "kaggle", "jobId": "your-kernel-id"}'
```

## Logs & Monitoring

### Training job history:
```
data/self-improvement/training-jobs.jsonl
```

Fields: `type`, `provider`, `status`, `jobId`, `steps`, `dispatchedAt`, `polledAt`

### Convergence records:
```
data/training/convergence-records.jsonl
```

Format: `{ timestamp, runId, type, provider, claim, evidence, confidence, source }`

### Real-time dashboard:
http://127.0.0.1:4177/orchestration.html

- Provider status + quota tracking
- Active job monitoring
- Recent run history
- Model reliability leaderboard

## Σ₀ Grounding (Verify Stage)

Every training dispatch + completion is logged as a **convergence record**:

```json
{
  "timestamp": "2026-06-25T00:00:00Z",
  "runId": "weekly-20260625-00:00:00",
  "type": "training_dispatch",
  "provider": "kaggle",
  "claim": "Dispatched 600-step training run on Kaggle Notebooks",
  "evidence": {
    "jobId": "lanternfounder/ouro-qlora",
    "kernelUrl": "https://www.kaggle.com/code/lanternfounder/ouro-qlora",
    "steps": 600
  },
  "confidence": 0.6,
  "source": "training_dispatcher"
}
```

**Confidence levels**:
- **1.0** = Done (verified execution, benchmark scores logged)
- **0.7** = Running (polled status, not yet complete)
- **0.6** = Dispatched (job submitted, not yet confirmed)
- **0.5** = Unknown (job status unclear)

## Future Enhancements

- [ ] **Parallel multi-provider dispatch** — fan out Kaggle + Lightning + Colab simultaneously
- [ ] **Checkpoint deduplication** — skip re-upload if SHA256 matches previous
- [ ] **Cost tracking** — per-provider GPU-hour cost breakdown
- [ ] **Model performance trending** — HumanEval pass@k chart over time
- [ ] **Adaptive dispatch strategy** — scale steps based on remaining quota
- [ ] **Slack notifications** — alert on job completion + benchmark results

## Troubleshooting

### Task didn't run
1. Check Windows Task Scheduler: `schtasks /query /tn KeystoneWeeklyTraining /v`
2. Verify Python is on PATH: `python --version`
3. Check repo permissions: `ls C:\dev\lantern-os\scripts\weekly-training-orchestrator.py`

### Dispatch failed
1. Verify GPU credentials are set: `python -c "import os; print(os.environ.get('KAGGLE_API_TOKEN'))"`
2. Test Kaggle CLI: `kaggle datasets list --limit 1`
3. Check Internet connectivity and API rate limits

### HumanEval not running
1. Install `human-eval` package: `pip install human-eval`
2. Verify CSF module is available: `python -c "import csf; print(csf.__file__)"`
3. Check HuggingFace Hub access: `huggingface-cli login`

### GitHub issue updates not posting
1. Set GITHUB_TOKEN: `echo $GITHUB_TOKEN`
2. Verify `gh` CLI is installed: `gh --version`
3. Authenticate: `gh auth login`

---

**Last updated**: 2026-06-25  
**Orchestrator version**: 1.0.0  
**GPU providers online**: 5/7 (Paperspace free tier removed)
