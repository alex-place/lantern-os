# Unisona crystallization — training an owned 8 GB coder on our own verified PRs

**Status:** Living · run-1 in flight · **Updated:** 2026-07-01

The Unisona plan: one local model for Keystone chat that completes long coding
tasks and calls our tools (creator dashboard, Lantern/Kalshi traders), trained
("crystallized") from **our own verified grounding** rather than distilled from a
frontier API. This doc records what is measured and built so far — every number
below has an on-disk artifact.

## Why crystallize instead of frontier-distill

Two council runs (11 + 12 agents, adversarially verified) established:

- **ToS:** OpenAI/Gemini/Anthropic terms all bar training a competing model on
  their outputs. Our merged PRs and permissive-license OSS PRs are clean.
- **Verification for free:** a merged PR is already verified — CI passed and a
  human merged it. `issue → diff` pairs need no re-execution gate.
- **Honesty:** black-box distillation transfers style, not capability; the prior
  Ouro flywheel scored 0.00–0.05 pass@1 held-out. The credible wins are
  Σ₀ format, calibration, tool-call adherence, and repo-shaped diffs — not
  out-coding Qwen. (North-Star framing: ADR-0010/0011 — offline, adapter-only,
  verify-gated; never runtime weight modification.)

## The corpus (built, on disk)

`scripts/pr_crystallize.py` (PR #1807) extracts merged PRs → training rows
(`{instruction, input, output, meta}` — the `gen_sigma0_traces.py` schema) with
secret/PII scrubbing, license gating for external repos, parallel `gh` fetch,
and an omni-CSF pack.

| Corpus fact | Value |
|---|---|
| Clean rows | **1,178** (`data/training/unisona-corpus.clean.jsonl`) |
| Self (this repo) | 452 |
| External permissive OSS | 726 — requests 118, express 117, pandas 115, flask 110, transformers 109, react 86, fastapi 71 |
| Decontamination | 13-gram vs 591 HumanEval+MBPP problems; 1 row dropped |
| Archive | `data/csf/unisona-crystallization.csf` — 6.11×, per-row sha256 |
| **Seq-fit finding** | only **530/1,178 rows fit seq=1536** (PR diffs are long). The 648 long rows are preserved in CSF for a ≥24 GB box (seq≈4096) or a future hunk-splitting pass. |

Training mix v1 = 530 seq-fit PR rows + 243 FC tool-calling rows = **773 rows**
(`data/training/unisona-train-v1.jsonl`).

## Baselines (the numbers to beat)

| Model | Set | pass@1 | ECE | Σ₀ format | Abstention |
|---|---|---|---|---|---|
| keystone-sigma0-plt 7.6B base, 4-bit | 6-task canonical smoke | **0.50** | **0.47** (overconfident) | 0.0 | 1.0 ✅ |
| Prior Ouro-1.4B adapters (old flywheel) | HumanEval held-out n=40 | 0.00–0.05 | — | — | — |

Recorded in `data/eval/keystone-plt-baseline.jsonl` and
`data/eval/leaderboard.jsonl`. Loading the PLT via AutoModel needs
`PYTHONPATH=<checkpoint dir>` (sibling `configuration_keystone_plt` import trips
transformers' `check_imports`).

## Run-1 (this box, in flight)

Ouro-1.4B QLoRA on the 773-row mix — 4-bit, LoRA r=16 (15.2 M trainable,
1.05%), seq 1536, 300 steps ≈ 3.7 h at ~45 s/step on the RTX 3070. Launched
**detached** (`Start-Process`; background shells die with session teardown —
a step-29 run was lost that way). Output: `D:/lantern-train/unisona-v1-adapters`,
checkpoint insurance at step 150.

## Gate (External Reality Rule)

After run-1: `eval_sigma0_adapter.py` head-to-head — untrained Ouro-1.4B control
vs base+adapter on the same 6 tasks + no-evidence abstention probes. The adapter
enters `lib/local-model-registry.js` as `verified:false` and cannot lead until a
reproduced on-box win. Win or lose, the result is logged as a convergence
record.

## Scale-out

**Issue #1829** is the cold-start handoff for a ≥24 GB workstation: full-corpus
Ouro run at seq=4096, Stage-0 true parity for the PLT (`check_parity.py --ref`,
blocking per ADR-0011/#1743), then the 7.6B PLT QLoRA — the two trainings an
8 GB box physically cannot do. Cloud alternates remain blocked (#1189).

## Grow the corpus

`pr_crystallize.py --repo <owner/repo>` harvests any permissive repo
(license-gated at run time). Next data levers: more big-name OSS repos,
hunk-splitting the 648 long diffs, and session-trajectory extraction
(`extract-session-pairs.py`, 243 sessions / 929 MB on disk).
