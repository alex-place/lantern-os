---
author: Alex Place
created: 2026-06-18
updated: 2026-06-20
---

# lantern-sigma0-coder — local Σ₀ coding agent

`lantern-sigma0-coder` is Keystone OS's **own local coding model**: a LoRA fine-tuned on the
project's past Claude Code engineering sessions, served through Ollama, and routed to work by
the performance leaderboard. It is the local-first coder behind autowork and the Keystone
engineering desk — continually retrained so it keeps getting better at *this* codebase.

> **Status (2026-06-18):** trained, deployed, wired, and leaderboard-routed. Base is **3B**
> (fits the dev GPU); see [Honest scope](#honest-scope).

---

## What it is

| | |
|---|---|
| **Profile** | `lantern-sigma0-coder` (registry `text.coder`) |
| **Deployed model** | `lantern-sigma0-coder-v2` (Ollama) |
| **Base** | `Qwen/Qwen2.5-Coder-3B-Instruct` |
| **Training** | QLoRA (peft + bitsandbytes) on 365 pairs from 51 Claude Code sessions; 3 epochs / 135 steps; loss 2.87 → 1.78 |
| **Serving** | Ollama (`OLLAMA_MODELS=D:\ollama-models`, `OLLAMA_MODEL=lantern-sigma0-coder-v2`) |
| **Routing** | leaderboard-preferred (see below) |

It plugs into the existing provider cascade as a first-class **local** candidate — zero cost,
private (no data leaves the machine), and grounded in a Σ₀ system prompt about this repo.

## How it fits the loop

`Observe → Remember → Reason → Act → Verify → Converge`. This model serves the **Reason/Act**
stages for coding work. It does not add a new subsystem — it's a model that plugs into the
Model-Broker, selected by the same leaderboard that ranks every other agent.

## Leaderboard-preferred routing (PCSF)

Local model selection is **leaderboard-driven**, not hardcoded:

- [`lib/model-leaderboard.js`](../apps/lantern-garage/lib/model-leaderboard.js) — `orderChainByLeaderboard()` reorders the Ollama model chain by `agent-performance` **compositeScore** (success ÷ latency ÷ cost); the trained model is always a candidate for coding/work. `recordModelOutcome()` feeds every local answer + failure back in.
- [`lib/agent-performance.js`](../apps/lantern-garage/lib/agent-performance.js) — the leaderboard (`getTopAgentsForTask`).
- [`lib/stream-chat.js`](../apps/lantern-garage/lib/stream-chat.js) — the Ollama path is leaderboard-ordered and records each outcome.

So the model that actually *performs best on real work* rises to the top — training proposes,
real performance disposes.

## Continual training

[`scripts/continual-train.ps1`](../scripts/continual-train.ps1) runs one improvement cycle:

1. **Refresh data** — `scripts/extract-session-pairs.py` (new Claude sessions) → `scripts/convert-pairs-to-alpaca.py`.
2. **Train** — `scripts/train-qlora-peft.py` → new LoRA version.
3. **Merge** — `scripts/merge-lora.py` → fp16.
4. **Deploy** — `ollama create lantern-sigma0-coder-vN`.
5. **Promote** — point `OLLAMA_MODEL` at the new version; the leaderboard arbitrates real usage (rollback = point `OLLAMA_MODEL` at a prior `vN`).

Schedule it (operator opt-in) to keep improving:
```
schtasks /Create /TN "LanternSigma0ContinualTrain" /TR "powershell -ExecutionPolicy Bypass -File C:\dev\lantern-os\scripts\continual-train.ps1" /SC WEEKLY /D SUN /ST 03:00 /F
```

## Rebuild / retrain

```bash
# 1. data
python scripts/extract-session-pairs.py
python scripts/convert-pairs-to-alpaca.py
# 2. train (isolated CUDA venv; GPU required)
.venv-train/Scripts/python scripts/train-qlora-peft.py \
  --base Qwen/Qwen2.5-Coder-3B-Instruct \
  --data models/lantern-sigma0-coder/training-data.jsonl --out D:/lantern-train/sigma0-adapters --epochs 3
# 3. merge + deploy
.venv-train/Scripts/python scripts/merge-lora.py Qwen/Qwen2.5-Coder-3B-Instruct D:/lantern-train/sigma0-adapters/final D:/lantern-train/sigma0-merged
ollama create lantern-sigma0-coder-v2 -f D:/lantern-train/Modelfile.v2
```

## Files

| Path | Role |
|---|---|
| `models/lantern-sigma0-coder/Modelfile` | Stage-1 prompt-grounded model (over `qwen2.5-coder`) |
| `models/lantern-sigma0-coder/Modelfile.v2` | Stage-2 build record (LoRA-merged) |
| `apps/lantern-garage/lib/model-registry.js` | `text.coder` profile registration |
| `apps/lantern-garage/lib/model-leaderboard.js` | leaderboard-preferred routing |
| `scripts/extract-session-pairs.py` | extract training pairs from Claude sessions |
| `scripts/convert-pairs-to-alpaca.py` | → alpaca format for QLoRA |
| `scripts/train-qlora-peft.py` | Windows-friendly QLoRA trainer |
| `scripts/merge-lora.py` | merge adapter → fp16 |
| `scripts/continual-train.ps1` | continual-training orchestrator |

**Off-repo (privacy + size):** adapter, merged weights, GGUF, and session-derived training
JSONL live on `D:\` (`D:\lantern-train`, `D:\ollama-models`) and are gitignored — never committed.

## Honest scope

- Base is **3B, not 7B** — the dev GPU (RTX 3070, 8 GB) can't train 7B QLoRA reliably. Move to a bigger GPU for 7B.
- It is a **single-pass** LoRA on 365 pairs — a genuine fine-tune, not production-grade. Quality ratchets up via continual training + leaderboard arbitration.
- `unsloth` was skipped (broken on native Windows); the portable `peft`/`bitsandbytes` path is used.

## Related
- Epic / progress: [issue #690](https://github.com/alex-place/lantern-os/issues/690)
- Handoff: [docs/handoffs/sigma0-coder-training-2026-06-18.md](handoffs/sigma0-coder-training-2026-06-18.md)
- Providers & routing: [PROVIDERS.md](../PROVIDERS.md)
