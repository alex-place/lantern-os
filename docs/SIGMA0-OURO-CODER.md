---
author: Alex Place, with the unisona.ai agent lanes
created: 2026-06-19
updated: 2026-07-27
status: >-
  Public whitepaper — SUPERSEDED IN PART (operator decision, 2026-07-23, later same day).
  The model is a DISTILLED ≤3B looped student, not a from-scratch pretrain. §5's from-scratch
  costing is retained as reference/contingency only. Everything verifier-, serving-, stability-,
  and honesty-shaped in this paper carries over to the distilled program unchanged.
  Prior revisions of this page (the retrofit-era lineage SSOT) are preserved in git history.
  Internal engineering twins — research/2026-07-23-sigma0-llm-design.md (design of record),
  research/2026-07-23-sigma0-rc1-model-spec.md (baseline harness), SIGMA0-COLLAPSE-CERTIFICATE.md.
---

# Σ₀ — A Verified Looped Language Model, Built From Scratch

> **Supersession note (2026-07-23).** The operator resolved the build-vs-distill tension the
> same day this revision was published: **Σ₀ is a distilled ≤3B looped student** (teacher-
> verified, exec-gated — ADR-0015/ADR-0024 lineage), consistent with ADR-0024's Phase-3
> retirement and the frontier build/test survey (G10: "nobody trains a small frontier model
> from scratch — even Meta codistills"). The from-scratch program below is preserved as the
> costed contingency it always was (§5, §9 kill-criteria), not the live plan. The paper's
> core claims — external verifier as ground truth, the Spiral runtime, loop-stability
> contract, ternary serving target, honesty-by-contract — are architecture-of-the-*student*
> claims and are unchanged by the supersession.

**A whitepaper on a small language model designed to be owned, not rented: trained from
scratch for verifiable work, stable by construction, honest by contract, and small enough to
run on the computer you already have.**

---

## Abstract

**Mission (operator, 2026-07-24):** *build an AI assistant that delivers the maximum useful work
from ordinary hardware, so people get a private, reliable assistant that simply works wherever
they are.* Σ₀ is this mission's model program — the local core that grows the share of that work
done privately on the user's own machine; the verified system around it delivers the rest.

Frontier language models buy capability with scale: hundreds of billions of parameters,
trillions of training tokens, datacenter serving. Σ₀ ("Sigma-Zero") is a bet on the opposite
corner of the design space: a **~1.5B-parameter, weight-tied *looped* transformer, trained
from scratch as a specialist in verifiable work — code, mathematics, and trading** — where an
**external verifier, not the model's own opinion, is the ground truth** at every stage: data
selection, training reward, checkpoint promotion, and inference-time acceptance. Its defining
runtime behavior is the **Spiral**: it does not answer once and stop; it proposes, checks
against reality, and **retries — deeper, or from a new angle — until the verifier confirms an
answer**, escalating a stuck step to a larger model rather than giving up, and halting honestly
only when the loop, escalation, and budget are all spent. The verifier is what makes this
persistence *converge on truth instead of on confident nonsense*. The model reuses one shared
block recursively (depth, not width, as the scaling axis), is regularized during training for
provable loop stability, and targets a CPU-viable ≤4GB serving footprint with a
ternary-precision path. We state every claim with its evidence class, publish the kill-criteria
that would falsify the program, and estimate the full from-scratch training cost at an order of
magnitude accessible outside the frontier labs. Σ₀ does not compete with frontier models on
breadth. It competes on **verified correct answers per dollar on local hardware** — a
measurable frontier where small, careful, and honest can win.

## 1. Motivation

Four observations drive the design:

1. **Test-time computation can beat parameter count.** A small model that searches under a
   reliable verifier can outperform a much larger model answering once (Snell et al., 2024,
   arXiv:2408.03314). The catch: the verifier must be exact and cheap.
2. **Code and math have a free, exact verifier — the execution environment.** A test passes
   or it doesn't. This is the one domain where a small model cannot bluff and a large model
   holds no monopoly on truth.
3. **Generalization comes from verification, not scale.** Small recursive models have
   already reached public reasoning leaderboards, and the analysis of those systems (ARC
   Prize, 2025) shows their gains come from iterative refinement — while their failures come
   from memorizing instead of generalizing, precisely when the halt signal is *learned*
   rather than *checked*. We reproduced this failure on a real execution run: a memorizing
   program passed **every** visible test and failed the held-out one. Σ₀'s answer is
   architectural: the verifier is external, and held-out checks are mandatory.
4. **Verification generalizes past code — to any domain where reality eventually grades you.**
   Markets are the clearest example: a trade is right or wrong, a forecast is scored, *once
   the market resolves*. The only difference from code is timing — a trade's verifier lives in
   the **future**, not in a test you can run now. Σ₀'s runtime handles both: the instant
   verifier where one exists, and, where the verdict is delayed, verifying the one thing that
   *is* checkable before you risk money — whether a claimed edge is real (§3.1).

The product thesis follows: for a user with an ordinary computer, **no system should deliver
more verified-correct answers per dollar per day** — locally, privately, offline.

## 2. Design principles

1. **The verifier never moves inside.** Execution results gate everything; internal
   confidence signals are alarms, never judges (our measured "Freshness Law":
   self-assessment cannot substitute for fresh external tests).
2. **Depth over width.** Capability scales by re-applying one shared block (looping), not by
   adding parameters. Loop depth is a *dial the user's budget controls*.
3. **Stability is a contract, not a hope.** Looped models exhibit peak-then-collapse under
   depth. Σ₀ trains against a spectral-stability regularizer and serves behind a
   spectral-radius acceptance gate (ρ(J) < 1), with a proven anti-freeze operator armed
   under a bounded budget. (Machinery: our Collapse Certificate — theorems proven in-regime
   and machine-checked; scope stated there honestly.)
4. **Persistence first; abstention is the earned floor.** The Spiral does not answer once —
   it retries until the verifier confirms an answer, escalating a stuck step rather than
   quitting (§3). A trained abstention head (supervised by verifier outcomes) makes "I cannot
   verify this" a real output, but it fires *only* after the loop, escalation, and budget are
   exhausted — which is exactly what makes it trustworthy when it does. Precision-of-claimed-
   solve ≈ 1.0 is a headline metric, not a footnote.
5. **Small enough to own.** ≤4GB, CPU-viable, offline-first. If it needs a datacenter, it
   has failed the mission.

## 3. The Spiral — the runtime that doesn't quit

The Spiral is Σ₀'s inference procedure, and its whole point is **persistence toward a verified
answer**:

1. **Propose** a candidate.
2. **Check** it against the external verifier (run the tests; execute the code).
3. **If it fails, try again** — deeper in the loop, or from a new angle — keeping every step
   that provably advanced the problem and discarding the rest.
4. **If the cheap local tier stalls**, escalate *that step* to a larger model — local first,
   cloud only when needed — carrying the best attempt and the exact failures with it, then
   re-verify. It borrows a bigger brain for one step; it does not restart.
5. **Halt** on one of three: **verified** (the answer passed, including held-out checks — the
   goal); **budget exhausted** (you set the dial — the Spiral is an *anytime* algorithm, its
   answer only improves with more of it); or **honest halt** — "I cannot verify this" — which
   fires only when the loop *and* escalation *and* budget are all spent.

The critical property, and the reason the verifier is non-negotiable: **the verifier is what
tells the loop it has arrived.** Remove it and "try again until it knows" degrades into "try
again until it is *sure*" — a spiral that converges on a confident wrong fixed point, the
representational collapse our Collapse Certificate is built to prevent. The checker is what
makes a spiral a spiral instead of a whirlpool: persistence is the behavior, the verifier is
both the brake and the destination.

Contrast a single-pass assistant: a frontier chat answers once and moves on, so a wrong answer
is *your* problem to catch. The Spiral makes the wrong answer *its* problem to fix — it keeps
working until it can prove the answer, or, rarely, until it has earned the right to say it
can't.

### 3.1 Trading — proving the edge, not the outcome

Trading is a verifiable domain with a twist that shapes the whole product: **at the moment you
decide a trade, the verifier is in the future.** The market has not resolved; the ground truth
does not exist yet. You cannot spiral-until-the-trade-wins.

So the Spiral runs on the part that *is* checkable now — the **analysis**, not the outcome. It
retries until it can either:

- **ground an edge in data** — a measured, fee-adjusted, backtested advantage with a track
  record (the system already logs and Brier-scores its own market calls; e.g. a
  weather-settlement edge measured 14/14 against venue prints) — or
- **prove there is no edge** — the honest, valuable negative (e.g. a 15-minute crypto market
  that *loses after fees*, so the correct action is "don't").

The persistence converges on *"is there a real edge here,"* which you can verify before
risking money — not *"will this win,"* which you cannot. And because every call is scored
against reality over time, the assistant earns a **calibrated track record**, a thing a
single-pass cloud chat structurally cannot offer because it never keeps score. This is the
bridge from "honest reasoning engine" to "trading assistant worth paying for": Σ₀ is not
smarter than a frontier model about markets — it is *right on the record, private, and able to
prove or disprove an edge before you act.*

## 4. Architecture

| Component | Specification | Rationale / source |
|---|---|---|
| Core | **weight-tied looped transformer**, one shared block of ~8 layers, recursion R ∈ 2–8 | depth as the third scaling axis (Ouro, arXiv:2510.25741); elastic-depth training with short/long-unroll consistency (arXiv:2602.11451) |
| Parameters | **~1.5B** (product tier ≤3B hard ceiling) | smallest tier with a measured usable truth signal (probe AUROC 0.980/0.774 at 1.5B-class; 0.5B fails) |
| Exit / halt | learned early-exit **calibrated against the external verifier** during training | the ARC lesson: a purely learned halt memorizes; a verifier-calibrated one generalizes (design bet, falsifiable) |
| Attention | GQA + QK-Norm baseline; **static 3:1 hybrid linear-attention variant** (Gated-DeltaNet class) for long-context/CPU | the 2026 mainstream (Qwen3.5 promoted the hybrid to flagship); *static* layer patterns are certifiable by our stability machinery — unlike input-routed MoE |
| Positional | RoPE + NoPE mix on the sliding pattern | current small-model best practice (SmolLM3, Cohere-class recipes) |
| **Excluded: MoE** | no mixture-of-experts in v1 | routed recurrent loops are *switched systems* our certificate does not yet cover; a named admission gate (dwell-time certification) must exist first — deferred, not rejected |
| Auxiliary objective | multi-token prediction head | native self-speculative serving (draft-free speedup on CPU). IMPORTED confirmation at frontier scale: Kimi K3 pre-trains an MTP layer and fine-tunes it into its EAGLE-3 draft, optimizing the **negative log acceptance rate directly** (L_LK = −log Σ min(p,q)) rather than a KL surrogate (K3 tech report §4.1, 2026-07-27) — the same optimize-the-deployed-metric discipline as our Fix-Rate reward; adopt the LK loss when the draft path is built |
| Precision | bf16 from-scratch run → **quantization-aware ternary W1.58A8** (BitNet-class) as the serving artifact | the only published route to 7B-class capability in ~2GB with CPU-native kernels; probe-survival is the acceptance test |
| Tokenizer | own ~64k BPE trained on the specialist corpus | from-scratch means the whole stack (nanochat/CS336 pattern) |
| Context | 8k at pretrain → 32k staged extension | task window for verified coding work |

## 5. Training program — from scratch, honestly costed

**The wedge that makes from-scratch feasible:** we are not training an 11-trillion-token
generalist (SmolLM3's bill for a competitive general 3B). We are training a **specialist**
whose corpus is dominated by *verifiable* material — code with tests, mathematics with
checkable answers, structured reasoning traces that passed execution. The core bet
(**UNPROVEN, falsifiable at pilot scale**): verifier-filtered specialist data + depth
recursion buys more verified capability per token than generalist breadth.

- **Data (~500B–1T tokens, staged):** permissively-licensed code/math corpora (TACO
  Apache-2.0 as anchor; exec-verified subsets of open training sets; open web math/code
  slices à la Dolma 3), plus our own **escalation corpus** — frontier-teacher solutions to
  problems our earlier small tiers failed, each one execution-verified. Selection is
  **utility-matched, not quality-maxed**: high-perfection teacher traces measurably impair
  small students (the Quality-Utility Paradox, arXiv:2606.16152 — independently confirming
  our own measured negative). Test suites used in training are **mutation-hardened** (weak
  tests admit false solves; mutation feedback lifts test discrimination 53%→89.5%,
  arXiv:2501.12862). The escalation corpus is now a **live pipeline** (PR #2995, 2026-07-27,
  MEASURED): `scripts/spiral_build_self_train.py` turns the Spiral's own corpus sink into a
  replay-balanced, reward-weighted SFT set (current: **258 exec-verified records — 52
  rung-lift @1.0, 206 replay @0.4**), and the harness persists the **failed cheap attempt +
  per-test verify detail** on every escalated turn. The first schema-v2 batch (40 MBPP
  problems, 0.5B cheap / 7B escalation, fully local) produced **28 real repair-pair rows** —
  5 complete (failed attempt + verified fix), 23 attempt-only awaiting rescue — unlocking
  contrastive pairs and RWOPD-style partial-credit weights (verdict-weighted teacher-KL on
  verifier-passing rollouts beat rejection-SFT by +5.4pp at 7B, arXiv:2605.13501 — IMPORTED).
  Known gap, stated honestly: ollama tiers report `cost: 0`, so per-row cost must be injected
  or priced at analysis time before router-economics claims are made from this corpus. One
  negative result imported as a design rule: distilling the *retry/backtrack behavior itself*
  transfers at ~5% (Aletheia, arXiv:2601.14290), so the Spiral's control flow stays in the
  harness and the student trains only on prompt→verified-solution.
- **Objectives:** cross-entropy + **JSRR spectral-stability regularizer** (STARS,
  arXiv:2605.26733) + multi-token-prediction auxiliary; then **RL from verifiable rewards**
  where the reward is the executed **Fix-Rate** (fraction of failing tests a step turns
  green, regression-penalized); then ternary distillation.
- **Promotion discipline:** no checkpoint replaces another without passing the **Σ_θ
  acceptance gate** on *fresh held-out* verified tasks — self-checks can spot disasters;
  only fresh outside tests may pick winners.
- **Cost (PREDICTED, order-of-magnitude, ±2×):** 6·N·D·R̄ with N=1.5B, D=1T, mean unroll
  R̄≈3 ⇒ ~2.7×10²² FLOPs ≈ **20–30k H100-hours ≈ $50–150k** for the full run — outside
  hobby range, inside indie range, and staged so most of the risk is retired for thousands,
  not tens of thousands:
  **G0** nanochat-scale dry run of the full pipeline (~$10²) →
  **G1** ~130M-parameter looped pilot on the specialist mix (~$10³): the go/no-go
  measurement for the specialist bet and the verifier-calibrated halt →
  **G2** the 1.5B run (funded decision, gated on G1) →
  **G3** ternary artifact + probe-survival acceptance.

## 6. What carries over from our measured groundwork

This program does not start from zero evidence. Already measured on our hardware and
codebase (evidence class MEASURED unless noted): execution-verified cascade economics (a
strong cheap tier escalates ≈0% of steps at 8.3× lower cost; weak-tier + frontier rescue
88.4% > 84.8%; fresh anchor 2026-07-27: a 0.5B cheap tier reaches only 40% cheap-sufficiency
with 19/40 problems unsolved even after 7B escalation — the cheap-tier capability floor is
real and measured, not assumed); an internal truth-signal probe clearing the useful bar at the 1.5B tier;
dose-response curves for distilling verified traces into small models (small aggressive doses
*hurt*; gentle + retention holds parity — the from-scratch data rules encode these lessons);
the collapse-prevention operator at 100% over 900 forced-collapse runs (synthetic regime;
PROVEN anti-freeze theorem in-regime); and the JSRR acceptance gate machine-checked on
known-spectrum cases. The verified-cascade harness itself is retained — **not as the
product, but as the teacher-and-examiner infrastructure** that generates Σ₀'s hardest
training data and grades its checkpoints.

## 6.1 Toolchain — develop, maintain, test

The model is one artifact; the program is the toolchain around it. Every tool below **exists
and has run** (MEASURED unless marked); gaps are named, not implied away.

| Stage | Tool | Status |
|---|---|---|
| **Runtime** | `apps/lantern-garage/lib/spiral-harness.js` (the Spiral loop) + `spiral-tiers.js` (tier wiring) + `spiral-fix-rate.js` (the Fix-Rate verifier, pure) | live; 26/26 unit tests |
| **Corpus generation** | `experiments/spiral_gen_traces.js` — runs the cascade over MBPP/TACO, emits exec-verified traces; the harness sink adds per-turn rows (`cheapAttempt`, `verifyDetail`, `model`) | live; last batch 2026-07-27 |
| **Dataset build** | `scripts/spiral_build_self_train.py` — replay-balanced, reward-weighted SFT set from the sink; prints schema-gap report | live; 258 records |
| **Data prep** | `scripts/fetch_mbpp.py`, `scripts/fetch_taco.py` (Apache-lineage problem sets) | live |
| **Training** | `scripts/train_qlora_qwen_coder.py`, `scripts/train-qlora-peft.py` + `scripts/continual-train.ps1` launcher; local 4080 or Modal L4; env via `scripts/rebuild-train-venv.ps1` (`.venv-train`, cu121) | live; #2729 8-config sweep ran end-to-end |
| **Serving** | `ouro_serve.py` (`KEYSTONE_SERVE_OURO=1`) local; ollama for tier models | live |
| **Evaluation** | `scripts/eval_humaneval_ouro.py` / `eval_humaneval_chat.py` (raw model vs whole product), `eval_coding.py` (MBPP), `eval_qwen_coder.py` (held-out lift), SWE-bench via official Docker harness (WSL2) | live; ledger-backed |
| **Statistics** | `scripts/eval_paired_diff.py` — paired per-problem diff, SEM/CI/sign test; the no-bare-means rule | live |
| **Provenance** | `data/eval/leaderboard.jsonl` append-only ledger (`git_sha`, `served_checkpoint`, `campaign_id`) + CI gate `eval-leaderboard-gate.yml` — no serving change ships without a fresh row | live, CI-enforced |
| **Research grounding** | `F:\arxiv-corpus` BM25 index (115,761 papers, `scripts/arxiv_harvest.py` / `arxiv_build_index.py`) — novelty checks and citation audits behind every IMPORTED claim | live; refreshed 2026-07-27 |

**Named gaps (the maintenance backlog, honestly):**
1. **Cost injection in `spiral-tiers.js`** — ollama tiers emit `cost: 0`; router-economics
   measurements from the corpus need real or table-priced costs (#2998).
2. **Multi-seed discipline is partial** — the eval `--seed` arg landed (#2942) but the #2729
   replay-balance headline is still single-seed; no comparative claim graduates past PREDICTED
   until the paired multi-seed confirm lands.
3. **Repair-pair consumer does not exist yet** — the corpus now emits contrastive pairs; the
   v2 builder that trains on them is #2998 slice 1 (PLANNED).
4. **No automated corpus-drift check** — nothing yet alerts if the replay/lift ratio or the
   verifier-pass vs held-out-pass ratio drifts (the verifier-blind-spot instrument); design
   asked for in the ship-of-theseus program, not built.

## 7. Evaluation and falsifiers (pre-registered)

Headline metric: **verified pass@1 per dollar on reference consumer hardware**, with
precision-of-claimed-solve reported alongside. All comparative rows obey the **harness-swing
rule** (docs/BENCHMARKS.md, 2026-07-27): on agentic marks the scaffold moves scores by 10–26
points (IMPORTED — measured vendor-vs-neutral spreads), so no cross-harness ranking is ever
quoted, and the harness + reasoning-history/compaction policy is stamped on every row as a
measurement-affecting setting (frontier confirmation: Kimi K3's template *only* supports
preserved thinking — a compaction change puts the model out-of-distribution by construction). Registered runs: HumanEval-164 under the
verified protocol (held-out scoring); MBPP held-out; ARC-AGI-2 *budgeted* track (the
cost-efficiency band, ~$0.20/task class — explicitly not the $10–$200 frontier cluster);
depth-stability sweeps (accuracy and ρ trajectory vs. loop depth). Kill criteria: if
verifier-guided refinement cannot beat equal-compute blind sampling, the thesis fails; if
the G1 pilot shows the specialist mix cannot outperform a retrofit baseline at matched
compute, **the from-scratch program stops and says so** — the retrofit path remains the
fallback, and the measurement stands either way.

## 8. Positioning

| Against | Their strength | Σ₀'s differentiation |
|---|---|---|
| Frontier cloud models | breadth, peak capability | verified answers/$ locally; privacy; offline; honesty contract |
| Small open dense models (Qwen/Phi/Gemma class) | strong single-shot baselines | looping + verifier amplification + stability/abstention machinery around a comparable parameter budget |
| Looped research models (Ouro/HRM/TRM) | the same depth bet, at research maturity | external-verifier halt (vs. learned/memorizing halt), stability-gated serving, a product envelope, and full training-provenance discipline |
| Diffusion code models (Mercury class) | raw parallel throughput | orthogonal; a candidate future proposer inside the same verified protocol |

Transparency reference: OLMo 3 (AI2) sets the bar for reproducible training releases; Σ₀
adopts the same posture at its scale — data recipes, training code, checkpoints, and the
evidence ledger for every claim in this paper.

## 9. Claims discipline

Every Σ₀ statement carries one of five classes — **PROVEN** (theorem, machine-checked,
scope stated) · **MEASURED** (a run you can re-execute) · **IMPORTED** (external result,
cited, not re-verified) · **PREDICTED** (calculation ahead of measurement) · **UNPROVEN
BET** (the honest name for the parts that make this a research program). The two bets that
matter: the specialist-data wedge (§5) and the verifier-calibrated halt (§4). Both die or
survive at G1 for roughly the cost of a used car — which is the point of the staging.

## 10. Lineage

Σ₀ stands on a year of prior local-model work: a QLoRA'd 3B coder (retired), the Ouro-1.4B
looped kernel (the recursion substrate and serving stack), an owned parallel-loop
transformer, a verified Qwen-7B tier (now the escalation reference), and the Spiral
verified-cascade harness (now the teacher/examiner). The full engineering history of each
era is preserved in this file's git history and the internal design docs. An ADR formalizing
the from-scratch program (G0–G3, budget gates) follows operator approval.

**Honesty-axis twin.** Where this whitepaper owns the *coding/math* axis (an exec-test verifier
gates each step), its counterpart on the *truthfulness* axis is
[AGI-V1.10-WHITE-BOX-HONESTY-DESIGN.md](AGI-V1.10-WHITE-BOX-HONESTY-DESIGN.md) — a hidden-state
honesty probe used as a held-out verifier over self-minted convergence data. Same thesis: the
verifier, not scale, is the source of generalization.

---

*unisona.ai / Lantern OS — 2026-07-23. Corrections welcome: every number above is either
reproducible from this repository or marked as a bet.*
