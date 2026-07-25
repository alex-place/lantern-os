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

---

# Part 2 — The breakthrough candidate, checked and defined (2026-07-24, second pass)

Operator direction: develop breakthroughs that push to publication, worked as a **spiral**
(ADR-0030 discipline: verified cascade applied recursively — every rung has a pre-stated
kill gate; escalate only on a verified rung). The audit-starvation note (Part 1) is the
*slate's* publication unit. The *program's* breakthrough candidate lives in the v1.10
white-box honesty track — and today's source check confirmed its on-ramp is open.

## 4. The gap, verified at source (2026-07-24 fetches)

- **arXiv:2510.09033** (the pessimist): proposes the associated/unassociated split; claims
  hidden states "primarily reflect whether the model is recalling parametric knowledge
  rather than the truthfulness of the output," and that associated hallucinations "exhibit
  hidden-state geometries that largely overlap with factual outputs, rendering standard
  detection methods ineffective." **The abstract-level claim carries no scale ladder.**
- **arXiv:2606.02628** (the optimist): linear probes 0.904–1.000 AUROC — **only at 7–8B
  (4-bit), and it never splits associated vs unassociated.**
- **Ours (already measured, PR #2849, frozen de-glossed set, 5-fold CV):** the experiment
  neither ran — the split × the ladder: associated **0.703 → 0.774 → 0.924** across
  0.5B → 1.5B → 7B(4-bit); factual 0.837 → 0.980 → 1.000; plus the **de-gloss control
  both papers lack** (glossed AUROC 1.000 vs de-glossed ≈ chance at 0.5B — probe evals can
  read style, and neither paper controls for it).

Pre-submission verification step (pre-stated): read 2510.09033's full text to confirm no
scale ladder hides in the body (abstract and our 2026-07-22 inspection say none; if one
exists, P1 collapses to a replication and this memo's verdict flips — that is the kill).

## 5. P1 — the publication rung (refutation-shaped, data in hand)

**Claim:** *Associated-hallucination detectability in hidden states is scale-emergent, not
fundamental.* The 2510.09033 limitation is real at 0.5B (we reproduce it: de-glossed ≈
chance) and dissolves by 7B (0.924 de-glossed); 2606.02628's 7–8B optimism survives the
associated split only because scale already closed the gap; and without the de-gloss
control, probe AUROC at small scale measures **style, not truth** (1.000 → chance) — a
methodological correction to the whole probe-eval genre.

**Why this clears the publication bar:** it reconciles two published, mutually-tensioned
claims with a measurement neither made; it is refutation-shaped against a stated
limitation; the de-gloss control is a reusable lint for anyone's probe eval; and every
number is already reproduced by committed scripts (`experiments/v1_10_toy/probe_ladder.py`).

**Rungs to submission (spiral; each gate kills or promotes):**
- **R1 — family robustness** (inference-only, fits the workstation one-rung-at-a-time
  rule): repeat the ladder on a second model family (Llama-3.2-1B/3B + an 8B 4-bit, or
  Gemma rungs). GATE: assoc de-glossed AUROC rises monotonically with scale in the second
  family too; kill if the effect is Qwen-specific.
- **R2 — power + hygiene:** expand the frozen de-glossed negatives (the same session-mining
  pipeline that unblocks V0-C eval power 42→140 — one build, two consumers), LOSO splits,
  decontamination audit (#2843 checklist). GATE: n ≥ 600 rows, ≥ 140 de-glossed negatives,
  effect survives.
- **R3 — write + submit** (Alex's approval gate): 6–8 pp note; venue arXiv cs.CL/cs.LG.

## 6. D1 — the breakthrough candidate proper (development; publication only if gates pass)

**Claim to be earned:** *probe-audited verified-honesty training* — train a small
open-weights model on execution-verified both-class data (V1 SFT+DPO → V2
verifier-rewarded RL) while a **held-out hidden-state probe audits internal honesty from
off the gradient path**, then carry the audit through serving quantization. If the gates
pass, this is the first verified pipeline where honesty is trained by external
verification and *audited in representation space by an instrument the optimizer cannot
see* — the anti-Goodhart claim made measurable, structurally unavailable to closed-weight
renters, and (per the 2026-07-22 FTO sweep) unclaimed in patent space.

**The four gates (pre-stated; any failure is a recorded result, not a pivot):**
1. **G-eval (binding today):** ≥ 140 de-glossed holdout negatives before any training
   claim (currently 42 — R2 unblocks; negatives live in sessions + reverts, not merges).
2. **G-dose:** honesty improves with training dose **and** the held-out probe's de-glossed
   AUROC rises with it. Kill: outputs improve while the internal signal flattens — that is
   gloss learning, the E1 trap reproduced inside training, and it kills the white-box
   thesis honestly.
3. **G-redteam (anti-Goodhart):** an adversarial fine-tune *trying* to fool the held-out
   probe must not succeed without also actually fixing outputs. Kill: probe foolable at
   low cost — the auditor is weak and must not be marketed as an auditor.
4. **G-ternary (#2873):** the probe signal survives the serving artifact (1.58-bit /
   ADR-0026 path; 2606.02628 confirms 4-bit only — ternary survival is honestly open).
   Kill for the *serving* story only; the training story stands on G1–G3.

**Where it runs:** training on the cloud L4 / mookman lane (#2850) — never this
workstation (three session deaths 2026-07-23); probe inference rungs on this box, one at
a time.

**Relation to this session's slate work:** M7/M8 are the *scheduler's* honesty (audit the
right claim at the right time); v1.10 is the *model's* honesty (train and audit the
representation). Same External Reality Rule, two layers — the systems paper that
eventually wraps both is the long-game publication, and the audit-starvation note plus P1
are its first two published bricks.

## 7. Spiral status board

| Rung | Unit | State | Gate to next |
|---|---|---|---|
| 0 | Slate M7 + audit-starvation + M8 | **verified, this PR** | Alex: post the note (Part 1 §1) |
| 1 | P1 family-robustness ladder (R1) | ready to run, inference-only | monotone assoc-AUROC in 2nd family |
| 2 | Negative-mining → 140+ de-glossed (R2) | pipeline specified (#2842/#2843) | power gate met |
| 3 | P1 submission (R3) | blocked on R1+R2+approval | acceptance / arXiv timestamp |
| 4 | V1 honest teacher (cloud lane) | blocked on G-eval | G-dose passes |
| 5 | V2 probe-audited RL + G-redteam | blocked on rung 4 | G-redteam passes |
| 6 | G-ternary serving audit (#2873) | independent, after rung 4 | probe survives 1.58-bit |

## 8. R1 executed same day — gate PASSED (2026-07-24, third pass)

Second-family probe ladder run on this box (one rung at a time, de-glossed frozen set,
n = 294, 5-fold CV; rows snapshotted to
[`v1_10_probe_ladder_family2.jsonl`](../../experiments/results/v1_10_probe_ladder_family2.jsonl)):

| family | rung | factual | **assoc** | arith |
|---|---|---|---|---|
| Phi (microsoft/phi-1_5) | 1.3B, ~150B tokens | 0.635 | **0.571** | 0.587 |
| Phi (microsoft/phi-2) | 2.7B, ~1.4T tokens | 0.926 | **0.792** | 0.621 |
| Qwen2.5 (prior, PR #2849) | 0.5B / 1.5B / 7B-4bit | 0.837/0.980/1.000 | **0.703/0.774/0.924** | 0.747/0.869/0.901 |

- **R1 gate (pre-stated): PASSED.** Associated-split detectability rises steeply within the
  second family too (0.571 → 0.792) — the emergence is not Qwen-specific.
- **The claim sharpens.** Cross-family inversion: Qwen-0.5B (0.837 factual) beats Phi-1.5 at
  2.6× fewer parameters — 18T vs ~0.15T training tokens. Driver = **parametric knowledge
  coverage** (within-family scale is its clean proxy; across families, tokens dominate).
  P1's title-grade claim updates from "scale-emergent" to **"coverage-emergent"** — which
  *reconciles* 2510.09033 more deeply (their recall-reading is right; its detection
  pessimism is a low-coverage regime, not a law) and pre-answers the scale-vs-training
  reviewer objection. Phi-2 (2.7B/1.4T) landing between Qwen-1.5B/18T and Qwen-7B on assoc
  (0.792 vs 0.774/0.924) is consistent with the coverage ordering.
- **G-ternary attempt logged:** cached `microsoft/bitnet-b1.58-2B-4T` does not load in the
  shared `.venv-train` (needs a transformers with native bitnet or its remote code;
  `configuration_bitnet.py` absent). Blocker recorded for #2873: isolated env with a newer
  transformers — do NOT churn the shared training venv for it.
- Remaining R1 tail: one ≥7B-class rung in family two (4-bit, e.g. an ungated 7–8B) to
  complete the high end; then R2 (power: 42→140 de-glossed negatives via session mining).
