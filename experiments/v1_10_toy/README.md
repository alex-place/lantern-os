# v1.10 toy harness — white-box verified-honesty, tested small

This is the **cheap, falsifiable** version of the v1.10 design: prove the load-bearing
mechanism on small open models *before* anyone funds a from-scratch training run
(the proof-before-approval gate the founder asked for).

## The one claim that must hold

> With **open weights** you can verify honesty in the **activations**, not just the output
> tokens — and that is what defeats the E1 gloss (the honesty tune that learned a surface
> shortcut instead of the concept). A rented black-box API can never do this.

If that claim fails at small scale, the whole v1.10 program should be down-scoped or killed.
If it holds — and improves with more verified data — the scale-up is justified by a measured
curve instead of faith.

## Two scripts

### 1. `probe_seeinthebox.py` — can we see into the box?
Reproduces the **E1 confound** in miniature on a small model (default `Qwen2.5-0.5B-Instruct`):
balanced true/false arithmetic statements in two variants — **de-glossed** (bare claim) and
**glossed** (an epistemic marker leaks the label, the shortcut). It reads mid-layer hidden
states and trains a linear probe per layer.

- De-glossed probe stays strong ⇒ the truth signal is genuinely *in the box*; a probe-audited
  student can be checked for **internal** honesty. Mechanism OK.
- De-glossed probe collapses to chance ⇒ at this scale the model doesn't internally represent
  truth; the probe would read noise/gloss. Honest negative → need a bigger base first.

```bash
C:/dev/lantern-os/.venv-train/Scripts/python.exe experiments/v1_10_toy/probe_seeinthebox.py --n 300
```

### 2. `build_linked_records.py` — training-set expansion by linking verified events
Seeds the corpus expansion by mining live PRs into **both-class** records with provenance that
points at the verifier:
- **merged + CI-green** → verified POSITIVE
- **reverted by a later PR** (title-linked) → verified NEGATIVE (+ correction link)
- **closed-unmerged** → soft NEGATIVE

```bash
C:/dev/lantern-os/.venv-train/Scripts/python.exe experiments/v1_10_toy/build_linked_records.py --limit 300
```

Writes a **sample** (`linked-records.sample.jsonl`), never the canonical ledger.

## What the smoke run already showed (honest, measured)
- The miner works, but a healthy repo's recent PRs are ~94% clean merges (negative fraction
  ≈ 0.06). **Confirms the E1 data problem persists even in PR mining** → the real honest-negatives
  must come from *session corrections* (`scripts/session_to_convergence.py`) and *full-history
  reverts/hotfixes*, not recent merges. This is a design finding, tracked in the v1.10 issues.

## How this maps to the full design
This toy is the smallest end of the v1.10 epic. The full program (GitHub epic + children):
expand the corpus over all 243 sessions + ~2840 PRs, upgrade to best practices
(de-gloss lint, balanced-negative ratio, decontamination, LOSO splits, provenance-to-verifier),
add arXiv/patent prior-art grounding, use the hidden-state probe as a **held-out** verifier
(never a training loss — Goodhart), and gate any from-scratch train on a measured dose-response
curve. Built on existing scripts (`session_to_convergence.py`, `pr_crystallize.py`,
`decontaminate_training.py`) — least-sprawl.

**Not a capability claim.** Arithmetic ground-truth, one small model, no fine-tune. It tests the
*method*, cheaply, so the expensive program is only funded if the method survives.
