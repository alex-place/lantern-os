# Σ₀ Continual-Training Loop — the closed flywheel

> ## 📖 In plain English (start here)
>
> **What this is:** the machinery that lets the local coding model **get better over
> time from its own work** — without a human hand-feeding it examples each round.
>
> **The loop, in one breath:** the system writes coding tasks → it actually *runs* the
> code to check each one really works → the ones that pass become study material → a new
> version of the model is trained on them → both the new and old versions sit a coding
> exam → the new one is kept **only if it scores higher**. If it doesn't beat the old one,
> nothing changes. Then it goes around again.
>
> **The honest part — proof beats claims.** A piece of code only becomes training data if
> it *survives execution* in a sealed sandbox. The model saying "this works" counts for
> nothing; only a green test run counts. Same for promotion: a new model is adopted only
> on a measured exam win, not a vibe.
>
> **What's actually built today:** the harvest step, the run-it-to-prove-it gate, and the
> keep-only-if-better promotion gate are all built and tested. The one expensive step —
> the actual retrain — is a button you press on the GPU box, **on purpose**: see the
> boundary note below.
>
> **The deliberate limit:** this loop runs **offline and only when you ask it to**. It is
> *not* wired into the live chat. That's not laziness — the project's North Star forbids
> the live loop from ever retraining its own weights. So the flywheel is real, but a human
> (or a scheduled job) is the one who spins it.
>
> The rest of this page is the precise version. ↓

---

This documents the **continual-training loop** for the
[Σ₀ Ouro Coder](SIGMA0-OURO-CODER.md): the offline pipeline that turns the system's own
execution-verified coding successes into a better local adapter, gated end-to-end by
ground truth. It closes the data→train→promote flywheel that was previously hand-cranked.

## The loop

```
 harvest ──▶ execution-verify ──▶ train ──▶ eval ──▶ EVAL-GATED promote ──▶ (repeat)
   │             │                   │         │              │
   │             │                   │         │              └─ swap final/ iff
   │             │                   │         │                 pass@1 ≥ incumbent + margin
   │             │                   │         └─ HumanEval pass@1 on candidate AND incumbent
   │             │                   └─ QLoRA r16/α32 on the verified set (gated; ~hours)
   │             └─ compile + exec + run asserts in an isolated subprocess
   │                THE Σ₀ GROUND-TRUTH GATE — only a green subprocess counts
   └─ gather {fn, instruction, code, asserts} from the system's own runs
```

| Stage | Script | Status |
|---|---|---|
| **harvest** | [`scripts/harvest_coding_corpus.py`](../scripts/harvest_coding_corpus.py) | ✅ built + run |
| **execution-verify** | `build_ouro_coding_dataset.load_extra_candidates` (sandboxed subprocess) | ✅ built + run |
| **train** | [`scripts/train-qlora-ouro.py`](../scripts/train-qlora-ouro.py) | ✅ built (GPU, opt-in) |
| **eval** | [`scripts/eval_humaneval_ouro.py`](../scripts/eval_humaneval_ouro.py) | ✅ built |
| **eval-gated promote** | [`scripts/continual_ouro_pipeline.py`](../scripts/continual_ouro_pipeline.py) `stage_promote` | ✅ built + self-tested |

The orchestrator is [`scripts/continual_ouro_pipeline.py`](../scripts/continual_ouro_pipeline.py).

## The two ground-truth gates

This loop has exactly two places where something is accepted, and **both require
external evidence**, per the Σ₀ rule (*nothing is accepted without evidence*):

1. **Into training — execution gate.** Every harvested candidate is compiled, `exec`'d,
   and run against its own `assert`s in an **isolated subprocess with a timeout**
   (`verify_candidate_sandboxed`). A model's claim that its code works does **not** count;
   only `returncode == 0` counts. Anything that errors, infinite-loops, or fails an
   assertion is dropped. *(Evidence: a first run verified **185/186** harvested
   candidates; the one drop was a real `AssertionError` the gate caught.)*

2. **Into production — eval gate.** A newly trained adapter replaces the live `final/`
   adapter **only if** its HumanEval `pass@1` beats the incumbent's by `--margin`
   (default: any strict improvement). Ties and regressions are rejected; `final/` is
   untouched. The decision is a pure, unit-tested function (`decide_promotion`); the
   incumbent is backed up to `final.bak-<ts>/` before any swap.

## Harvest sources

The harvester normalizes `{fn, instruction, code, asserts}` candidates from the system's
own runs, dedups (by name + code hash), and writes one `--extra-candidates` JSONL:

- **`data/ouro-corpus-raw.json`** — the multi-agent corpus receipt (a 12-agent run
  produced 192 candidates). *Populated today.*
- **`--source-jsonl <path>`** (repeatable) — the **live-run extension point**: any future
  stream of coding successes that autowork / keystone / chat emit as
  `{fn, instruction, code, asserts}` rows. *Interface built; no live emitter yet.*

**Normalization detail:** agent corpora emit a placeholder `def fn(...)` while labeling the
task with a descriptive name (`swap_case`). The harvester renames the function consistently
across instruction + code + asserts so the verifier accepts it and the training signal uses
real names.

**Deliberately NOT harvested:**
- `data/eval/humaneval/*.jsonl` passing completions — training on HumanEval would
  **contaminate** the `pass@1` eval the loop optimizes against. Excluded on purpose.
- `lessons.db` — that is the Kalshi/**trading** lessons store, not a coding-success source.

## The architectural boundary (why it's offline)

The [Σ₀ Briefing](CONVERGANCE-SIGMA0-BRIEFING.md) North Star states:

> **PERSISTENT LEARNING, NOT WEIGHT MODIFICATION.** Improve via retrieval and reasoning,
> not retraining.

QLoRA *is* weight modification. This loop survives that rule by being **offline, opt-in,
and outside the live request path**:

- It is a script you (or a cron) run — it is **never** invoked from chat / the live
  Observe→Reason→Act→Verify→Converge loop.
- The live loop still learns the Σ₀ way: append-only memory + routing leaderboard, no
  retraining.
- Promotion only swaps a **drop-in adapter** the model-broker already treats as one
  interchangeable local model — the architecture doesn't change, one pluggable brain does.

Wiring this into the live loop (auto-retrain on the fly) would cross that line and is
**out of scope by design**. The flywheel is real; a human or scheduled job spins it.

## Run it

```bash
# Safe default — harvest + execution-verify only; reports what WOULD train (no GPU):
.venv-train/Scripts/python scripts/continual_ouro_pipeline.py

# Verify the promote-gate logic with no GPU/model:
.venv-train/Scripts/python scripts/continual_ouro_pipeline.py --self-test

# Full loop on the GPU box (train → eval both → eval-gated promote):
.venv-train/Scripts/python scripts/continual_ouro_pipeline.py --train --eval --promote

# Eval-gate a pre-trained candidate against the incumbent (no retrain). The adapter dir
# is the one holding adapter_config.json — train-qlora-ouro.py writes that to <out>/final:
.venv-train/Scripts/python scripts/continual_ouro_pipeline.py \
    --candidate D:/lantern-train/ouro-sigma0-adapters/coding-v3/final --eval --promote --full
```

Outputs:
- `data/ouro-harvest-candidates.jsonl` — normalized candidates
- `models/lantern-sigma0-coder/training-data.harvested.jsonl` — base + verified rows (non-destructive)
- `data/eval/leaderboard.jsonl` — one `pass@1` summary row per eval
- `data/eval/ouro-promotion-log.jsonl` — append-only **Convergence Record** per promote decision

## Measured baseline (incumbent `final/`)

The promotion gate does **not** read a stored number — `stage_eval` **re-evaluates the
incumbent `final/` adapter live** each run and compares it to the candidate in memory.

**The full set is harder than the first-20 subset.** Logged points to date (FAST cached
path) were on a 20-problem slice: baseline HE-20 `pass@1 0.05` → coding-v3 HE-20
`pass@1 0.75`. The full 164-problem rerun (`ouro-final-rerun-full`) was attempted but
**did not complete** — no entry exists in `data/eval/leaderboard.jsonl` for it.
The in-flight partial (~67/115 at ~58% pass rate) is an **interrupted estimate, not a
measured result**. Treat the first-20 `0.75` as the only hard data point until the full
rerun completes. HumanEval's back half is materially harder; the real full-set figure is
likely well below `0.75` but is pending measurement.

> **Status (2026-06-22):** harvest + execution-verify + promote-gate **built, run, and
> tested** (adversarially reviewed — loop-breaking and data-quality findings fixed; the
> crash-safe promote swap is unit-tested incl. forced mid-swap failure → rollback).
> Full-HumanEval rerun of `final/` (`ouro-final-rerun-full`) **did not complete** — the
> eval was interrupted; `data/eval/leaderboard.jsonl` has no full-run entry.
> A 600-step combined adapter training run was started 2026-06-22 ~06:29 (est. ~6.3 hr);
> the eval + promote-gate have **not** been run against the resulting adapter yet.
>
> **Next required steps (see [#911](https://github.com/alex-place/lantern-os/issues/911)):**
> stop `ouro_serve.py` to free the GPU, then run:
> ```
> continual_ouro_pipeline.py --eval --promote --full --candidate <new-adapter-path>
> ```
> This will re-evaluate the incumbent live, compare against the candidate, and — if the
> candidate wins — swap it into `final/` and append a Convergence Record to
> `data/eval/ouro-promotion-log.jsonl`. Record the `ouro-final-rerun-full` `pass@1` in
> this section when it completes.

## Related
- [SIGMA0-OURO-CODER.md](SIGMA0-OURO-CODER.md) — the looped local coder this trains (single source of truth, incl. the adaptive-depth Q-exit mechanism)
- [CONVERGANCE-SIGMA0-BRIEFING.md](CONVERGANCE-SIGMA0-BRIEFING.md) — the North Star boundary
