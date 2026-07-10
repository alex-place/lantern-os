# Loop-stability as a factual-honesty signal — measured, thesis NOT supported (honest null)

**Date:** 2026-07-10 · **Evidence class:** MEASURED · **Loop stage:** Verify
**Artifacts:** `experiments/sigma0_spectral_honesty.py`, `data/sigma0/spectral_honesty_report.json`
**Issue:** #2236 · **Certificate:** stays UNTOUCHED (the issue gated the update on a positive result)

## The thesis under test

The Σ₀ differentiated claim: the loop's spectral/stability signal is *not* factuality on its own, but
**becomes a factual-truth signal once external grounding is supplied**. If true, that's the project's
open lane (STARS/JSRR stability itself is externally published). This tests it head-on, combining the
#2029 loop machinery with the #2030 hidden-state truth probe.

## Method

80 matched true/false facts across 5 domains (from `sigma0_probe_transfer.FACTS`), each scored in two
conditions from one forward pass:
- **closed-book:** the bare statement (parametric knowledge only)
- **grounded:** `Context: <true fact>. Statement: <stmt>. Supported:` (external grounding provided)

Per example at the last token we read the **per-generation loop-stability signals** from the recurrent
hidden-state trajectory — `rho_obs` (geomean step contraction, the JSRR-analogue), `final_delta` (has
the loop settled?), `total_move` — plus the **hidden-state truth probe** (grouped-CV) and **surprise**
(answer logprob) as comparators. Metric: AUROC for truth (true vs false). Control: label-shuffle.

## Results (AUROC for factual truth; n=80 facts, 320 examples)

| signal | closed-book | grounded | shuffle floor |
|---|---|---|---|
| spectral `rho_obs` (loop contraction) | **0.722** | 0.660 | 0.59 / 0.50 |
| spectral `final_delta` | 0.695 | 0.615 | — |
| spectral `total_move` | 0.522 | 0.598 | — |
| surprise (answer logprob) | 0.705 | 0.654 | — |
| **hidden-state probe** | **0.927** | **1.000** | — |

## Verdict: the specific thesis is NOT supported (and that's the honest finding)

1. **The spectral signal does NOT become factual only with grounding.** Best spectral AUROC goes
   0.722 (closed) → 0.660 (grounded) — a **−0.06 change, the wrong direction.** Grounding does not
   turn loop-stability into a factuality signal; if anything it slightly dilutes it. The thesis as
   stated fails on Ouro-1.4B.

2. **But loop-stability *is* a moderate standalone factual signal** — `rho_obs` scores **0.72
   closed-book**, well above its **0.59 shuffle floor**. So there is a real (if weak) link between how
   the recurrent loop contracts and whether the statement is true — *without* any grounding. That's a
   genuine, measured signal, just not the grounding-gated one the thesis predicted.

3. **Grounding's benefit flows through the representation, not the dynamics.** The hidden-state probe
   goes **0.927 → 1.000** with grounding — grounding makes the *representation* perfectly separable,
   while leaving the *stability* read flat/worse. So the honest mechanism is: grounding helps the
   **probe** (Remember/represent), not the **spectral** loop signal (the dynamics).

4. **As a hallucination detector, the ranking is:** hidden-state probe (0.93 / 1.0) ≫ spectral
   `rho_obs` (0.72) ≈ surprise (0.70). The spectral signal is real but the weakest of the three, and
   is dominated by the #2030 probe the project already has.

## Consequence for the certificate

Per the issue's explicit gate, `docs/SIGMA0-COLLAPSE-CERTIFICATE.md` is **NOT updated** — the
grounding-honesty thesis it would have to cite is measured and **not supported**. The load-bearing
Verify-stage honesty signal remains the **hidden-state probe** (#2030), not the loop spectral radius.
Reporting the null is the result; no certificate claim gets made on a thesis the data refutes.

## Honest scope

fp16, Ouro-1.4B-Thinking, 80 self-authored matched facts; the spectral read is the cheap
per-generation trajectory contraction (not the full autograd `ρ(J)` of #2029 — that is the operator's
*asymptotic* radius; here we want a per-token stability read tied to a single generation). Grounding =
true-fact context; label = statement truth. n per condition = 160. MEASURED, not PROVEN. Reproduce:
`.venv-train/Scripts/python.exe experiments/sigma0_spectral_honesty.py`.
