# SOTA-for-the-box: a reliability architecture for small models, grounded in molecular error correction

**Date:** 2026-07-24 · **Type:** Design synthesis (Status: **Proposed** — candidate ADR; needs
Alex approval before any structural build, per the ADR gate).
**Thesis in one line:** the 8GB box cannot hold an accurate model, but it can hold an accurate
*system* — and biology proves that high fidelity comes from architecture (proofreading,
error thresholds, repair), not from better components. This session measured that architecture
into quantitative form, and the box's own constraint is exactly the regime where it wins most.
**Loop stage:** Reason + Verify (assembles existing surfaces; no new subsystem).
**Grounded by (measured this session):** [`2026-07-24-foldback-cascades.md`](2026-07-24-foldback-cascades.md)
(rungs A–C, error threshold, SOTA envelope) · [`2026-07-24-m7-m8-publication-decision.md`](2026-07-24-m7-m8-publication-decision.md)
(attribution) · [`2026-07-21-owned-math-proofs.md`](2026-07-21-owned-math-proofs.md) (Lemmas 3–5).
**Existing program it unifies:** verified cascade (ADR-0030) · ternary serving (ADR-0026) ·
white-box honesty (v1.10, epic #2841) · freshness index (#2926) · attribution guard (#2924).

---

## 1. The box is the design driver, not a limitation to apologize for

The reference workstation serves models at ≤8GB — in practice a 0.5–3B model, or a 7B-class
model in ternary/4-bit (ADR-0026). A small model has a **high per-step error rate q**. Every
instinct says "that's the ceiling; buy more VRAM." The measured results this session say the
opposite: **high q is the regime where a biological reliability architecture gives its largest
gains.** Three of this session's measured laws all sharpen as q rises:

| measured law (this session) | behavior as q rises (small model, the box) |
|---|---|
| **error threshold** K_c ≈ 1/q (K_c·q = 0.80–0.96 measured) | max monolithic reasoning length **shrinks** → decomposition becomes mandatory, not optional |
| **foldback advantage** (1−q)^−(K−m) | grows **exponentially** — +0.83pp at q→0 to **+39.7pp**, up to **428×** at long horizons |
| **kinetic-proofreading gain** (Hopfield) | each cheap checkpoint's multiplicative fidelity gain is **larger** when raw q is high |

The box forces small models; small models have high q; high q is where proofreading + threshold
+ repair pay off most. **The constraint and the architecture are matched.** This is the
quantitative form of the project's standing thesis — *moat = system, not a home-grown model.*

## 2. Four control principles from molecular biology, each now measured and box-mapped

Nature runs on components far less reliable than a transistor and achieves error rates of
10⁻⁴–10⁻⁹. It does this with four mechanisms, each of which this session tied to a measured law
and a box-affordable implementation.

**(a) Kinetic proofreading — many cheap verifiers beat one expensive one** (Hopfield 1974 /
Ninio 1975; energy-speed-accuracy, [arXiv:1710.06038](https://arxiv.org/pdf/1710.06038)).
Fidelity multiplies with each independent checkpoint. *Box mapping:* a bank of **N cheap, diverse
verifiers** (unit tests, arithmetic self-consistency, a retrieval-entailment check, a 0.5B
critic, the honesty probe) drives the effective hidden-error rate q down as a product — and N
cheap checks fit the box where one large verifier model does not. This is also the dual-verifier
necessity the v1.10 probe work already found (probe + exec/citation).

**(b) The error threshold — decompose below 1/q** (Eigen 1971 quasispecies; error catastrophe
n < 1/(μs)). *Measured:* K_c ≈ 1/q. *Box mapping:* never let the small model reason monolithically
past ~1/q steps; **segment every ~1/q steps** into independently-verified units (foldons). Above
the threshold, information is lost no matter how you repair — so decomposition is forced by a
theorem, not chosen for tidiness. Kinetic proofreading (a) *raises* K_c by lowering q, so better
verification buys longer safe segments.

**(c) Foldback repair — fix the segment, don't restart the task** (Englander foldons /
sequential stabilization; [PNAS 2012](https://www.pnas.org/content/109/43/17442)). *Measured:*
rungs A–C. *Box mapping:* on a segment's global-verify failure, back up **within the segment** —
independent errors → re-solve the last m ≈ 1/q steps (rung B); causal errors → root-seek with a
prefix oracle (rung C). Policy is **selected** from the measured regime (φ, c, K), because the
SOTA envelope is fractured — no single method is universal (ToT 1.000→0.000; REPOT 0.950→0.234).

**(d) Attribution-gated re-grounding — ration scarce verification by paid-evidence age**
(this session's M7/M8; Whittle freshness index #2926). *Box mapping:* the box's verification
compute is scarce, so it must be spent where it buys the most. Schedule re-verification by the
**Whittle freshness index** over *paid* age (M8), never by expressed confidence — which provably
starves the confidently-wrong claims that most need checking (M7 audit starvation). The 30-min
hard tick is the index's zero-crossing at the ledger's measured staleness.

## 3. The assembled architecture

```
                    ┌──────────────────────────────────────────────────────────┐
   task ───────────▶│  DECOMPOSE into segments of ≤ K_c ≈ 1/q̂ steps (Eigen)     │
                    └──────────────────────────────────────────────────────────┘
                                          │  per segment
                                          ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  SMALL MODEL (0.5–3B, ternary-served ≤2–4GB, ADR-0026)        │
        │  emits the segment; verified prefix constrains the next       │
        └─────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  KINETIC-PROOFREADING VERIFIER BANK (N cheap diverse checks)  │
        │  exec / arithmetic / entailment / 0.5B critic / honesty probe │
        │  → effective q falls multiplicatively → raises the threshold  │
        └─────────────────────────────────────────────────────────────┘
                          │ pass                         │ fail
                          ▼                              ▼
              commit (stabilize the         ┌───────────────────────────────────┐
              foldon; escalate tier         │  REGIME-AWARE FOLDBACK REPAIR       │
              only if the segment           │  measure (φ̂, ĉ, K) → select:         │
              itself stalls — cheap          │   indep → back up m≈1/q             │
              sufficiency, ADR-0030)         │   causal→ root-seek (prefix oracle) │
                                            │   φ̂≈0  → the check already caught it │
                                            └───────────────────────────────────┘
                                          │
                                          ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  ATTRIBUTION-GATED LEDGER: schedule re-grounding by Whittle    │
        │  freshness over PAID age (M8); never by expressed confidence   │
        └─────────────────────────────────────────────────────────────┘
```

Every box in this diagram is either **already built** (verified cascade / cheap sufficiency;
ternary serving; freshness index; honesty probe) or **measured-and-specified this session**
(decomposition length; regime-aware repair). The design is an *assembly*, not a new subsystem —
which is the only kind of change the convergence constraint permits.

## 4. Why this is SOTA-relevant *and* box-optimal (the same fact)

Published inference-time reasoning methods — Tree-of-Thoughts, LATS, Reflexion, Self-Refine,
REPOT ([arXiv:2605.30052](https://arxiv.org/abs/2605.30052)) — share two assumptions the box
breaks: (i) you can afford a large base model, so per-step q is low and decomposition is
optional; (ii) you can afford many full restarts. This session measured that each is **best in
one regime and catastrophic in another**, and that none carries a length bound. The box lives in
the corner those methods handle worst: **high q, tight compute** — precisely where the error
threshold is shortest, where restarts are least affordable, and where foldback's advantage is
largest. So the architecture that is *forced* by the box is also the one that *dominates the
fractured SOTA envelope* in the box's regime. Being box-optimal and being SOTA-in-this-regime are
not two goals traded off; they are the same result read twice.

Concretely, the SOTA contributions this design carries that no prior method has: the **length
bound** K_c ≈ 1/q (decompose here), the **regime map** (which repair policy from measured φ, c, K),
and **proofreading-as-verifier-bank** (drive q down multiplicatively with cheap checks rather than
buying a bigger verifier).

## 5. Proven vs proposed — the honest ledger

- **Measured this session (simulation, gates passed):** error threshold K_c ≈ 1/q; unfold-depth
  law m\* ≈ 1/q (to 1.6%); foldback advantage null-at-φ0 → +39.7pp; SOTA envelope fracture;
  attribution / audit-starvation closed forms.
- **Measured on real workloads:** coding+unit-tests φ̂ = 0.092 — **below** the practical-relevance
  line (strong local verifier; repair inert *there*). Math/GSM8K φ̂: cheap tier running locally,
  escalate+frontier handed to mookman cloud ([#2928](https://github.com/alex-place/lantern-os/issues/2928));
  predicted high (weak local verifier). **The architecture's value is contingent on that number**
  — it is honestly unresolved until the weak-verification measurement lands.
- **Already shipped (existing program):** verified cascade + cheap sufficiency (ADR-0030);
  ternary serving (ADR-0026); freshness index (#2926, pure/tested/unwired); attribution guard
  (#2924); honesty probe clears its gate at 1.5B (assoc AUROC 0.774, factual 0.980).
- **Proposed (this doc):** the assembly, the 1/q decomposition, the verifier bank as a
  proofreading cascade. Status Proposed; needs approval.
- **Open / threats:** the whole case rests on real φ̂ being high on the workloads we serve (math
  measurement pending); correlated frustration (rung C) flips the repair policy and could
  dominate real traces; ternary-survival of the honesty probe is unmeasured (#2873); the
  SOTA-by-selection result is simulated, not yet benchmarked head-to-head.

## 6. Build order (each rung gated; nothing structural before the measurement)

1. **Instrument (φ̂, ĉ, q̂) per workload from telemetry** — the single blocking measurement;
   *all* downstream value is proportional to it. Coding done (φ̂=0.092); math in flight (#2928).
2. **1/q decomposition** in the cascade harness (segment long tasks below the measured threshold).
3. **Proofreading verifier bank** — register N cheap diverse checks; measure the multiplicative q
   reduction directly (does effective q fall as Hopfield predicts?).
4. **Regime-aware foldback** behind a flag; A/B against monotone escalation at measured (φ̂, ĉ).
5. **Wire the freshness index** (#2926) + attribution guard (#2924) into re-grounding scheduling.
6. **Fold in the honesty probe** as one verifier in the bank (v1.10), with the held-out
   off-gradient audit intact.

Each rung has a pre-stated kill criterion inherited from its source note; none ships before the
weak-verification φ̂ decides whether the repair layer earns its place at all.

---

*Provenance: this synthesis was requested as "expand the LLM design to be SOTA-performant and
optimized for the box it's fit." It assembles one session's measured results (foldback cascades,
the error threshold, the regime map, attribution) with the standing program (verified cascade,
ternary serving, white-box honesty) into one architecture whose defining property is that the
box's constraint and the biology's method are the same regime. Recorded Proposed; the binding
open number is the weak-verification φ̂ (#2928).*
