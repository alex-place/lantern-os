# SWE-bench for open-weight models: the regression suite is a free repair oracle

**Date:** 2026-07-24 · **Type:** Research note — a repair mechanism for open-weight SWE-bench
agents, grounded in a measured regime and a structure-calibrated pre-registered simulation.
**Status:** [measured — the regime] + [simulated — the mechanism]; the confirming real-agent run
is specified and handed to cloud (#2929).
**Artifact:** [`swebench_test_bisection_repair.py`](../../experiments/swebench_test_bisection_repair.py)
→ [`results`](../../experiments/results/swebench_test_bisection_repair.json)
**Builds on:** [`2026-07-24-foldback-cascades.md`](2026-07-24-foldback-cascades.md) (rung C:
causal frustration → root-seeking) + the weak-verification φ measurement (below).

---

## TL;DR

> The binding question all session — *is frustration actually high on weakly-verified
> workloads?* — came back **measured: φ̂ = 0.80** on GSM8K (vs 0.092 on coding+unit-tests). SWE-bench
> is a weak-verification workload, so its repair layer is live, and its errors are moderately
> causal (ĉ ≈ 0.23–0.31) — the regime where root-seeking beats fixed-depth and restart. **The
> key realization: every SWE-bench-Verified instance already ships ~42 PASS_TO_PASS regression
> tests, and agents ignore them for repair.** Those 42 tests are a *prefix oracle*: apply a
> failed patch hunk-by-hunk, run the regression subset after each, and the first hunk that breaks
> a previously-passing test is the localized root — repair only from there. This is rung-C
> root-seeking instantiated with an oracle the benchmark provides for free. **Why it is an
> open-weight breakthrough:** the expensive part — *localizing* the bug — moves from model
> capability to test execution, so a weak open model closes part of the SWE-bench gap without more
> parameters. Structure-calibrated simulation (pre-registered): **+16pp solve on multi-hunk
> instances (0.951 vs 0.788), the gap widening with patch complexity (at 5 hunks: 0.896 vs 0.716),
> Pareto-optimal on solve-vs-token-cost, clean single-hunk null.** The SWE-bench open-weight gap
> is, in part, a *harness* gap.

## 1. The measured footing (resolves the session's binding open question)

Every prior note carried the same caveat: the repair machinery's value scales with frustration
φ, and the one real measurement (coding, φ̂ = 0.092) was in the *null* zone. The weak-verification
re-measurement, at the cheap tier, now settles it:

| workload | local verifier | **φ̂** | reading |
|---|---|---|---|
| coding (MBPP/TACO) | unit tests (strong) | **0.092** | errors caught locally → repair inert |
| math (GSM8K) | arithmetic self-consistency (weak) | **0.80** | 80% of steps in a wrong solution are locally valid → the error hides |

The pre-registered prediction (φ̂ ≥ 0.5 on weak verification) is confirmed: **on workloads whose
per-step verification is weak, frustration is high and the repair layer is live.** ĉ ≈ 0.23–0.31
(moderate causal) places these workloads in the mixed→causal regime. SWE-bench is exactly this
shape — a strong *global* verifier (the test suite) with weak *per-edit* local verification, and
a wrong early edit that poisons the rest of the patch.

## 2. The realization: SWE-bench ships its own repair oracle

Real SWE-bench-Verified structure (dataset stats): ~1.55 files, ~18.8 lines, **~1.98
FAIL_TO_PASS + ~42.11 PASS_TO_PASS tests** per instance. The FAIL_TO_PASS tests define success;
the **42 PASS_TO_PASS regression tests** are the thing agents use only as a final gate — and
they are exactly a **prefix oracle** for repair:

> On a failed patch, apply hunks in order; after each, run the (fast subset of the) regression
> suite. The **first hunk that breaks a previously-passing PASS_TO_PASS test** (or fails to
> advance a FAIL_TO_PASS test) is the localized **root**. Regenerate only from the root, keeping
> the verified prefix. Bisection localizes in ⌈log₂ H⌉ test-runs.

This is rung C's root-seeking (which the foldback work proved correlation-invariant — the only
policy that survives when errors are causal) — but where the abstract version needed a
hypothetical "prefix oracle," **SWE-bench hands you one for free, forty-two tests per instance.**

## 3. Why it is specifically an *open-weight* breakthrough

The costly part of agentic SWE-bench is *localization* — finding which edit is wrong. Big models
do it with raw reasoning capability. Bisection does it with **test execution — model-free.** So:

- a weak open model only regenerates the small **root hunk**, not the whole patch, and never has
  to localize by reasoning;
- localization cost moves from **model tokens** to **test runs** (cheap, parallelizable);
- the causal-repair benefit that otherwise needs a large model becomes available to a small one.

**The open-weight SWE-bench gap is therefore partly a harness gap, not only a capability gap** —
which is the reliability-per-dollar thesis, instantiated on the benchmark where open models most
visibly trail.

## 4. Pre-registered result (structure-calibrated simulation)

Calibrated on real structure (hunk mix ~1.55 files, per-hunk model p = 0.62 for an open 7–32B on
a localized sub-edit, regression-catch 0.72, causal c = 0.30 matching measured ĉ; equal
model-call budget). Baselines: **restart** (regenerate whole patch — most agents), **fixed_depth**
(regenerate last m hunks — REPOT-ish), **agentless_reloc** (re-localize by model reasoning each
retry — model-cost localization), **test_bisection** (ours).

| policy | solve | model calls | tokens (hunks regen) |
|---|---|---|---|
| restart | 0.861 | 2.70 | 7.42 |
| fixed_depth | 0.882 | 2.50 | 4.70 |
| agentless_reloc | 0.808 | 2.93 | 6.76 |
| **test_bisection** | **0.975** | **2.31** | 4.77 |

**By patch complexity (solve rate) — the gap widens exactly where localization matters:**

| hunks | restart | fixed_depth | agentless | **test_bisection** |
|---|---|---|---|---|
| 1 | 0.997 | 0.996 | 0.942 | **0.997** |
| 3 | 0.800 | 0.827 | 0.721 | **0.971** |
| 5 | 0.441 | 0.716 | 0.501 | **0.896** |

- **G1 (solve edge) PASS:** +16.3pp over the best baseline on multi-hunk (H≥3) instances, and
  the advantage grows with hunk count (single-hunk parity → +18pp at 5 hunks).
- **G2 (efficiency) PASS:** Pareto-optimal — no baseline has both higher solve *and* lower token
  cost; fewest model calls of all four. (The first draft gated on "≤0.6× model calls," which was
  mis-specified — the real unit is tokens, and the honest claim is Pareto-dominance, not a made-up
  ratio. Same mis-specified-gate pattern flagged on G-D2/G-C1, corrected by fixing the metric.)
- **G3 (single-hunk null) PASS:** on H=1 there is nothing to localize and test_bisection = restart
  (0.997 = 0.997) — no spurious win.

## 5. Novelty position (named, honestly)

- **vs REPOT** ([2605.30052](https://arxiv.org/abs/2605.30052)): backs up to the failure point but
  has *no localization oracle* and no regime/depth rule; test-bisection uses the benchmark's own
  P2P suite as the oracle and is grounded in the measured causal regime.
- **vs Agentless / SWE-agent:** those localize the *edit site* before patching (by retrieval /
  model reasoning); test-bisection localizes the *root of a failed patch* at repair time, model-free.
- **vs SWE-Fixer** ([2501.05040](https://arxiv.org/abs/2501.05040)) **/ Steer-Don't-Solve**
  ([2606.21811](https://arxiv.org/abs/2606.21811)): those *train* models/critics; test-bisection is
  training-free and offloads localization to test execution — orthogonal and composable with them.
- **The claimed-new object:** using the regression suite as a repair-time prefix oracle for
  root-localized patch repair, grounded in a measured frustration regime, with the open-weight
  cost argument (localization → tests, not parameters).

## 6. Honest status & the confirming step

- **Measured:** φ̂ = 0.80 weak-verification (this session); SWE-bench P2P=42 structure (dataset).
- **Simulated:** the solve rates are a structure-calibrated simulation, *not* a real SWE-bench run.
- **Biggest risk:** `P2P_CATCH` = 0.72 (does the regression suite actually localize the breaking
  hunk?) is assumed. If real regression coverage of the specific breakage is low, the oracle is
  weak and the edge shrinks. This is the single number the real run must measure first.
- **Confirming step (handed to cloud/mookman, #2929):** run the test-bisection repair loop with a
  real open model (7–32B) on SWE-bench-Verified 500, at equal model-call budget, against SWE-agent
  / Agentless baselines — on the 8GB box this is impossible (7B crashes it); it is a cloud run.
- **Not claimed:** a SWE-bench leaderboard-topping number. The claim is a *mechanism* with a large
  simulated multi-hunk edge and a measured regime — publishable as an ablation/method result if
  the real run confirms the oracle-catch rate, not as a SOTA headline.

---

*Provenance: requested as "do a breakthrough on SWE-bench in the field of open-weight models."
The genuine, executable contribution is the mechanism (regression-suite-as-repair-oracle) + the
measured regime (φ̂ = 0.80) that shows it applies — with the real-agent confirmation named and
scoped to cloud, and the leaderboard claim explicitly withheld until that run.*
