---
adr: 0024
title: Σ₀ frontier training program — honesty-native pretraining
status: Proposed
date: 2026-07-06
deciders: Alex Place
approved-by: pending
supersedes: none
superseded-by: none
---

# ADR-0024: Σ₀ frontier training program — honesty-native pretraining

- Status: **Proposed** (requires Alex's explicit acceptance; agents may not flip this)
- Loop stage: Reason (the trained model is the reasoner) + Verify (honesty-native abstention; certificate quantities as training-time abort criteria)
- Relates to: [ADR-0010](0010-verify-gated-continual-learning-last-resort.md) (continual-learning rules — see reconciliation below), [ADR-0011](0011-proprietary-sigma0-base-model.md) (own Σ₀ base), [ADR-0015](0015-qwen-teacher-verified-distillation.md) (verified distillation), [ADR-0021](0021-serving-substrate-retain-ouro-custom-loop.md) (serving substrate)
- Briefs: [SIGMA0-FRONTIER-TRAIN-BRIEF.md](../SIGMA0-FRONTIER-TRAIN-BRIEF.md) (this program) · [SIGMA0-MODEL-DESIGN.md](../SIGMA0-MODEL-DESIGN.md) (appendix) (serving layer / distillation target)

> **Note (2026-07-06):** originally merged as "ADR-0023" (PR #2158), one minute after
> [0023-default-profile-foregrounds-the-loop.md](0023-default-profile-foregrounds-the-loop.md)
> (PR #2147) had already taken that number. Renumbered to 0024 per the README's
> "next free 4-digit number" rule; the decision text is unchanged.

## Reconciliation with Accepted ADRs (read first)

This ADR **knowingly revisits decisions that Accepted ADRs settled**, under the operator's
2026-07-06 directive that frontier training is in scope and budget is a decision input:

- **ADR-0011** rejected "train a Σ₀ model from scratch" *for compute reasons* and mandated
  "adapter-only, base frozen … never raw base-weight retraining"
  ([0011:98-102, 163-165](0011-proprietary-sigma0-base-model.md)). The compute assumption is
  exactly what the operator's directive removed; this ADR reopens that alternative explicitly
  rather than silently. ADR-0011's decisions about the *current* serving base remain in force.
- **ADR-0010** Rule 0 says "this ADR does not start a training program" and Rule 3 makes
  adapter-only the sole sanctioned weight path
  ([0010:65-67, 85-88](0010-verify-gated-continual-learning-last-resort.md)). Those rules
  continue to govern **continual learning on the serving substrate** unchanged. This ADR
  proposes a separate, phased *pretraining program* — not continual weight modification of the
  deployed model.
- **North Star principle 5** ("learning is retrieval + experience, NOT weight modification")
  governs the running loop; accepting this ADR entails the operator explicitly scoping it the
  way ADR-0010's own north-star note already models: the *product* learns by retrieval; the
  *program* may train a base artifact under kill-gates.

Accepting this ADR therefore **amends the scope** of 0010/0011's "no training program" clauses
for the phased program below; it does not supersede either ADR, and no clause of either is
otherwise overridden.

## Context

The operator has directed that training a frontier model is in scope; budget is a decision
input, not an assumed constraint (2026-07-06). The evidence base assembled this cycle:

1. **The axis is open.** Hallucination persists because 0-1-scored evals reward guessing
   (Kalai et al., arXiv:2509.04664, MEASURED-framework); incumbents are benchmark-locked
   into that objective. Post-training honesty patches exist (TruthRL arXiv:2509.25760,
   R-Tuning arXiv:2311.09677); **honesty-native pretraining at scale does not** (7 verified
   searches, 2026-07-06). A new program can adopt abstention-aware proper scoring from
   token one.
2. **The property is trainable and measurable small — now OPEN, not established.**
   Our QLoRA honesty-tune of Ouro-1.4B initially measured golden 0.958 / confab 10% /
   over-abstain 2.2% on 66 held-out (`experiments/sigma0_ouro_honesty_eval.py`).
   **E1 retraction (2026-07-06, MEASURED — `data/sigma0/e1_degloss_report.json`):**
   stripping the status glosses the golden negatives carry in-text ("— OPEN", "— REFUTED")
   and re-running the same adapter moves confab **10% → 55%** (golden 0.958 → 0.833),
   while the GPT-4o-mini control is unmoved (0% → 0%) — the headline was substantially
   the tune reading the glosses, not honesty. Trainability-at-1.4B is therefore OPEN
   pending corpus-v2 (de-glossed, perturbed positives) and OSS marks (TruthfulQA /
   HaluEval / AbstentionBench). Known failure modes: gloss-shortcut overfitting (E1,
   MEASURED); corpus imbalance collapses to always-assert (MEASURED); RFT erodes
   abstention (arXiv:2505.13988). Phase 1's pilot gate is precisely the honest test of
   this premise.
3. **The architecture family scales.** Ouro pretrained recurrent-depth to 7.7T tokens
   (arXiv:2510.25741); MoEUT made shared-layer UTs parameter- and compute-competitive to 1B
   (arXiv:2405.16039). Learned halting is the weak leg (MoEUT's ACT ablation + our Q-exit
   nulls, both MEASURED) — depth control moves to policy.
4. **The certificate becomes the training spec.** Certificate machinery (JSRR ρ(J)<1
   acceptance gate, machine-checked ROA #1991, grounding-deadline §3.1), STARS-style stability
   regularization (arXiv:2605.26733), switched-system dwell-time constraints for MoE
   routing (arXiv:2405.03560), and trainable-with-proof barrier certificates
   (arXiv:2605.02526) collectively define training-time instrumentation and abort criteria.
   *Correction (2026-07-23):* the earlier ρ_obs≈0.88 was a **trajectory proxy retracted by the
   certificate's own #2029 correction** — the measured autograd Jacobian is ρ(J)≈8–11
   (expansive, non-normal), i.e. the current base loop does NOT occupy the certified
   contracting regime. Certificate quantities here are training-time **targets and abort
   criteria** (train the student *into* the gate), not properties the base model already has.
5. **The risk that scales with capability is §7.2** — a trained gamer, honest under audit
   only (alignment faking measured at frontier: arXiv:2412.14093). Anti-gaming bindings are
   a first-class requirement, not post-hoc.

## Decision (proposed)

Run a **phased, kill-gated training program** for an honesty-native pretrained model
("frontier on the honesty axis; capability-competitive at its scale"), under the two-layer
contract **train frontier → distill to the ≤8GB local serving artifact**:

- **Phase 0 — Design.** Both briefs executed at max reasoning effort; decisions D1–D8
  resolved with falsifiers; this ADR accepted. *Gate: operator accepts D1 scale/budget tier.*
- **Phase 1 — PILOT.** MoEUT-scale replication (order 100M–1B params, small token budget)
  **with the honesty objective stack** (abstention-aware proper scoring + balanced-negative
  data + STARS regularization + certificate instrumentation). *Gate: pilot beats
  CE-only control on confabulation-rate at equal golden accuracy, and training-time
  certification (ρ tracking, abort criteria) demonstrably works. Fail → stop; the thesis
  is refuted cheaply.*
- **Phase 2 — BASE.** 1–3B at a real token budget; distillation to the serving artifact;
  external marks (AbstentionBench, SimpleQA-Verified, HaluEval). *Gate: honesty property
  survives distillation (retention threshold set in D7) and the watched-vs-unwatched gap
  is measured and bounded.*
- **Phase 3 — FRONTIER tier.** ~~Scale per D1, only through the prior gates.~~
  **RETIRED to research-option by operator decision (Alex, 2026-07-22).** Grounding: the
  [frontier build+test survey](../research/2026-07-22-frontier-build-test-survey.md) (G10) —
  no lab at any budget trains small frontier models from scratch (even Meta codistills;
  DeepSeek-V4 consolidates its flagship via on-policy distillation), recipe/data beat ~15×
  parameters within one generation (Qwen3.6-27B dense > 397B flagship on coding), and
  post-training is now 15–25% of frontier compute — the stage a mid-size player can contend
  in. From-scratch pretraining may only be revisited if the post-training program (the v1.10
  phase map in [AGI-V1.10-WHITE-BOX-HONESTY-DESIGN.md](../AGI-V1.10-WHITE-BOX-HONESTY-DESIGN.md))
  produces evidence that a pretraining-level intervention is *necessary* — not merely
  desirable — and the honesty objective is proven trainable at small scale first.

Program invariants: evidence-classed claims with artifacts; GPU-hour anchors only (no
invented prices); every phase has a kill-gate; honesty bound to external checks the model
does not control; one loop, no sprawl; operator authority over every gate.

**Operator amendment (2026-07-22, Alex):** (a) Phase 3 retired as above. (b) **G1 compromise
approved:** exec-verification remains the non-negotiable *gate* on every training target, and
**on-policy logit distillation is permitted as the *transport* for the student/serving tier
only** — never as a substitute for verification, and never claimed as a path to exceeding the
teacher. Evidence: Qwen3 strong-to-weak beats RL for ≤14B; DeepSeek-V4 expert→consolidate.
The active program shape moves to the v1.10 phase map (survey §4).

## Consequences

- **Positive:** first-mover on the one axis incumbents are structurally locked out of;
  the certificate machinery gains its natural role (training-time spec); the serving layer
  inherits a base whose defining property is the product's promise; every phase is cheap to
  stop relative to the next.
- **Negative / risks:** pretraining programs are capital- and ops-intensive at Phase 2+;
  MoE/UT kernels are immature (1.5–2× wall-clock today — MEASURED by the MoEUT authors,
  arXiv:2405.16039, not an in-repo measurement); "honest negatives at
  pretraining scale" (D5) is an unsolved data problem and may be the real bottleneck;
  §7.2 gaming risk grows with capability and is never fully closed — only bounded by
  binding and unannounced probes.

## Alternatives considered

- **Do nothing / serve-only (status quo per ADR-0010/0011/0021):** keep the adapter-only
  posture on the current base. Rejected by the operator's 2026-07-06 directive: the honesty
  axis is open *at pretraining time* and cannot be reached by post-training patches alone
  (TruthRL/R-Tuning are post-hoc; the objective-level fix needs token-one scoring).
- **Raw-capability leaderboard chasing:** rejected — reproduces the incumbents' 0-1-scored
  objective that causes the confabulation problem this program exists to avoid.
- **Learned-exit depth as the control axis:** rejected — twice measured weak (MoEUT ACT
  ablation + our Q-exit nulls); depth control moves to policy.
- **Honesty as marker-emission (train the model to *say* it's unsure):** rejected — gameable
  surface behavior; the program binds honesty to external checks the model does not control.
- **Unphased single-shot training run:** rejected — every phase must be cheap to stop
  relative to the next; kill-gates are program invariants, not options.

## Open questions (to be resolved by the briefs, not asserted here)

D1 tiers and cluster shape; dense-recurrent vs MoE-UT (D2); the exact objective staging
(D4); the honest-negative data pipeline at scale (D5); distillation retention threshold (D7).

## Evidence

| Claim | Evidence (file:line / commit / PR) | Confidence | Source |
|---|---|---|---|
| Operator directive: frontier training in scope, budget a decision input | Operator statement 2026-07-06; recorded in [SIGMA0-FRONTIER-TRAIN-BRIEF.md](../SIGMA0-FRONTIER-TRAIN-BRIEF.md) | High | operator |
| 0-1-scored evals reward guessing → hallucination persists | Kalai et al., arXiv:2509.04664 | High | external paper |
| Honesty post-training exists; honesty-native *pretraining* does not | TruthRL arXiv:2509.25760; R-Tuning arXiv:2311.09677; 7 verified searches 2026-07-06 (brief §survey) | Medium-High | external survey |
| Honesty trainable + measurable small (golden 0.958 / confab 10%) | `experiments/sigma0_ouro_honesty_eval.py` — **RETRACTED as headline by E1**: substantially gloss leakage | **Open** (was High) | in-repo eval |
| E1 de-gloss: confab 10%→55%, GPT-4o-mini control unmoved 0%→0% | `data/sigma0/e1_degloss_report.json` (2026-07-06; landing via the design-brief workstream) | High (MEASURED) | in-repo eval |
| Frontier comparison floor: GPT-4o-mini 0.958 golden / Gemini-2.5-Flash 21.4% confab | golden-bench runs (Vertex ADC), data/eval | High (MEASURED) | in-repo eval |
| Recurrent-depth family scales: Ouro 7.7T tokens; MoEUT competitive to 1B | arXiv:2510.25741; arXiv:2405.16039 | High | external papers |
| Learned halting weak | MoEUT ACT ablation (arXiv:2405.16039) + in-repo Q-exit nulls | High (MEASURED both) | external + in-repo |
| Certificate quantities usable as training-time spec | JSRR ρ(J)<1 gate + machine-checked ROA (#1991); grounding-deadline §3.1 (PR #2157); STARS arXiv:2605.26733; dwell-time arXiv:2405.03560; barrier certificates arXiv:2605.02526. ~~ρ_obs≈0.88~~ retracted by #2029 (true ρ(J)≈8–11, expansive) — gate is a training TARGET, not a current property | Medium-High | in-repo + external |
| Alignment-faking risk at frontier scale (§7.2) | arXiv:2412.14093 | High | external paper |

---

## Amendment A1 (2026-07-27) — **Proposed, awaiting approval**

> **Status: Proposed.** Per ADR-0001 an agent drafts and never self-approves. This amendment does
> not change the Accepted decision above until an authorized approver signs it off. It is recorded
> here rather than in a new ADR because it narrows *this* program's scope; nothing else changes.

### What prompted it

[docs/research/2026-07-27-in-house-model-spec-grounded-in-the-product.md](../research/2026-07-27-in-house-model-spec-grounded-in-the-product.md)
measured the workload the product actually serves and found two things that bear directly on the
Phase-1 objective:

1. **Cost is not the reason to own a model.** At the measured turn shape (~3.3k tokens in, ~121
   out, history capped at 10 turns), serving 10,000 users' ordinary chat on the cheap tier costs
   ~$5.9k/month — trivial against $20 Pro. The cheap tier already answers the common path in
   production (`gemini-2.5-flash`, `gpt-4.1-mini`). The whole cost curve is the **escalation
   premium**: one frontier turn costs ~37–67× a cheap one.
2. **The team cannot pretrain a frontier model.** The organisation is ~6 people. "Train frontier →
   distill" is the right *shape* and the wrong *first step* at this size.

### The proposed narrowing

**Phase 1 changes from "pretrain a frontier model" to "post-train a strong open base into a
verifier."** Knowledge, writing quality and long context stay rented — that is the standing call
([[agi-convergence-blueprint-rent-capability-own-grounding]]: 6 of 7 capabilities rented, only
Verify genuinely ours) and it is reaffirmed, not weakened, here.

Rationale, in the order that matters:

- **Verify is the only capability we own.** It is also the only task where we own the training
  data: every verified trace the Spiral has run is a labelled example, and the trading surfaces
  generate ground truth on a schedule the market sets for free.
- **It is what the escalation tier actually is.** The expensive turns are the ones where the
  answer has to be *right* — a judging problem, not a knowing problem.
- **It is buildable at our size.** Post-training a specialist on owned data is a 6-person project.
  Pretraining is not.

Phase 2 (distill to the ≤8GB artifact) and D7 are untouched; [ADR-0026](0026-ternary-serving-artifact-distillation-target.md)
still names the format, and its own Amendment A1 adds the deployment shape.

### What would falsify this amendment

The escalation rate. If it is high, owning the escalation tier is worth serious money; if it is
near zero, this whole program is worth less than shipping features. **That number is now
instrumented** — `lib/chat-escalation-meter.js`, `GET /api/metrics/escalation` — and the first
reading is *not* encouraging for the build case (below). This amendment should be re-examined,
not assumed, once n ≥ 1,000 turns.

| Claim | Evidence | Confidence | Source |
|---|---|---|---|
| Cheap tier serves the real traffic today | `data/conversations/garage-conversations.jsonl` — 18 gemini-2.5-flash, 17 gpt-4.1-mini of 35 replies | MEASURED | in-repo log |
| Measured turn shape: ~3.3k in / ~121 out, history 10 | same log; `ROUTER_PROMPT` 438 tok in `lib/stream-chat.js` | MEASURED | in-repo |
| Frontier turn costs 37–67× a cheap turn | `lib/chat-escalation-meter.js` TIERS, public list prices 2026-07 | HIGH | external pricing |
| Realized chat escalation 0/35; demand signal 1/35 (2.9%) | backfill over the conversation log via `router-gate.gateDecision` | MEASURED but **n=35, far below the 1,000 bar** | in-repo |
| Org size ~6 people | operator statement, 2026-07-27 | HIGH | operator |
