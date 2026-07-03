---
author: Alex Place
created: 2026-07-02
---

# Local Qwen → Ouro crystallization — a cloud-free distillation teacher (2026-07-02)

**Loop stage:** Reason (model selection) + Verify (execution-gated distillation) + Converge
(eval-gated promote).
**Status:** pipeline built + executed; candidate eval-gated (see Results).
**Council:** Σ₀ EV council branch (`claude/sigma0-ev-council`) — research + follow-up.

## Question

Can we "crystallize" a stronger local model's coding skill into the small looped Ouro
student **without any cloud teacher** — using the verified-capable local **Qwen2.5-Coder-7B**
as the teacher instead of a frontier Anthropic model?

Motivation: the existing Σ₀ trace-distillation flywheel
([SIGMA0-CONTINUAL-TRAINING.md](../SIGMA0-CONTINUAL-TRAINING.md)) already turns
execution-verified solutions into a better Ouro adapter, but its teacher
(`gen_sigma0_traces.py`) was hardwired to the **Anthropic cloud API**. That couples the
flywheel to a paid external dependency and to network availability — friction the
[Σ₀ Briefing](../CONVERGANCE-SIGMA0-BRIEFING.md) "fully local / offline by design" posture
wants gone.

## What "crystallize" means here

Knowledge distillation with a **hard external gate**, not soft-label mimicry:

```
 Qwen2.5-Coder-7B (teacher)                         Ouro-1.4B (student)
        │  solves each task under the Σ₀ prompt              ▲
        ▼                                                    │ QLoRA on ONLY green traces
   candidate code ──▶ EXECUTE vs asserts ──▶ green? ─────────┘
                          (sandboxed subprocess, the Σ₀ ground-truth gate)
                              └─ red → dropped (never trains hallucination)
```

The teacher's capability is "crystallized" into the student **only through solutions that
actually run**. A teacher that is merely *plausible* contributes nothing — same iron rule as
the cloud path, now with a local teacher.

## The change (implemented)

`scripts/gen_sigma0_traces.py` teacher is now **pluggable** (`--teacher-backend
auto|cloud|local`, `--teacher-endpoint`):

- **cloud** — the existing Anthropic Messages API path (unchanged; still the default for
  `claude-*` ids).
- **local** — a new `teacher_solve_local()` that POSTs to any Ollama-compatible
  `/api/chat` server (default `http://127.0.0.1:11434`), greedy/non-streaming, under the
  same `SIGMA0_SYS` prompt. A teacher id that looks local (has a `:` like `qwen2.5-coder:7b`,
  or is on the local-name allowlist) auto-routes here.

Two supporting fixes: `load_tasks()` now tolerates **list-valued `asserts`** (the
`data/ouro-corpus-raw.json` shape), and the `meta.teacher` provenance label reflects the
real backend (`local/qwen2.5-coder:7b` vs `anthropic/claude-opus-4-8`) so a training row's
origin is auditable.

Everything downstream is unchanged and reused:
- **train** — `scripts/train-qlora-ouro.py` (QLoRA r16/α32 on Ouro-1.4B).
- **eval + promote gate** — `scripts/continual_ouro_pipeline.py --candidate <dir> --eval
  --promote`: re-evaluates the incumbent `final/` **live** and swaps only on a HumanEval
  `pass@1` win (External Reality Rule; ties/regressions rejected).

> **Boundary preserved.** This is still **offline, opt-in, outside the live request path** —
> the North Star's "persistent learning, not weight modification" rule is intact. Making the
> teacher local *reduces* external coupling; it does not wire retraining into chat.

## Why Qwen as the teacher is the right call

- **It is the verified capable local peer.** In `local-model-registry.js` Qwen2.5-Coder-7B
  is the 8GB capability lever; Ouro-1.4B is the recurrent-depth kernel. Distilling the
  bigger local coder's *verified* solutions into the small looped student is exactly the
  "small model + adaptive depth punches above its size" trade the Ouro doc argues for.
- **No cloud, no key, no rate limit.** The whole flywheel now runs on one box.
- **The gate makes teacher quality self-limiting.** If Qwen is weaker than a frontier
  teacher, fewer traces pass execution — the corpus shrinks but never fills with wrong code.
  Quality is bounded by *green*, not by the teacher's confidence.

## Sequencing on a single 12GB GPU

Teacher inference and student training are **sequential** stages, so they don't contend:
serve Qwen (~5GB @ Q4) → generate + verify traces → unload Qwen → train Ouro QLoRA (~fits
after unload). The trading agents (~3.7GB) coexist with Qwen inference; training is gated to
after the teacher unloads.

## Results (measured on-box, 2026-07-02, RTX 4070 SUPER cc 8.9)

Seed run — end-to-end, fully local, no cloud:

- **Teacher:** `local/qwen2.5-coder:7b` @ `:11434` (ollama), greedy, Σ₀ prompt.
- **Tasks attempted:** 192 (`data/distill/crystallize-tasks.jsonl`, from `ouro-corpus-raw.json`).
- **Verified/kept:** **63** green traces → `data/distill/sigma0-traces.jsonl`
  (**verified_rate 0.328** — 129 dropped by the execution gate; teacher quality is
  self-limiting, exactly as intended).
- **Candidate adapter:** QLoRA r16/α32, bf16 4-bit, 3 epochs / 24 steps, train_loss
  0.53→0.20 (no NaN) → `C:/lantern-train/ouro-crystallize/final`.
- **Eval gate (HumanEval first-20, greedy):**
  - candidate **pass@1 0.10** (2/20; 14 *no-parse*)
  - incumbent `final/` **pass@1 0.65** (13/20)
  - Δ **−0.55** → **REJECT**. Incumbent untouched; Convergence Record in
    `data/eval/ouro-promotion-log.jsonl`.

**The pipeline is validated; this candidate is not an improvement — and the gate correctly
refused to promote it.** That is the intended behavior (External Reality Rule), not a failure
of the run.

### Why the seed candidate regressed (the real finding)

- **Trained from BASE Ouro-1.4B, not from the incumbent.** `train-qlora-ouro.py` fits a fresh
  LoRA on the 63 traces alone, so it *replaces* the incumbent's learned behavior with a narrow
  one instead of *adding* to it — classic catastrophic-narrowing. The 14 *no-parse* failures
  are the tell: the model over-fit the short "define `fn`, return one line" trace shape and
  lost HumanEval's `def name(...):` completion format.
- **63 short single-function traces is too small and too easy** to lift a general coding eval.

### Follow-up (to make crystallization actually win)

1. **Continue-train from the incumbent adapter**, not base — so distillation *augments* rather
   than *overwrites*. (Needs a small trainer change: init LoRA from `final/` or merge-then-tune.)
2. **Grow + harden the corpus** — more tasks, HumanEval-shaped signatures, multi-function and
   edge-case problems; a stronger `--teacher` (or a cloud teacher) raises the green yield.
3. Re-run the same eval gate; promote only on a measured win.

## What this does NOT claim

- Not a frontier-quality teacher. Qwen-7B < a frontier model; the corpus reflects that. The
  value is a **self-contained** flywheel, not a maximal one — swap `--teacher` back to a
  cloud model any time for a stronger (paid) corpus.
- A single seed run is a proof of pipeline, not a capability ceiling. The eval gate is the
  arbiter of whether any given candidate is actually better.

## Related

- [SIGMA0-CONTINUAL-TRAINING.md](../SIGMA0-CONTINUAL-TRAINING.md) — the flywheel this extends
- [SIGMA0-OURO-CODER.md](../SIGMA0-OURO-CODER.md) — the looped student
- [SIGMA0-CONVERGENCE-ADAPTER.md](../SIGMA0-CONVERGENCE-ADAPTER.md) — the "unverified traces
  train hallucination" rule
</content>
</invoke>
