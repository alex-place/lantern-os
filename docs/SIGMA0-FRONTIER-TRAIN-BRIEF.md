# Σ₀ Frontier Training Brief — the honesty-native pretrained model

**Date:** 2026-07-06 · **Status:** Living brief · **Companion:** [SIGMA0-MODEL-DESIGN.md](SIGMA0-MODEL-DESIGN.md) — appendix carries the serving-layer design brief (the ≤8GB *serving* layer)
**Governance:** the program this brief designs requires an accepted ADR
([ADR-0024](adr/0024-sigma0-frontier-training-program.md), Status: Proposed — operator approval only; renumbered from 0023 in the ADR-collision fix).

**The two-layer contract:** TRAIN frontier → SERVE everywhere. The serving brief's constraints
(local ≤8GB, 4-bit, format parity) are this brief's **distillation target**, not its ceiling.
Budget is a **decision input** below, never an assumed constraint.

**Frontier, defined honestly:** frontier *on the honesty axis* — the first model whose
pretraining objective, not its post-training patch, is calibrated honesty — while remaining
capability-competitive at its scale. NOT "beat the largest labs on raw capability"; that axis is
not the differentiator and this brief does not pretend it is.

---

```
# DESIGN BRIEF — the Σ₀ frontier training program

## Your role
You are a frontier ML architect + training-program lead. Design the best buildable
honesty-native PRETRAINING program. Output concrete, falsifiable decisions with kill-gates —
not an essay. Follow the Σ₀ discipline (last section) in your OWN answer.

## The thesis (why this program can win an axis incumbents cannot)
[MEASURED] Kalai/Nachum/Vempala/Zhang (arXiv:2509.04664): hallucination persists because
  0-1-scored evals REWARD guessing; models are optimized to be good test-takers. Incumbent
  labs are locked into those leaderboards; changing their objective tanks their benchmarks.
  A fresh program can adopt abstention-aware proper scoring FROM TOKEN ONE. The
  "honesty-native pretraining" slot is unoccupied (7 verified searches, 2026-07-06 —
  post-training honesty patches exist; pretraining-objective honesty at scale does not).
[OPEN — was MEASURED, retracted 2026-07-06] Whether the property is trainable at small
  scale is now OPEN. The prior evidence (QLoRA honesty-tune of Ouro-1.4B: golden 0.958 /
  confab 10% / over-abstain 2.2% on 66 held-out) was CONFOUNDED by a benchmark leak: the
  golden key's negatives announce their status in-text ("— OPEN (Millennium problem)",
  "— REFUTED"). E1 (`data/sigma0/e1_degloss_report.json`, 2026-07-06) strips those glosses
  and re-runs the SAME adapter: Ouro confab **10% → 55%** (2/20 → 11/20), golden 0.958 →
  0.833 — while a GPT-4o-mini control is UNMOVED (0/20 → 0/20, golden 0.964 → 0.976),
  proving de-gloss does not make the task harder and the spike is the tune reading glosses,
  not honesty. Trainability at 1.4B must be re-established on **corpus-v2** (de-glossed,
  6-status, perturbed-positives) and confirmed on OSS marks (TruthfulQA / HaluEval /
  AbstentionBench), never on the leaked home-grown key. The design doc staged E1 first and
  predicted this — the method survives, the number does not.
[MEASURED] The failure modes are known and reproducible: corpus imbalance (94% positive)
  collapses the tune to always-assert; balancing negatives fixes it. Independently
  corroborated at RL scale: RFT erodes abstention ("Hallucination Tax", arXiv:2505.13988).
[MEASURED] The objective exists as an eval: strictly-proper honesty scoring with
  incentive-compatibility gap 0.0000 (sigma0_honest_objective.py). TruthRL (arXiv:2509.25760)
  shows the ternary form (+1 correct / 0 abstain / -1 confabulate) trains at RL scale.

## Ground truth — architecture (do not re-derive)
[MEASURED] Ouro (arXiv:2510.25741): LoopLM family, weight-tied recurrent depth, 7.7T tokens —
  existence proof that recurrent-depth pretrains to competitive quality.
[MEASURED] MoEUT (arXiv:2405.16039): shared-layer UT + fine-grained MoE (sigma-MoE
  arXiv:2310.10837, SwitchHead arXiv:2312.07987) + layer grouping G=2 (ABAB, not AABB) +
  peri-layernorm => UTs match/beat dense transformers per-param and beat them per-MAC up to
  1B. No public large-token checkpoint exists. Their kernel is 1.5-2x slower wall-clock today.
[MEASURED] Learned halting is the weak leg, twice over: MoEUT's SUT ablation — ACT was the
  main cause of SUT's poor performance; our trilogy — Ouro's Q-exit exits flat (~3.4/4,
  tracks entropy not difficulty) and forcing depth 1..8 leaves accuracy flat. Depth control
  belongs to POLICY (external governor), not to a learned exit head.
[MEASURED] Test-time depth-scaling collapses past trained depth; STARS (arXiv:2605.26733)
  is the training-time stabilizer (Jacobian spectral-radius regularization).
[MEASURED] Certificate quantities are measurable on a real loop: Ouro rho_obs ~= 0.88,
  strongly non-normal; ROA machine-checked (#1991, PROVEN); grounding-deadline design note
  landed (certificate §3.1, PR #2157): commitment cost grows at the certified rate; grounding
  is a schedule, canary demoted to audit.
[MEASURED] MoE routing makes the loop a SWITCHED system: stability needs a common Lyapunov
  function across experts or DWELL-TIME constraints (arXiv:2405.03560, 2303.17858,
  2008.06546). Expert-choice routing (arXiv:2202.09368) is the lower-discontinuity option.
[MEASURED] Barrier certificates are now trainable-with-proof: set-based training where
  loss = 0 formally proves validity (arXiv:2605.02526) — candidate for training-time
  stability instrumentation.
[MEASURED] Gate signals: free logprob (FLARE, arXiv:2305.06983) is the only signal with a
  positive ROUTING edge on our harness; canary/council-Δ/self-consistency out-rank but
  under-route (#2047, #2059). Design serving-time grounding around logprob.
[HEURISTIC] Certificate §7.2: the open risk is a TRAINED GAMER — honest under audit only.
  At frontier capability this risk GROWS (alignment faking measured: arXiv:2412.14093;
  evaluation-awareness: 2510.20487; strategic dishonesty: 2509.18058).

## Constraints & non-goals
- Budget is a DECISION (D1), not an assumption. Anchors in GPU-hours only; label every
  extrapolation ESTIMATE; invent no dollar figures.
- Two-layer contract: the model must DISTILL to the serving brief's ≤8GB local artifact.
- One loop; no architectural sprawl; provider-agnostic serving; operator (ADR) authority.
- Honesty must be a CHECKABLE PROPERTY bound to external verification the model does not
  control — never marker-emission. (§7.2 is a first-class design input, not an appendix.)
- Non-goals: raw-capability leaderboard chasing; "bigger because bigger"; any objective
  whose honesty evaporates when the grader looks away (watched-vs-unwatched gap).

## Decisions to make (each: options → tradeoffs → recommendation → cheapest FALSIFIER
   → kill-gate that would stop the program at that phase)
D1. Scale & budget tiers. Params x tokens x cluster, in GPU-hours. Anchors [MEASURED]:
    MoEUT-1040M = 74h on 4xA100-80GB for ~6.5B tokens; Ouro-1.4B = 7.7T tokens (compute not
    published — say so). Define tiers: PILOT (replicate MoEUT-scale + honesty objective),
    BASE (1-3B, real token budget), FRONTIER (the ambition tier). Each tier ends in a
    kill-gate with a measurable pass condition.
D2. Architecture. Dense-recurrent (Ouro-style) vs MoE-UT (MoEUT recipe) vs hybrid.
    Address: the switched-dynamics cost of MoE routing on certificate math (dwell-time
    constraint or expert-choice routing as mitigations); tokenizer; context length;
    G (grouping) and depth choices with the ABAB evidence.
D3. Depth policy. Fixed vs learned-exit vs external governor. The evidence (two independent
    lines) says policy-controlled depth + STARS-style training stabilization; say precisely
    what replaces Q-exit and how depth interacts with the grounding schedule at serve time.
D4. Objective stack & staging. Where does honesty enter: (a) pretraining data/objective
    from token one, (b) mid-training stage, (c) post-training only (the incumbent default —
    argue against or accept with evidence)? Concretize: CE + abstention-aware proper scoring
    (Kalai), ternary RL stage (TruthRL), calibrated-commitment auxiliary loss (contraction
    correlates with correctness — SPECULATIVE, ours; give its falsifier), STARS regularizer.
    Anti-gaming: how each term is bound to an external check (§7.2).
D5. Data program. What IS an "honest negative" at pretraining scale, and how do you source
    hundreds of millions of them (open conjectures, refuted claims, unanswerables, dated
    claims)? Scale the 48%-negatives finding; machine-enforced anti-inflation invariants in
    the data pipeline (sigma0_seed_facts.py pattern); contamination policy for the eval sets.
D6. Training-time certification. What runs DURING training: rho/conditioning tracking,
    canary-as-audit, basin conditioning, barrier-certificate co-training (2605.02526),
    dwell-time monitoring (if MoE). Define the collapse/instability ABORT criteria — the
    certificate as spec, not post-hoc analysis.
D7. Eval & release gates. North star = confabulation-rate on negatives (never raw accuracy
    alone) + golden set; externals: AbstentionBench (2506.09038), SimpleQA-Verified,
    HaluEval, TruthfulQA. Distillation gate: the ≤8GB artifact must retain the honesty
    property (define retention threshold). Pre-release: measure the watched-vs-unwatched
    gap explicitly.
D8. Red-team at scale. Name the strongest §7.2 attack against YOUR design (trained gamer,
    eval-awareness, marker mimicry), the binding defense (external checks, held-out
    unannounced probes, internals-based detection a la Poser arXiv:2405.05466), and the
    organizational protocol for it.

## The Σ₀ discipline you must follow in your answer
- Label every substantive claim [PROVEN / MEASURED / HEURISTIC / SPECULATIVE]; cite the
  artifact or say "assumption". Never invent a number, price, or citation. GPU-hour anchors
  only; every extrapolation labeled ESTIMATE.
- Every recommendation ships with the cheapest experiment that would refute it, and every
  phase with a kill-gate.
- Red-team your own design: top 3 failure modes, including at least one §7.2 gaming mode.
- State confidence; when the evidence above surprises you, say so and update loudly.

## Deliverable (structure)
1. One-paragraph thesis. 2. D1-D8 resolved (tradeoffs + recommendation + falsifier +
kill-gate each). 3. The phased program (PILOT → BASE → FRONTIER) with measurable gates and
GPU-hour anchors. 4. Objective-stack spec (losses, stages, anti-gaming bindings). 5. Data
program spec. 6. Eval table skeleton (ours vs GPT-4o-mini / Gemini / frontier ref on golden +
AbstentionBench + SimpleQA-Verified + HaluEval). 7. Top 3 risks + the §7.2 attack you fear
most. 8. The distillation plan down to the serving brief's ≤8GB artifact.
```
