# Q-exit adaptivity + depth→accuracy against a REAL hardness proxy

**Date:** 2026-07-09 · **Evidence class:** MEASURED · **Loop stage:** Reason (adaptive compute)
**Artifacts:** `experiments/sigma0_hardness_depth.py`, `data/sigma0/hardness_depth_report.json`
**Settles:** #2025 (`sigma0_qexit_adaptive.py`) + #2028 (`sigma0_depth_accuracy.py`) · **Closes:** #2031

## Why

Two pilots left the adaptive-compute question open with weak proxies:

- **#2025:** `E[exit depth]` looked flat (~3.4/4) and correlated with *next-token entropy* (r=0.48) —
  but entropy is a poor stand-in for task difficulty.
- **#2028:** forcing recurrent depth didn't help on easy/clean arithmetic; the facts route was
  base-rate **confounded** and discarded.

This settles both against a **real** hardness proxy: the model's actual multi-step **solve-success**,
with matched-magnitude answer options (base rate 0.5), on a larger graded set.

## Method

Graded arithmetic, 4 tiers × 40 items = **160 items** (deterministic seed):
`t1` single-digit add → `t2` 2-digit add → `t3` 2-digit×1-digit → `t4` 2-digit×2-digit / two-step.

- **Difficulty is measured, not assumed.** Greedy-decode each item and check the answer — the per-tier
  **solve-success** rate *is* the difficulty axis (and we verify it really falls across tiers).
- **Adaptivity:** capture the Q-exit gate → `E[exit depth]` per item; test whether more depth is spent
  on harder items (per-item corr with solve-success, and per-tier `E[depth]` vs tier solve-success).
- **Depth → accuracy:** force `total_ut_steps ∈ {1,2,3,4,6,8}` and measure forced-choice accuracy
  (`logP(true) > logP(false)`, matched-magnitude distractor ⇒ **base rate 0.5**) **per tier**.

## Results

**Real difficulty gradient (greedy solve-success) — confirmed:**

| tier | t1 (1-step) | t2 (2-digit add) | t3 (2×1 mult) | t4 (multi-step) |
|---|---|---|---|---|
| solve-success | 0.75 | 0.40 | 0.575 | 0.325 |

Easy→hard is real (0.75 → 0.325); the mid-tiers are non-monotonic (this 1.4B model finds 2-digit
addition harder than 2-digit×1-digit — an honest measured quirk, not an assumed ordering).

**Q-exit adaptivity to that real difficulty — WEAK but present:**

| signal | value | reading |
|---|---|---|
| `E[exit depth]` by tier | 2.58 → 2.62 → 2.82 → **3.01** | rises monotonically as tiers get harder |
| per-tier corr(`E[depth]`, solve-success) | **−0.62** | harder tier ⇒ more depth |
| per-item corr(`E[depth]`, solved) | **−0.19** | more depth on items it gets wrong |
| `E[depth]` unsolved vs solved | 2.80 vs 2.72 | +0.08 steps on failures |
| per-item corr(`E[depth]`, P_true) | +0.08 | ~none (confidence is a noisy per-item proxy) |

The gate allocates ~**0.43 more steps** to the hardest tier than the easiest — a real, correctly-signed
effect against a genuine difficulty measure (an *upgrade* on #2025's entropy-only finding), but small:
**weak** adaptivity, not a strong adaptive-compute story.

**Depth → accuracy (forced-choice, matched base rate 0.5), per tier:**

| tier | d1 | d2 | d3 | d4* | d6 | d8 |
|---|---|---|---|---|---|---|
| t1 (easy) | 0.97 | 1.00 | 1.00 | **1.00** | 0.97 | 0.93 |
| t2 | 0.95 | 0.95 | 0.95 | **0.97** | 0.97 | 0.97 |
| t3 | 0.93 | 0.93 | 0.93 | **0.93** | 0.90 | 0.90 |
| **t4 (hardest)** | **0.85** | 0.93 | **0.95** | **0.93** | 0.90 | 0.88 |

*d4 = trained depth.

- **Depth helps on genuinely hard multi-step tasks:** t4 climbs 0.85 → 0.95 (d1→d3) — answering the
  question #2028 left open (it only saw the flat easy-task curve).
- **It doesn't help on easy tasks**, and easy t1 **dips past the trained depth** (1.00 → 0.93 by d8),
  the STARS "peak-then-collapse" signature — consistent with the true-Jacobian result that the loop is
  expansive (ρ(J) ≫ 1, [#2029]).

## Bottom line

With a *real* hardness proxy (solve-success, matched base rate): the Q-exit gate is **weakly adaptive**
to genuine difficulty (per-tier corr −0.62, +0.43 steps easy→hard) — better than the entropy pilot
suggested but still far from strong. And forced recurrent depth **does** buy accuracy on genuinely hard
multi-step reasoning (t4 +0.10), while adding nothing on easy tasks and mildly hurting them past the
trained depth.

## Honest caveats

fp16; Ouro-1.4B-Thinking; arithmetic-only graded set; greedy solve-success uses a 6-token decode +
prefix match; forced-choice isolates readout from generation; depths > 4 exceed the trained operating
point (the gate is undefined there, so `E[depth]` is measured at trained depth 4). 40 items/tier, so
tier accuracies carry ~±0.07 binomial noise — lean on the direction and the per-tier trend, not any
single cell. MEASURED, not PROVEN. Reproduce:
`.venv-train/Scripts/python.exe experiments/sigma0_hardness_depth.py`.
