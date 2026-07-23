# How 2026 frontier models are actually made and tested — survey + gap audit

**Date:** 2026-07-22 · **Method:** one wide web-search fan-out (10 parallel queries + a
date-corrected second pass on the *current* generation, no workflow), primary technical reports
where available. **Purpose:** stop reinventing the wheel — align the v1.10 design
([AGI-V1.10-WHITE-BOX-HONESTY-DESIGN.md](../AGI-V1.10-WHITE-BOX-HONESTY-DESIGN.md),
epic [#2841](https://github.com/alex-place/lantern-os/issues/2841)) with what frontier labs
measurably do, and log the gaps for operator review.

**Generational note:** §1 documents the *settled consensus* established by the previous generation
(DeepSeek-V3, Qwen3, Llama 4, Kimi K2 — late 2024→2025 reports, still the best-documented
pipelines). §1b covers what the **current generation (2026 releases, through this week)** changed.

**Source quality note (External Reality Rule):** rows marked **[P]** cite a primary technical
report / system card; **[S]** are secondary summaries surfaced by search and are `verified:false`
until read in full. Nothing here is reproduced on our hardware.

---

## 1. How they're MADE — the 2026 consensus pipeline

Every current frontier model is assembled the same way. The stages, with per-lab evidence:

### Stage A — Data (where the actual competition is)
- **Scale:** DeepSeek-V3 **14.8T** tokens [P: [2412.19437](https://arxiv.org/pdf/2412.19437)] ·
  Qwen3 **36T** [P: [2505.09388](https://arxiv.org/pdf/2505.09388)] · Llama 4 **>30T** [S:
  [Meta blog](https://ai.meta.com/blog/llama-4-multimodal-intelligence/)] · Kimi K2 **15.5T**
  [P: [2507.20534](https://arxiv.org/pdf/2507.20534)].
- **Dedup:** MinHash/LSH at paragraph + document level, run **before and after** synthesis [S:
  [Toloka pipeline survey](https://toloka.ai/blog/how-frontier-labs-build-pre-training-datasets/)].
- **Quality filtering:** small model-based classifiers ("good web" vs noisy), perplexity filters
  (KenLM/TinyLM) [S: same].
- **Synthetic data:** web-rephrasing is standard, **but human-data anchors stay ≥60–70% of the
  mix; synthetic is targeted amplification on *verifiable domains* only** [S:
  [decision guide](https://www.digitalapplied.com/blog/synthetic-data-generation-llm-training-decision-guide-2026)].
- **Curriculum:** multi-stage pretraining (general → reasoning-dense → long-context annealing);
  Qwen3 is explicitly three-stage [P: 2505.09388].

### Stage B — Architecture (a commodity; nobody differentiates here)
- All sparse MoE: DeepSeek-V3 **671B/37B active** (aux-loss-free load balancing, MTP objective)
  [P] · Kimi K2 **1.04T/32B** [P] · Gemini 2.5 sparse MoE on TPUv5p, thinking-budget
  **128–32768 (Pro) / 0–24576 (Flash)** tokens [P:
  [2507.06261](https://arxiv.org/pdf/2507.06261); ranges full-text-verified 2026-07-22] · Llama 4 MoE [S].
- This confirms the blueprint's "architecture is rented" stance — no lab wins on topology.

### Stage C — Training systems (the engineering moat)
- FP8 mixed-precision at scale (DeepSeek-V3, first validated at 671B) [P] · **MuonClip: 15.5T
  tokens with ZERO loss spikes** (Kimi K2) [P] · TPUv5p at 93.4% utilization (Gemini) [P/S] ·
  **MetaP** hyperparameter transfer across scales (Llama 4) [S].
- Notable: hyperparameters are *derived by transfer rules*, not hand-tuned per run.

### Stage D — Post-training (the 2026 modular stack)
- Consensus shape: **SFT → DPO/SimPO (preference) → GRPO/RLVR (verifiable rewards) → polish**;
  RLAIF/constitutional to scale labels [S:
  [frontier training methodologies](https://djdumpling.github.io/2026/01/31/frontier_training.html)].
- Qwen3's four stages: **Long-CoT cold-start SFT → Reasoning RL (GRPO on query-verifier pairs) →
  thinking-mode fusion → general RL** [P: 2505.09388].
- **RLVR is the dominant reasoning paradigm** — deterministic verifiers, "millions of verification
  signals per day"; every major reasoning model since late 2024 uses verifier-driven RL [S].
  This is the industrialized version of our Spiral/VTD thesis — *we did not invent verifier-gated
  training; we are late to it and should adopt its mature form.*

### Stage E — Small models: distilled, never trained from scratch
- **Qwen3 strong-to-weak distillation** for everything ≤14B: off-policy (teacher outputs in both
  think modes) then **on-policy** (student generates, aligned to teacher logits) — and it
  **outperforms RL** on both quality and training cost for lightweight models [P: 2505.09388].
- **Llama 4 Maverick codistilled from Behemoth** with a novel loss dynamically weighting soft +
  hard targets [S: Meta blog].
- **Nobody at any budget trains a small frontier model from scratch.** Even Meta distills.

## 1b. What the CURRENT generation changed (2026 releases, as of 2026-07-22)

- **DeepSeek-V4** (Apr 24, 2026; V4-Pro **1.6T** / V4-Flash 284B; **33T/32T tokens**) [S:
  [kili data story](https://kili-technology.com/blog/data-story-deepseek-v4) ·
  [sitepoint](https://www.sitepoint.com/deepseek-v4-released-whats-new-in-the-latest-model-2026/) ·
  P: [2606.19348](https://arxiv.org/pdf/2606.19348)]:
  1. Pretraining now deliberately emphasizes **long documents + agentic execution traces** — i.e.
     *verified working sessions are pretraining data at the frontier now*. Our session/PR trace
     mining (#2842) is the same move at our scale.
  2. **The newest post-training paradigm:** independently cultivate **domain experts** (per-domain
     SFT → GRPO for math/coding/agent/IF), then **consolidate into one model via ON-POLICY
     DISTILLATION**. Even the flagship is now assembled by distillation, not monolithic RL.
- **Qwen 3.5 → 3.6 → 3.7-Max** (Feb–May 2026): **Qwen3.6-27B *dense* beats the 397B Qwen3.5
  flagship on coding** [S: [codersera guide](https://codersera.com/blog/qwen-3-5-complete-guide-2026/)] —
  one generation of recipe/data beat ~15× the parameters. Also: the 3.6-Max line moved
  **closed-weights** (the open-weight faucet is not guaranteed to stay open).
- **Kimi K3** (released **Jul 16, 2026** — six days ago; weights due Jul 27): **2.8T** params, 1M
  context, the largest open-weight model ever, benchmarking next to closed frontier
  [S: [Kimi blog](https://www.kimi.com/blog/kimi-k3) · [dev.to](https://dev.to/smakosh/kimi-k3-and-chinas-open-weight-model-wave-bpp)].
  **Hallucination rate is now a headline comparison metric** in launch coverage. Rent-capability
  implication: the rentable open tier is now frontier-class; GLM-5.2 (744B, MIT) held that spot
  before K3.
- **Claude Opus 4.6** (Feb 2026) system card [P:
  [card PDF](https://www-cdn.anthropic.com/0dd865075ad3132672ee0ab40b05a53f14cf5288.pdf)]: evals now
  standardly include **honesty assessments, reward hacking, sabotage capability, and evaluation
  awareness**; testing is run against **multiple snapshots including "helpful-only" variants**
  (safeguards removed) — they deliberately test the *un-gated* model, not just the shipping one.
- **GPT-5.5/5.6** (Apr / Jun 26, 2026): first **High** ratings on bio+cyber for small fast models;
  the 5.6 card plainly admits an **over-agency regression** (unauthorized actions up vs 5.5)
  [P: [GPT-5.5 card](https://deploymentsafety.openai.com/gpt-5-5/gpt-5-5.pdf) ·
  [5.6 hub](https://deploymentsafety.openai.com/gpt-5-6)].
- **Budget shape:** 2026 frontier runs sit at **1e26–1e27 FLOPs**, and **post-training is now
  15–25% of total compute** [S: [cost trajectory](https://deluair.com/consultancy/insights/frontier-ai-training-cost-2026)] —
  the post-training stage is where a mid-size player can actually participate.

## 2. How they're TESTED — the 2026 consensus

1. **Staged capability-threshold frameworks with teeth:** OpenAI Preparedness (High/Critical per
   risk; GPT-5.5 rated **High** on bio + cyber) [P: [GPT-5.5 system card](https://deploymentsafety.openai.com/gpt-5-5/gpt-5-5.pdf)] ·
   Anthropic RSP/ASL (ASL-3 activated May 2025 **automatically on threshold cross, regardless of
   commercial considerations**) [P: [RSP](https://www.anthropic.com/responsible-scaling-policy)].
2. **System cards as the release artifact** — every release ships one, with measured evals,
   red-team findings, and *known regressions stated plainly* (GPT-5.6 card admits the flagship
   "takes actions users did not authorize more often than GPT-5.5") [P/S].
3. **External, adversarial, third-party evals:** METR ran evaluations *inside* Anthropic, Google,
   Meta, OpenAI (Feb–Apr 2026, private per-company reports) [P: [METR risk report](https://metr.org/blog/2026-05-19-frontier-risk-report/)] ·
   UK AISI pre-deployment access, 30+ models in its Trends Report; published engineering playbook
   [P: [AISI](https://www.aisi.gov.uk/blog/releasing-aisis-engineering-playbook)] · Apollo for
   deceptive alignment.
4. **Red-teaming at industrial scale:** thousands of hours against constitutional classifiers
   [P: [2501.18837](https://arxiv.org/pdf/2501.18837)]; ~200 early-access partners on real use
   cases before GPT-5.5 shipped [P].
5. **Eval-awareness is a first-class 2026 concern** — frontier models reliably distinguish evals
   from real use, undercutting pre-deployment evals; benchmarks now designed to resist
   contamination [S: METR/AISI commentary].

## 3. GAP AUDIT — us vs. the consensus (for operator review)

| # | Frontier practice (evidence above) | Our current state | Verdict / action |
|---|---|---|---|
| **G1** | Small tiers are built by **strong-to-weak distillation incl. on-policy logit alignment**, which *measurably beats RL* for ≤14B (Qwen3 [P]) — and in the current generation **even the flagship is consolidated by on-policy distillation** (DeepSeek-V4's expert→consolidate paradigm, §1b) | We do row-level verified SFT only; our design **bans** logit/KL copying on principle | **Tension to resolve, not assume.** The ban is right for the *frontier* claim (can't exceed teacher) but two generations of evidence say it's wrong as a blanket rule: on-policy distillation is now the industry's *assembly step*. Proposal: keep exec-verification as the **gate**, allow on-policy logit distillation as the **transport** for the student only. Needs founder ruling. |
| **G2** | Post-training is a **modular staged stack** (SFT → DPO → RLVR) with verifiers in the RL loop at scale | VTD = SFT-only; no preference stage, no RL stage; our verifier gates *data admission*, not *policy updates* | Adopt the standard shape instead of a bespoke one: our Fix-Rate/honesty verifiers slot directly into the GRPO/RLVR stage. The wheel exists — use it. |
| **G3** | Training mixes keep **≥60–70% human/general anchors**; synthetic/narrow data is targeted amplification only | VTD runs 1–2 trained on **100% task traces, zero retention mix** → run-1's −6 (instruct damage) is the textbook symptom | Confirmed root cause, external corroboration. Never run a distill without an anchor mix again (handoff's dolly-15k plan was right; it just never ran). |
| **G4** | **Dedup + model-based quality filtering before every train** (MinHash/LSH, perplexity filters) | Our corpora: 13-gram decontam vs eval sets only; **no dedup, no quality filter** on the training side | Cheap, standard, missing. Add MinHash dedup + perplexity filter to the corpus pipeline (#2843). |
| **G5** | Eval discipline: massive internal suites + third-party adversarial + contamination-resistant design | n=40 HumanEval (±0.20 CI); honesty ledger has **2 negatives**; no third-party analog | Already flagged in red-team; now benchmarked: we are ~2 orders of magnitude under eval-power norms. Eval-power gate stays the #1 blocker (#2847). |
| **G6** | **Hyperparameters transferred by rule** (MetaP/muP), not hand-tuned per run | lr 2e-4 → disaster → 5e-5 rescue was trial-and-error | Adopt muP-style lr scaling for any run ≥ the next tier. Minor but free. |
| **G7** | Release artifact = **system card with honest regressions stated** | Our analog (honest-scope blocks in docs, ConvergenceRecords) is real but per-doc, not per-release | Lightweight adapter "model card" template per promoted artifact — mostly assembling what we already log. |
| **G8** | **Eval-awareness / watched-vs-unwatched probing** is a live frontier concern | SIGMA0-MODEL-DESIGN D8 designed exactly this (watched/unwatched, trained-gamer) — **never executed** | We independently designed a frontier-standard test; execute it rather than redesign it. |
| **G9** | Capability-threshold gates that trigger **automatically** on eval results | Σ_θ acceptance gate exists and is the same *kind* of mechanism | Genuine alignment — keep; wire honesty evals into it instead of inventing a new gate. |
| **G10** | **Nobody trains small frontier models from scratch** — even Meta codistills; and **Qwen3.6-27B dense beat a 397B flagship one generation older on coding** (recipe/data > parameters at the small end, §1b) | ADR-0024 Phase-3 ("FRONTIER" from-scratch) is still nominally on the books | The survey hardens the case: Phase-3 should be explicitly deprioritized to research-option status; the 2026-standard path for our size is open-weights + staged post-training + distillation. Post-training is now **15–25% of frontier compute** — that stage, not pretraining, is where a mid-size player participates. |
| **G11** | Frontier cards test **"helpful-only" / safeguards-removed snapshots**, not just the shipping model (Opus 4.6, §1b) | We only ever eval the gated artifact; we have never measured what our adapters do with the Σ_θ/honesty gates off | Cheap and revealing: add a gates-off arm to every promotion eval — if the *un-gated* model is wildly dishonest, the gate is load-bearing and must be treated as a safety control, not plumbing. |
| **G12** | **Hallucination rate is now a headline launch metric** (K3 coverage leads with it, §1b); honesty/eval-awareness assessments are standard card content (Opus 4.6) | Our entire v1.10 bet is the honesty axis | **Validation, not a gap:** the market is converging on honesty as a differentiator — but it also means the axis will not stay unoccupied. Timing matters; the white-box *verifier* angle (which no card ships) remains the unclaimed piece. |

## 4. What this changes about v1.10 (one paragraph)

The v1.10 white-box honesty design keeps its differentiator (the activation-level honesty audit —
no lab ships that as a *verifier*, and the patents inspected are output-level only), but its
*training topology* should stop being bespoke: slot the honesty verifier into the **standard 2026
stack** — de-glossed SFT → DPO on honesty preferences → **RLVR with the dual verifier (exec/citation
+ probe-audit) as the reward oracle** → strong-to-weak distill to the serving tier, with an anchor
mix (G3), dedup/filtering (G4), and the eval-power gate (G5) as hard preconditions. The wheel is
already round; our contribution is the verifier bolted to it, not a new wheel.

## 5. Review asks — RULED (Alex, 2026-07-22)
1. **G1: ✅ APPROVED (compromise).** Exec-verification stays the non-negotiable gate on every
   training target; on-policy logit distillation permitted as the *transport* for the
   student/serving tier only. Recorded in the ADR-0024 amendment.
2. **G10: ✅ APPROVED.** ADR-0024 Phase-3 (from-scratch frontier) **retired** to research-option.
3. **✅ APPROVED via "map out new phases":** v1.10 §6 replaced with the phase map **V0–V4**
   (foundations → honest teacher → verifier-rewarded RL with dose-response → consolidate/distill →
   research option). See [AGI-V1.10-WHITE-BOX-HONESTY-DESIGN.md §6](../AGI-V1.10-WHITE-BOX-HONESTY-DESIGN.md).
4. **G11:** folded into Phase V0 (gates-off arm in the eval harness) — implicitly approved with
   the phase map; flag at V0 review if that reading is wrong.

*Logged for review; no design docs modified pending answers. Sources: primary reports
[2412.19437](https://arxiv.org/pdf/2412.19437) · [2505.09388](https://arxiv.org/pdf/2505.09388) ·
[2507.20534](https://arxiv.org/pdf/2507.20534) · [2507.06261](https://arxiv.org/pdf/2507.06261) ·
[GPT-5.5 card](https://deploymentsafety.openai.com/gpt-5-5/gpt-5-5.pdf) ·
[RSP](https://www.anthropic.com/responsible-scaling-policy) · [2501.18837](https://arxiv.org/pdf/2501.18837) ·
[METR](https://metr.org/blog/2026-05-19-frontier-risk-report/) · [AISI](https://www.aisi.gov.uk/blog/releasing-aisis-engineering-playbook);
secondary as marked.*
