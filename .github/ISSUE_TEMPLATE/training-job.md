---
name: Training job
about: Queue a training/eval run for the fleet. Jobs appear on /orchestration.html and run as autonomous work.
title: "train: <what and why>"
labels: training-job
---

<!-- The fenced block below is the machine-readable job. Flat `key: value` lines only.
     `script` must be on the allowlist in apps/lantern-garage/routes/training-jobs.js
     (repo-tracked training/eval entry points — extend it by PR, one line at a time). -->

```training-job
script: scripts/train_qlora_qwen_coder.py
args: --seed 1 --epochs 1
dataset: data/eval/spiral/self-train/spiral-self-train-v1.jsonl
vram_gb: 8
```

## Why this run

<!-- One paragraph: what question does this run answer, and where will the result be
     recorded (leaderboard row / ledger)? Runs that answer no question get closed. -->

## Acceptance

<!-- What gates the result: held-out eval, paired-diff vs which baseline, multi-seed? -->
