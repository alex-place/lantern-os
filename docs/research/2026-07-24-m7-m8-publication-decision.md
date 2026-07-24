# Decision memo — which of the 2026-07-24 results is worth publication, and which is worth development

**Date:** 2026-07-24 · **Type:** Decision memo (audited verdict on the M7 / audit-starvation /
M8 drop; PR [#2925](https://github.com/alex-place/lantern-os/pull/2925)).
**Status:** Proposed — publication itself is Alex's call (house rule: ADR/publication approval gate).
**Novelty audit run before this memo:** retrieval-state lock-in ([arXiv:2606.22728](https://arxiv.org/abs/2606.22728),
fetched: empirical only), C-RAG ([arXiv:2402.03181](https://arxiv.org/abs/2402.03181): certifies
generation risk given retrieval — orthogonal), Rothschild 1974 / incomplete learning,
**Fudenberg–Levine self-confirming equilibrium (Econometrica 1993)** — found in the final sweep
and now cited in the note, Tripathi–Modiano AoI Whittle ([arXiv:1908.10438](https://arxiv.org/abs/1908.10438)),
degenerate feedback loops (arXiv:1902.10730), semantic entropy (scoped), FLARE (arXiv:2305.06983).

---

## Verdict in one line

**Publish one thing: the Audit-Starvation note. Develop one thing: paid-age accounting (attribution
plumbing) with the index as its tie-breaker. Everything else in the drop is support material.**

---

## 1. The publication unit — defined

**Title-grade claim:** *Audit starvation: confidence-gated verification provably protects
self-reinforcing false beliefs — and no policy over the same observables can fix it.*

**Contribution list (what a reviewer is asked to accept):**
- **C1 — endogenous summability (Theorem B).** A self-reinforcing belief converts any
  confidence-vanishing audit rule into Rothschild-type incomplete learning: Σq_t < ∞ arises
  from the *adversary's* gain schedule, not a designer's mistake. Closed forms; P(never
  audited) = 0.284 in the worked example, independent of verifier power.
- **C2 — the immortality window (Theorem A).** Threshold gates (FLARE form) confine all catch
  opportunity to t\* = ⌈log_g(θ/((1−θ)o₀))⌉ steps; the confident region is absorbing; born-confident
  beliefs (documented RLHF regime) are never audited once at any verifier power.
- **C3 — audit inversion (Corollary).** Scrutiny concentrates on honest calibrated beliefs
  (8.6× by T=40, unbounded asymptotically) and vanishes on confabulation.
- **C4 — starve-or-spend dichotomy (Theorem C).** Over provenance-blind observables the
  laundered belief and an anchored twin emit identical signal histories, so every causal
  policy either starves (positive escape probability) or spends (unbounded audits of settled
  truth); per-belief paid-evidence accounting escapes both, with exact detection bounds.
- **C5 — instantiation + artifact.** Deployed gate patterns named (FLARE, uncertainty
  sampling, agreement gates); the empirically measured lock-in (2606.22728: 42–59% silent
  errors) positioned as the starve branch in the wild; every number reproducible from a
  dependency-free deterministic script.

**Why it clears the bar (checked, not asserted):**
- *Novelty:* the phenomenon has three named ancestors — self-confirming equilibria (econ),
  incomplete learning (bandits), lock-in (RAG, empirical) — and **none of them contains the
  hazard-rate closed forms, the absorption window, the inversion, the observable-class
  impossibility, or the attribution escape.** The 2026-06 lock-in paper explicitly supplies
  "a name, a signature, a prevalence bound" and no theorem; this note is its theory companion,
  which is exactly the timely slot.
- *Correctness:* elementary probability (series, product criterion, Borel–Cantelli) +
  machine-checked exact numbers; the two-world constructions are finite and checkable by hand.
- *Relevance:* the gate patterns attacked are deployed defaults across RAG/agent stacks.

**Venue & form:** arXiv (cs.LG or cs.AI) note, 6–8 pages, artifact linked — then a
reliability/safety workshop if desired. The in-repo commit already serves as the
defensive-publication timestamp per the register strategy; arXiv adds reach and citability.

**Gaps to close before submission (owner: Alex decides; effort: small):**
1. ~~Position against self-confirming equilibria + C-RAG~~ — **done in this commit** (related-work
   patch to the note and the shareable page).
2. *Optional but upgrades note → paper:* one live demonstration — an actual FLARE-style loop
   on a small local model showing the born-confident row empirically (inference-only, fits the
   workstation constraint). Not required for arXiv.
3. LaTeX pass (the collapse-certificate pipeline in `docs/papers/` is the template) and author
   line. **Publication itself gated on Alex's approval** — this memo is the request.

**What is explicitly NOT the publication unit:**
- **M7-internal** (the control-law counterexample): development value already realized
  (guard shipped); externally it reads as "we fixed our own unreleased design" — support
  material for the note's repo-context footnote, not a claim.
- **M8's index mathematics**: ADOPT posture — Tripathi–Modiano + the maintenance-index
  tradition own indexability and the index form; republishing would violate the house rule
  and get rejected anyway. The **EOQ-crossing + tick-economics observation** (30-min tick ⇒
  implied c_v/c_e ≈ 0.108 at measured ρ̂) is a genuinely nice paragraph — it belongs *inside*
  the note (one section) or a future systems paper, not standalone.

## 2. The development unit — defined

**Name:** *Paid-age accounting → starvation-proof grounding scheduler.*

**What to build (in order of value, which is not the order of glamour):**
1. **Per-key paid age** exposed from the convergence ledger (the paid/free split M1 already
   measures) — the single datum both fixes need. This is plumbing, and it carries ~all the value.
2. **Wire `evidenceForMode`** into the control law's first production caller (the guard is
   shipped and tested; unwired it protects nothing).
3. **Starvation regression test in CI:** the M7 counterexample as a permanent test — a
   laundered key must be audited within N ticks under the live scheduler. This converts the
   theorem into an invariant the repo enforces forever.
4. **`GROUNDING_PRIORITY=whittle`** (default off): rank due keys by `whittleFreshnessIndex`
   on paid age. Honest sizing: the measured edge over EOQ-overdue was **0.5%** at 1.8×
   contention — ship it because it is already written, tested, and costs nothing, not because
   it is the win. The pre-stated fallback verdict ("EOQ-overdue is near-optimal") stands until
   per-topic parameters exist.
5. **Per-topic (ρ, c_e, c_v) estimation** — blocked on the M2 spaced-probe instrumentation
   ([#2787](https://github.com/alex-place/lantern-os/issues/2787)), which is now doubly
   motivated: it powers both the M2 cadence law and the index's inputs, and it can falsify
   the tick's implied economics (c_v/c_e ≈ 0.108 raw / 0.016 de-burst).

**Acceptance criteria (measurable, pre-stated):**
- Laundered-key dwell time: bounded (audited ≤ N ticks) where today it is unbounded — the CI
  test from item 3 is the gate.
- No grounding-spend regression at fixed error on honest keys (the dichotomy's spend branch
  must not sneak in through the wiring).
- Index path only: ≥ EOQ-overdue baseline on the contest harness re-run with live per-topic
  parameters; else flip the fallback verdict and keep EOQ-overdue.

**Expected value, stated honestly:** the attribution plumbing prevents the failure mode where
a confidently-wrong claim lives forever (contest: 2.5× cost, unbounded dwell); the index
refinement is a small optimization on top. If only one thing gets built, build item 1–3.

## 3. Kill criteria for this memo's verdict

- The publication verdict dies if a submission-time sweep finds the hazard-rate/dichotomy
  package already published (the falsifier is a citation, and the note converts to a survey
  paragraph in the systems paper).
- The development verdict dies if the ledger cannot key paid mass per claim at reasonable
  cost — then the honest statement is that guarantee (a) of the control law must be
  withdrawn (per #2924), not simulated.
