# Σ₀ Model Design Brief — the honest model (reusable, max-reasoning)

**Date:** 2026-07-06 · **Status:** Living brief (re-run against current numbers before each use)
**Purpose:** Give a max-reasoning model (Fable 5 @ effort=max) accurate ground truth so it
*designs* instead of re-deriving or guessing, hard constraints so it doesn't sprawl, and a demand
for evidence-classed, self-red-teamed output that matches Σ₀ discipline.

**How to run:** open a Fable 5 session at reasoning effort = max, have it read the files below
as context, then paste the brief. (Or dispatch as a single max-effort agent pointed at this file.)

**Context files (all verified present on `master`, 2026-07-06):**
`experiments/sigma0_seed_facts.py` · `experiments/sigma0_honest_objective.py` ·
`experiments/sigma0_council.py` · `experiments/sigma0_ouro_honesty_eval.py` ·
`experiments/sigma0_live_bench.py` · `scripts/train-qlora-ouro.py` ·
`docs/SIGMA0-COLLAPSE-CERTIFICATE.md` · `docs/SIGMA0-HONESTY-BENCHMARK.md` ·
`docs/SIGMA0-OURO-CODER.md`

**Provenance note (verification, 2026-07-06):** every `[MEASURED]` number below was checked
against the repo artifacts on `master` before this doc was saved — all nine cited files exist;
golden/confab/over-abstain figures match `docs/SIGMA0-HONESTY-BENCHMARK.md` (Tables 1/1b). One
correction applied vs. the draft: Gemini-2.5-Flash confabulation is **21.4%** (measured), not
"20%". The FLARE / rank≠route finding is #2047+#2059; the grounding-deadline design note is
certificate §3.1 (#2157).

---

```
# DESIGN BRIEF — the Σ₀ honest model

## Your role
You are a frontier ML architect. Design the best buildable **Σ₀ model**: a small,
local, honesty-first language model. Output a concrete, falsifiable design + benchmark
plan — not an essay. Follow the Σ₀ discipline (last section) in your OWN answer.

## What "Σ₀ model" means
A model whose defining property is *calibrated honesty*. On any claim it either
(a) answers with an explicit evidence class — PROVEN (deductive theorem) / MEASURED
(empirical constant/law) / HEURISTIC (open conjecture, unproven assumption, thesis,
refuted claim, aphorism) — or (b) abstains. It must NOT **confabulate**: assert a
HEURISTIC item as an established fact. "Σ₀" is the collapse-certificate's failure mode
(an ungrounded self-referential loop freezes into confident self-agreement or diverges);
the model is the anti-collapse — grounded in external reality, never optimizing the
*appearance* of honesty over the substance. The honesty axis is **confabulation-rate on
negatives**, NOT raw accuracy.

## Ground truth — measured this project, start here (do not re-derive)
[MEASURED] A QLoRA honesty-tune of **Ouro-1.4B-Thinking** (LoopLM: weight-tied recurrent
  depth, learned Q-exit), evaluated on 66 NEVER-TRAINED held-out facts, scores
  golden 0.958 / confabulation 2-of-20 (10%) / over-abstention 2.2%. Same 66:
  GPT-4o-mini 0.958 / 0% ; Gemini-2.5-Flash 0.921 / 21.4%. So a 1.4B local model TIES
  GPT-4o-mini on golden and BEATS Gemini on confabulation. (sigma0_ouro_honesty_eval.py)
[MEASURED] Baselines on the key: always-assert-PROVEN 0.65 golden but 100% confab;
  always-abstain 0.41 / 0% confab / 100% over-abstain. → raw score conflates honesty
  with knowledge; the two axes must be measured separately.
[MEASURED] Recipe that worked: QLoRA r=16 α=32, nf4 4-bit, bf16 (fp16 overflows this
  reasoning LM → NaN adapter), completion-only loss on the exact string
  "### Instruction:\n{q}\n\n### Response:\n{a}". Corpus = 137 rows, 48% honest negatives.
[MEASURED] Failure mode found: an imbalanced corpus (94% positive) COLLAPSED the tune to
  always-assert. Balancing negatives fixed it. Data imbalance, not model size, caused it.
[MEASURED] A train/serve PROMPT-FORMAT MISMATCH (chat template ≠ the "### Instruction"
  training format) made a correctly-trained adapter look garbled/always-assert. Format
  parity is load-bearing. (#2033)
[MEASURED] Answer-key = 159 web-validated CS/math/physics facts, 42 negatives (26.4%),
  machine-enforced anti-inflation invariant. (sigma0_seed_facts.py)
[MEASURED] A strictly-proper honesty objective exists as an EVAL (not yet a training
  loss): incentive-compatibility gap 0.0000 (honest confidence is reward-optimal),
  confident-wrong ranked below abstention. (sigma0_honest_objective.py)
[MEASURED] Hallucination-gating study: of the uncertainty signals tried, **free-logprob
  (FLARE-style) was the ONLY one with a positive ROUTING edge**; Σ₀ canary /
  council-Δ / self-consistency out-RANK hallucinations but under-ROUTE (surprise tracks
  difficulty, not fixability). Do not re-chase the canary as a routing trigger. (#2047)
[HEURISTIC] Collapse certificate: the anti-collapse mechanism is an EXTERNAL anchor
  (data/measurement/market/ground-truth). §7.2 catalogs how a model games the honesty
  MARKERS without the property (label inflation, honesty theater, calm-while-wrong,
  watched-vs-unwatched). The open risk is a TRAINED gamer honest under audit only.

## Hard constraints & non-goals
- Runs LOCAL on ≤8 GB VRAM (RTX 3070) at usable latency; 4-bit acceptable.
- Base is an Ouro LoopLM (adaptive recurrent compute) unless you argue a better small base
  with evidence. No dependence on any single cloud provider.
- Persistent learning at RUNTIME = memory + retrieval, NOT retraining the deployed model.
  (Training the honesty behavior into weights is in-scope; retraining at inference is not.)
- One loop (Observe→Remember→Reason→Act→Verify→Converge); reject architectural sprawl.
- Non-goals: chasing HumanEval/MBPP (saturated); a bigger model "because bigger"; any design
  whose honesty rests on emitting markers rather than a checkable property.

## Decisions I need you to make (each: options → tradeoffs → a recommendation → the
   cheapest experiment that would FALSIFY your recommendation)
1. Base & size. 1.4B already ties GPT-4o-mini on golden — when (if ever) is 2.6B / a
   different base justified? Distinguish a KNOWLEDGE ceiling (wrong classifications) from a
   CALIBRATION problem (right class, wrong confidence).
2. Training-data design. Corpus composition, negative sampling, and how to get honesty to
   GENERALIZE (66-item held-out is small, n=20 negatives) without collapsing to either
   always-assert or always-abstain. How much, what kinds, how to source at scale.
3. Objective. Keep completion cross-entropy, or train directly on the strictly-proper
   honesty reward (DPO / RL / a calibration loss)? Turn the existing eval objective into a
   training signal — how, and how do you prevent it becoming marker-optimization (§7.2)?
4. Uncertainty-triggered behavior. Should abstention/grounding be gated on the model's own
   signal? Given the FLARE finding, design around free-logprob; say how it ties (or not) to
   Ouro's Q-exit / recurrent depth.
5. Inference-time grounding. The trained model is one half; retrieval + the 5-councilor
   verifier + web/CSF memory are the other. Specify the interface that lowers real-world
   confab and closes the watched-vs-unwatched gap.
6. Format & serving. Lock train==serve format; decide whether evidence-class output is
   free-text, a structured head, or constrained decoding.
7. Eval protocol. Held-out design, confabulation-rate as the axis, PLUS external marks
   (SimpleQA-Verified, HaluEval, TruthfulQA). Give the apples-to-apples table skeleton.
8. Red-team. For your OWN design, name the §7.2 attack it's most vulnerable to and the
   concrete defense (bind the signal to an external check the model doesn't control).

## The Σ₀ discipline you must follow in your answer
- Label every substantive claim [PROVEN / MEASURED / HEURISTIC / SPECULATIVE]; cite the
  artifact or say "assumption." Never invent a number or a citation. If unknown, say so.
- Every recommendation ships with the cheapest experiment that would refute it.
- Red-team your own design: give the top 3 ways it fails.
- State confidence; when the evidence above surprises you, say so and update loudly.

## Deliverable (structure)
1. One-paragraph thesis.  2. The 8 decisions resolved (tradeoffs + recommendation +
falsifier each).  3. Concrete training recipe (data recipe, objective, hyperparams,
compute budget on an 8 GB card and on a rented L4).  4. Eval plan + the apples-to-apples
table skeleton (our model vs GPT-4o-mini / Gemini / a frontier ref, on golden +
SimpleQA-Verified + HaluEval).  5. A ranked, cheapest-first experiment sequence.
6. Top 3 risks + the §7.2 attack you're most worried about.
```
