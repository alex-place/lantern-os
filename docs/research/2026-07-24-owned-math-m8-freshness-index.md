# Owned Math M8 — The freshness index: claim re-verification is Age-of-Information scheduling

**Date:** 2026-07-24 · **Type:** Research note — discovery of an isomorphism + the closed-form
index it imports, with two corollaries that unify M2, M5 and M7 under one law.
**Status:** [derived — proofs note Lemma 5] + [measured — exact machine checks, all PASS].
**Loop stage:** Remember/Verify allocation (which claim gets re-grounded next) — Converge.
**Issue:** [#2926](https://github.com/alex-place/lantern-os/issues/2926) ·
**Slate:** [`2026-07-21-owned-math-conjectures.md`](2026-07-21-owned-math-conjectures.md) §M8 ·
**Artifact:** [`owned_math_m8_whittle_freshness.py`](../../experiments/owned_math_m8_whittle_freshness.py)
→ [`results JSON`](../../experiments/results/owned_math_m8_whittle_freshness.json) ·
**Product:** `whittleFreshnessIndex()` in
[`grounding-policy.js`](../../apps/lantern-garage/lib/grounding-policy.js) (pure, unwired, tested)

---

## TL;DR

> The M5 stretch goal ("Whittle-index form of claim re-verification") resolves by
> **isomorphism**: each ledger claim is an arm of the **Age-of-Information restless bandit
> with a verification price** — state = **paid age** τ (steps since evidence was last
> *attributed* to the claim; M7's vocabulary), passive cost `c_e·s(τ)` with staleness
> `s(τ) = 1−(1−ρ)^τ` (M2's flip rate), audit = pay `c_v`, reset. Indexability for
> nondecreasing age costs is settled in the AoI literature (Tripathi & Modiano) — per the
> ADOPT rule we import it and derive our variant's closed form:
> **W(τ) = c_e·[τ·s(τ) − S(τ−1)] − c_v**, verified against exact bisection to **7.8e-13**
> and against exact policy iteration. What the isomorphism *unlocks*: (1) **M2's EOQ cadence
> is the index's zero-crossing** — and the shipped 30-minute tick, read at the ledger's
> measured ρ̂, implies verification is priced at **10.8%** of an error-step (de-burst: 1.6%):
> the magic constant becomes a falsifiable economic claim; (2) a binding audit budget enters
> as a **uniform surcharge on the verification price** (crossing(λ) ≈ √(2(c_v+λ)/(c_e ρ))) —
> scarcity delays everyone, it never starves high-risk claims; (3) **the index is measurable
> w.r.t. paid age alone** — computed on *expressed* freshness it reproduces M7's audit
> starvation, and on paid age it wins the policy contest under a binding budget
> (1.784 < EOQ-overdue 1.793 < round-robin 2.020 < expressed-confidence gate 4.470).
> M3 said *when* to ground is not optional; M7 said *whose claims* must be keyed by paid
> evidence; M8 gives the *priority order* in closed form — one law, all three.

---

## 1. The isomorphism

| AoI scheduling (networks) | Claim re-verification (this system) |
|---|---|
| source i's age of information | claim i's **paid age** τ (steps since attributed evidence) |
| nondecreasing age cost f(age) | expected error cost `c_e·s(τ)`, `s(τ) = 1−(1−ρ)^τ` |
| transmit an update (channel slot) | audit / re-ground (budgeted grounding call) |
| — (updates usually free) | **verification price c_v** (the maintenance-index term) |
| scheduling under channel constraint | grounding under audit budget (M audits/step) |

The mapping is exact, not analogical: dynamics, costs and constraint all carry over. The
c_v term is what the AoI form lacks and the inspection/maintenance tradition supplies — and
it is precisely the term that makes the index meet M2's EOQ economics (below).

## 2. The index

For the λ-subsidy single-arm problem, every stationary deterministic policy's recurrent
class is the cycle 1…A for A = its smallest audit age — so average cost is
`g_λ(A) = [c_v + c_e·S(A−1) − λ(A−1)]/A` and **threshold optimality is immediate**
(one line, no VI needed). Indifference between adjacent thresholds at state τ gives

```
W(τ) = c_e·[τ·s(τ) − S(τ−1)] − c_v ,          S(k) = Σ_{u=1..k} s(u)
     = c_e·[1 − τβ^τ + (β−β^τ)/(1−β)] − c_v    (geometric, β = 1−ρ)
```

strictly increasing in τ (increments `c_e(τ+1)[s(τ+1)−s(τ)] > 0`), bounded above by
`c_e/ρ − c_v` (the budget shadow price's feasibility ceiling). Monotone index ⇒ the
passive set grows monotonically in λ ⇒ **indexable**, and W is the Whittle index. Under a
budget of M audits per step: audit the M claims of highest positive index — the Whittle
policy (asymptotically optimal in the Weber–Weiss regime; adopted, not re-proven).

**Machine checks (artifact, all exact):** indifference-λ recovered by bisection on the
exact renewal scan matches W(τ) to **7.8e-13** across a (ρ, c_e, c_v) × τ grid; passive-set
monotonicity witnessed over 200-point λ sweeps; **exact policy iteration** over all
stationary policies recovers the same thresholds. (Method note kept honestly: relative
*value* iteration is the wrong tool here — the optimal chain is a periodic deterministic
cycle and synchronous relative VI oscillates, which produced an off-by-one in the first
run; PI with closed-form cycle evaluation is finite and exact.)

## 3. Corollary 1 — M2's cadence is the index's zero-crossing, and the tick has implied economics

Small-ρ expansion: `W(τ) ≈ c_e·ρτ²/2 − c_v`, so the λ=0 crossing is
**T\* = √(2(c_v/c_e)/ρ)** — exactly M2's EOQ law, now *derived from optimality* rather than
a renewal approximation. Measured convergence: relative error 0.41 → **0.007** as ρ falls
0.1 → 0.0003. Under a binding budget the shadow price λ shifts the crossing to
**√(2((c_v+λ)/c_e)/ρ)** (measured rel. err ≤ 2.1%): **budget scarcity is a uniform
surcharge on the verification price** — it delays every claim by the same economics; it
never selectively starves the high-ρ claims (contrast M7's confidence gate, which starves
exactly them).

Read at the calibration ledger's measured staleness (M2): with raw ρ̂ (48 h half-life) the
crossing at `c_v/c_e = 0.1` is **29 minutes** — the shipped 30-minute `GROUNDING_TICK` is
the index's zero-crossing at an implied verification price of **10.8% of an error-step**
(de-burst ρ̂, 337 h: implied **1.6%**). The magic constant is now an economic statement the
M2 spaced-probe instrumentation ([#2787](https://github.com/alex-place/lantern-os/issues/2787))
can falsify per topic.

| ρ̂ source | implied c_v/c_e at 30-min tick | T\* @ c_v/c_e = 0.01 | 0.1 | 1.0 |
|---|---|---|---|---|
| raw (48 h half-life) | **0.108** | 9 min | **29 min** | 92 min |
| de-burst (337 h) | 0.016 | 24 min | 76 min | 240 min |

## 4. Corollary 2 — attribution is inside the index (M7 ⊂ M8)

The arm's state is **paid age**, full stop: the transition and cost kernels do not read
expressed confidence, so the index is measurable w.r.t. the paid-evidence history alone —
free confidence has **index weight zero**. Computing the "same" index on expressed
freshness re-creates audit starvation: a laundered claim (expressed age ≈ 0 forever) gets
W = −c_v < 0 and is never scheduled. Policy contest under a binding budget (8 arms, two of
them laundered, contention 1.8×, exact expected costs, no RNG):

| policy | avg cost/step |
|---|---|
| **Whittle on paid age** | **1.784** |
| EOQ overdue-ratio (audit max τ/T\*ᵢ) | 1.793 |
| round-robin | 2.020 |
| expressed-confidence gate | 4.470 |

The confidence gate pays 2.5× — the starvation cost, now inside a scheduling benchmark.
Honest reading of the thin Whittle-vs-EOQ margin (0.5% at this contention): EOQ-overdue is
a strong heuristic; the index's edge is priority under contention and heterogeneity, and if
per-topic parameters never materialize (#2787), "EOQ-overdue is near-optimal" is the
recorded fallback verdict (pre-stated kill criterion in
[#2926](https://github.com/alex-place/lantern-os/issues/2926)).

## 5. One law (the arc completed)

- **M3:** re-grounding must happen on a hard external cadence — *when* is not optional.
- **M7:** the audit must land on claims keyed by **paid** evidence — *whose* is not optional.
- **M8:** given both, the *order* is `argmax W(τ_paid)` with the budget as a price
  surcharge — and the shipped tick is this law's zero-crossing at measured parameters.

Shipped: `whittleFreshnessIndex()` in `grounding-policy.js` — pure, exported, 5 unit tests,
**unwired** (the hard tick stays the floor; the index is a priority on top, never a
replacement — M3 forbids the replacement reading). Wiring behind `GROUNDING_PRIORITY=whittle`
is specified in #2926 and blocked, correctly, on the same instrumentation as M2.

## 6. Prior art, named — and what is ours

**Adopted:** Whittle (1988); Tripathi & Modiano ([arXiv:1908.10438](https://arxiv.org/abs/1908.10438))
— indexability + closed-form indices for nondecreasing AoI costs (our reliable-channel,
priced variant sits in the maintenance/inspection-index tradition, e.g. Glazebrook et al.);
Weber & Weiss asymptotic optimality; Rothschild (1974) incomplete learning (the M7 lineage).
**Ours:** the claim-verification instantiation with the verification-price term; the
EOQ-crossing identity tying the index to shipped M2 economics (including the tick's implied
c_v/c_e from measured ρ̂); the budget-as-price-surcharge reading; the attribution corollary
(index weight zero for free confidence) closing the M7 loop; the exact artifact and the
tested product function.

## 7. Honest scope & kill criteria

- Geometric staleness (constant flip hazard) is the model; per-topic ρ is instrumentation-
  blocked (#2787) — same limit as M2, inherited knowingly. Non-monotone "self-healing"
  claims break threshold structure and are out of scope (the index requires monotone
  deterioration).
- Whittle optimality under a hard per-step budget is asymptotic (Weber–Weiss), not exact
  for N = 8; the contest is evidence, not proof, and the EOQ-overdue baseline is reported
  at full strength.
- Audit = perfect repair here (audit reveals and fixes). Imperfect audits compose with
  M7's ρ_catch analysis; not re-derived.
- Kill criteria: closed form dies on any indifference-gap cell above tolerance; the
  refinement claim dies if Whittle stops beating EOQ-overdue under binding budgets as
  heterogeneity grows; the economics reading dies if per-topic ρ̂ (#2787) moves the implied
  c_v/c_e outside a defensible range.
