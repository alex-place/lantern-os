---
title: Σ₀ Ouro Coder — Dev-Box Setup & Handoff
created: 2026-06-21
purpose: stand up the Σ₀ coder + Claude-Code-integration work on a SECOND machine so it can be worked across two boxes
---

# Σ₀ Ouro Coder — Dev-Box Setup & Handoff

Goal: continue the local Σ₀ Ouro-1.4B coder work (FC retraining + the Claude-Code
bridge + tool-aware chat) on a second machine. **Code travels via git; the model,
adapter, env, and datasets do not** — this guide covers exactly what to pull,
download, copy, or regenerate, and what must NOT be copied (key-leak risk).

## TL;DR — what moves how

| Artifact | How it gets to the dev box | Notes |
|---|---|---|
| All code (scripts, bridge, agent loop, `tool-runner.js`, docs) | **`git clone` / `git pull` origin/master** | already merged (v1.7.14) |
| Base model `ByteDance/Ouro-1.4B` | **HF download** on first run | ~2.8 GB; set `HF_HOME` |
| **FC LoRA adapter** (`ouro-sigma0-fc-adapters/final`, 63 MB) | **copy the folder** (scp / drive) — weights only, safe | or re-train (below) |
| Public FC datasets (hermes/toolace/irrelevance) | **regenerate**: `scripts/convert_fc_dataset.py` | reproducible from HF |
| Repo-trace dataset (`tool-trace-pairs.jsonl`) | **re-harvest on the dev box** from ITS own CC sessions | machine-specific; ⚠ key-risk |
| `training-data.jsonl`, `training-data-5k.jsonl` | **DO NOT COPY** | ⚠ contain real key patterns — regenerate instead |
| API keys / secrets | set in the dev box's env (not in repo) | see §6 |

## 0. Prereqs (dev box)
- **NVIDIA GPU, ≥ 8 GB VRAM** (this work runs on an RTX 3070 8 GB). QLoRA train ≈ 38.5 s/step; serving ≈ 7 GB resident.
- **CUDA 12.1** runtime, **Python 3.11**, git.
- ⚠ **GPU-crash lesson:** do not run a 7 GB Ouro server *and* a second full `claude.exe` on an 8 GB card — it crashed the live session. One model process at a time on 8 GB.

## 1. Code (git)
```bash
git clone <repo-url> lantern-os && cd lantern-os    # or: git pull origin master
```
Everything is on `master`: `scripts/ouro_serve.py`, `scripts/ouro_anthropic_bridge.py`,
`scripts/sigma0_coder_agent.py`, `scripts/harvest_tool_traces.py`,
`scripts/convert_fc_dataset.py`, `scripts/train-qlora-ouro.py`,
`apps/lantern-garage/lib/{tool-runner,command-allowlist}.js`, and the docs
([retraining handoff](research/2026-06-21-sigma0-coder-retraining-handoff.md)).

## 2. Python env (`.venv-train`) — pinned versions matter
Ouro's custom modeling code **requires transformers 4.57**. Reproduce the exact stack:
```bash
python -m venv .venv-train
.venv-train/Scripts/activate            # Windows;  source .venv-train/bin/activate on Linux
pip install torch==2.5.1 --index-url https://download.pytorch.org/whl/cu121
pip install transformers==4.57.6 peft==0.19.1 bitsandbytes==0.49.2 accelerate datasets huggingface_hub
pip install -r requirements.txt          # the rest of the repo deps
```
(Linux bitsandbytes is smoother than Windows; either works at these versions.)

## 3. Base model
```bash
export HF_HOME=/path/to/hf-cache         # Windows: $env:HF_HOME="D:/hf-cache"
huggingface-cli download ByteDance/Ouro-1.4B    # or it auto-downloads on first serve/train
```

## 4. The trained FC adapter
The adapter is a **63 MB folder of weights** (no secrets) — safe to copy directly:
```
ouro-sigma0-fc-adapters/final/
  adapter_model.safetensors (60.7 MB)  adapter_config.json  chat_template.jinja
  tokenizer.json  tokenizer_config.json  vocab.json  merges.txt  special_tokens_map.json
```
Copy it to the dev box (any path) and point `OURO_ADAPTER` at it. **Or** skip the copy
and re-train from the corpus (§5 + §7). Trained on base `ByteDance/Ouro-1.4B`.

## 5. Datasets — regenerate, don't copy the risky ones
**Never copy** `training-data.jsonl`, `training-data-5k.jsonl`, or `tool-trace-pairs.jsonl`
to the dev box — they carry real API-key patterns harvested from local sessions. Instead:
```bash
# public FC positives + negatives (reproducible from HF, Apache/CC-BY):
.venv-train/Scripts/python scripts/convert_fc_dataset.py --source hermes      --out models/lantern-sigma0-coder/fc-hermes.jsonl
.venv-train/Scripts/python scripts/convert_fc_dataset.py --source toolace     --out models/lantern-sigma0-coder/fc-toolace.jsonl
.venv-train/Scripts/python scripts/convert_fc_dataset.py --source irrelevance --out models/lantern-sigma0-coder/fc-negatives.jsonl
# repo-trace positives: re-harvest from THIS box's own Claude Code sessions (redacts secrets):
.venv-train/Scripts/python scripts/harvest_tool_traces.py --out models/lantern-sigma0-coder/tool-trace-pairs.jsonl
# combine (keep negatives ~10-15% per the retraining handoff), then train (§7).
```

## 6. Secrets / env vars
| Var | Purpose |
|---|---|
| `HF_HOME` | model/dataset cache dir |
| `OURO_ADAPTER` | path to the FC adapter `final/` dir |
| `OURO_MODEL` | base, default `ByteDance/Ouro-1.4B` (NOT `-Thinking`, to match the adapter) |
| `OURO_NO_STOP=1` | disables codegen stop-strings so tool-call JSON isn't truncated (needed for tool mode) |
| `CHAT_TOOL_EXEC=1` | (garage only) enables in-chat tool execution; off by default |
| `ANTHROPIC_API_KEY` etc. | provider keys — set in the dev box env, never commit |

## 7. Run it
```bash
# serve the adapter (Ollama-API drop-in on :11434)
OURO_ADAPTER=.../final OURO_NO_STOP=1 HF_HOME=... .venv-train/Scripts/python scripts/ouro_serve.py
# Anthropic bridge for the Claude-Code path (:8788)
.venv-train/Scripts/python scripts/ouro_anthropic_bridge.py
# standalone tool-using agent loop
.venv-train/Scripts/python scripts/sigma0_coder_agent.py "How many Python files are in scripts/?"
# retrain (the next lever — see the handoff for the rebalanced recipe)
.venv-train/Scripts/python scripts/train-qlora-ouro.py --data models/lantern-sigma0-coder/training-data.jsonl --epochs 2 --seq 1536
```

## 8. Working across the two boxes
- **Code:** git is the sync — branch off `origin/master`, PR, merge (monoworkstream: one open PR per `claude/` prefix; `SKIP_MONOWORKSTREAM=1` when a lane is full; bump `package.json` + `CHANGELOG.MD`).
- **Adapter:** not in git — sync the `final/` folder via a shared drive or scp whenever it's re-trained, or have each box re-train. Name adapters per box/run (e.g. `ouro-sigma0-fc-adapters-<box>`) to avoid clobbering.
- **Datasets:** regenerate on each box (§5) rather than syncing — the public parts are reproducible; the repo-trace part is per-box and key-risky.
- **Eval parity:** both boxes should run the same BFCL + the in-domain 6-tool eval (handoff §5) so adapters are comparable.

## 9. ⚠ Key-leak hygiene (local-only — master is clean)
Verified: **origin/master is clean** — the committed `training-data.jsonl` (95 KB),
`training-data.harvested.jsonl`, and `fc-*.jsonl` all scan **0 key hits**, and the
key-risky `tool-trace-pairs.jsonl` was never committed. The key patterns live **only in
the local working tree**: the regenerated/combined `training-data.jsonl` (62 MB),
`training-data-5k.jsonl`, and `tool-trace-pairs.jsonl` (harvested from local sessions).
Because `training-data.jsonl` is `.gitignore`d-but-already-tracked, a careless
`git add models/...` could commit your local 62 MB key-bearing version over the clean one —
**don't.** And don't copy those three local files to the dev box. Regenerate instead (§5).

## Where this stands (for the receiving dev)
Integration is **done and on master** (bridge + tool-aware chat + agent loop). The blocker
is **model reliability**: the current 1.4B FC adapter under-triggers / over-refuses (0/3 on
Claude-Code-shaped requests). The **rebalanced retrain** in the
[handoff](research/2026-06-21-sigma0-coder-retraining-handoff.md) (downweight Bash, diversify
the 3 refusal strings, drop negatives 25%→~10%, Hammer function-masking, 2 epochs) is the
next and highest-leverage step.
