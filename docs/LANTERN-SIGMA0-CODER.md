---
author: Alex Place
created: 2026-06-18
updated: 2026-06-21
---

# lantern-sigma0-coder — local Σ₀ coding agent (ARCHIVED / SUPERSEDED)

> ## ⚠️ ARCHIVED — this is the *"then."* Read the current doc instead.
>
> **→ [SIGMA0-OURO-CODER.md](SIGMA0-OURO-CODER.md) is the single source of truth for the
> local Σ₀ coder.** It tells the full *then → now* story and folds in the loop mechanism.
>
> `lantern-sigma0-coder` was the **legacy** local coder: a **Qwen2.5-Coder-3B QLoRA**
> fine-tune served via the **Ollama binary**, routed by the performance leaderboard. It was
> **superseded by the [Σ₀ Ouro Coder](SIGMA0-OURO-CODER.md)** — the looped **Ouro-1.4B** model
> with a locally-trained Σ₀ QLoRA adapter — after the Ollama serving sunset (issue #811 /
> PR #823).
>
> This page is retained only as a tombstone so existing links don't break.

## What it was (historical)

A LoRA fine-tuned on the project's past Claude Code engineering sessions, served through
Ollama, and routed to work by the performance leaderboard. It backed autowork and the
Keystone engineering desk as the local-first coder.

| | |
|---|---|
| **Profile** | `lantern-sigma0-coder` (registry `text.coder`) |
| **Deployed model** | `lantern-sigma0-coder-v2` (Ollama) — **removed** |
| **Base** | `Qwen/Qwen2.5-Coder-3B-Instruct` |
| **Training** | QLoRA (peft + bitsandbytes) on 365 pairs from 51 Claude Code sessions; 3 epochs / 135 steps; loss 2.87 → 1.78 |
| **Serving** | Ollama binary (`OLLAMA_MODEL=lantern-sigma0-coder-v2`) — **sunset #811/#823** |
| **Routing** | leaderboard-preferred ([`lib/model-leaderboard.js`](../apps/lantern-garage/lib/model-leaderboard.js)) |

## Why it was retired

The dev GPU (RTX 3070, 8 GB) couldn't train 7B QLoRA reliably, so the Qwen coder was capped
at a 3B base. The **Ollama sunset** (#811 / #823) removed the external Ollama binary as a hard
dependency in favour of [`scripts/ouro_serve.py`](../scripts/ouro_serve.py), which speaks the
Ollama API directly — and that made it natural to swap the brain for **Ouro-1.4B**, whose
looped recurrent depth is a better trade for a small local model than a larger single-pass
one.

**Verified on disk (2026-06-20):** the Qwen training outputs
(`D:\lantern-train\sigma0-adapters`, `sigma0-merged`) were **removed** and
`lantern-sigma0-coder-v2` is **no longer registered in Ollama**. The Qwen continual-training
track (the old `scripts/continual-train.ps1` flow) was **deleted as bloat — do not rebuild
it.** The live coder and its retrain pipeline are:

- **[SIGMA0-OURO-CODER.md](SIGMA0-OURO-CODER.md)** — the current local coder (then → now + loop mechanism)
- **[SIGMA0-CONTINUAL-TRAINING.md](SIGMA0-CONTINUAL-TRAINING.md)** — the live offline retrain flywheel
