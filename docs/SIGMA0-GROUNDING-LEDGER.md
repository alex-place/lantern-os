---
author: Alex Place
created: 2026-07-17
updated: 2026-07-17
---

# Σ_G — The Grounding Ledger

*Grounding has a price, a schedule, and a budget — and each is computable. A
design-and-synthesis companion to the [Collapse Certificate](SIGMA0-COLLAPSE-CERTIFICATE.md).*

> **Why "ledger", not "certificate."** Part II of the Collapse Certificate was renamed from
> "Update Certificate" to "Acceptance Gate" because nothing unproven may borrow Part I's
> authority. The same discipline applies here from day one: **no theorem in this document is
> new, and no section is PROVEN beyond what the parent certificate already proves.** This
> document *composes* three measured results into one accounting frame. A ledger records
> quantities and how they were computed; it certifies nothing.

---

## What this document is — and is not

**It is:** the composition of three quantitative results already recorded (with evidence
classes and run pointers) in the Collapse Certificate — the **price** of fresh verified truth
(cert §8.4/§8.4.1), the **schedule** on which grounding must arrive (cert §3.1), and the
**budget** that grounding imposes on safe self-improvement (cert §8.4 third road) — stated as
one frame with a shared falsification path. It is written by Alex Place with AI coding agents
(disclosed; agent sessions author and revise under operator review; the dates are real project
dates — this project runs in 2026).

**It is not:** a peer-reviewed paper, a certificate, or a claim of mechanism novelty. The
qualitative rule it rests on — *ungrounded self-reference degrades; external verification is
the escape* — is established prior art (Shumailov 2024; Feng et al. 2024; Huang et al. 2024,
all cited in the parent). Every load-bearing number below is imported from the parent
certificate's audit table, not re-derived here.

**Novelty: thin, named, and bounded.** A 2026-07-17 corner audit (recorded in the parent's
Appendix M) found the three quantitative corners composed here have close prior art in
*adjacent fields* and open lanes in the *LLM* literature:

| Corner | Nearest prior art (verified 2026-07-17) | What appears open |
|---|---|---|
| Schedule (§2) | self-triggered / event-triggered control (Heemels, Johansson & Tabuada, CDC 2012; arXiv:1803.08980) — mature theory for "compute the next intervention from a certified decay rate" | deriving an LLM grounding/retrieval **cadence from a measured contraction rate** with a computable commitment deadline; existing LLM work is reactive (FLARE arXiv:2305.06983; DRAGIN arXiv:2403.10081) or naive-periodic |
| Budget (§3) | the Ladder mechanism (Blum & Hardt, arXiv:1502.04585); Thresholdout (Dwork et al., arXiv:1506.02629) | applying Thresholdout to **checkpoint promotion**, the validity-vs-extraction decomposition, and the burned-pool compounding cycle |
| Price (§1) | adaptive data analysis (Dwork); zero-cost NAS proxies empirically failing to replace validation (Abdelfattah et al., ICLR 2021; NAS-Bench-Suite-Zero, NeurIPS 2022 D&B) | the **freshness law** as a stated mechanism — a deterministic checkpoint statistic cannot re-anchor selection because its error sticks to the champion |

The composed frame — one ledger with all three columns priced from the same system's own
measured quantities — is this document's only claimed contribution, and it is a *framing*
contribution until the §5 experiments run.

## Glossary — internal names → standard terms

| Internal | Standard meaning |
|---|---|
| Σ_G | this ledger (project identifier; carries no technical content) |
| grounding | injection of external verified evidence into the loop (retrieval, execution, measurement, market) |
| fresh / re-drawable | a measurement whose sampling noise is independently re-drawn on each use (a new sample from the truth distribution) |
| burned | data the selection process has already received feedback from (assume fully leaked) |
| the parent / the cert | [SIGMA0-COLLAPSE-CERTIFICATE.md](SIGMA0-COLLAPSE-CERTIFICATE.md) |

## Plain-language summary

**Price.** Fresh verified truth is the only currency that can *inform* selection — genuinely
rank which model, answer, or update is better. Deterministic self-checks (perplexity,
confidence — measured twice, same number) buy nothing in that role: their errors stick to the
champion exactly like a lucky test score does. But the E-P falsification (2026-07-17) found a
twist the original law missed: *stochastic* self-checks — and even plain added noise carrying
zero information — recover a real fraction of the budget by **shaking the champion's lucky
seat** (de-ratcheting), the same trick the Thresholdout referee performs deliberately. So the
price column has three tiers now: deterministic self-checks are worthless for selection,
fresh randomness is half a substitute (it unsticks, it doesn't rank), and only fresh truth
does both. **Internal signals detect; fresh randomness de-ratchets; only fresh truth
informs.**

**Schedule.** A loop that feeds on its own output *commits* to its trajectory at a measurable
rate, and the outside evidence needed to un-commit it grows at that same rate, then saturates.
So grounding is not an event you trigger when an alarm rings — by the time drift alarms are
reliable, the cheap part of the rescue window is gone. Grounding is a **cadence**: inject
external evidence with a period set by the loop's measured commitment half-life.

**Budget.** Because only fresh truth selects (price), and because reusing one test set lets
lucky checkpoints win, the rate at which a self-improving system can *safely* accept updates is
capped by the rate at which it can source fresh verified tasks. Recycling helps — retired test
sets, arbitrated by a noise-adding referee, measurably extend the budget without corrupting the
scoreboard — but recycling stretches the budget; it never removes the cap.

**The one-line ledger:** *what grounding buys (price), when it must arrive (schedule), and how
fast the whole system may improve (budget) are three computable functions of the same measured
quantities — and none of the three can be bought with internal signals.*

## How to audit this document

Every number below maps to an artifact already in this repo. Nothing in this document adds a
new experiment; §5 names the experiments that would.

| Claim | Class | Imported from (cert §) | Verify with |
|---|---|---|---|
| Freshness law — *deterministic* intrinsic signals add ~nothing in the selection role | MEASURED (simulation, 32 seeds) | §8.4.1 | `python experiments/sigma_update_internal_signal_value.py` |
| Freshness law RE-STATED — kill test fired: re-drawn noise de-ratchets (dither-equivalent); fresh truth still dominates | MEASURED (simulation, 32 seeds; E-P, [#2692](https://github.com/alex-place/lantern-os/issues/2692)) | §8.4.1 re-stated block | `python -m pytest tests/test_sigma_update_stochastic_signal.py -q` → 6 passed; full run: `python experiments/sigma_update_stochastic_signal.py` |
| n-graded staleness — fresh flow beats fixed holdout 22× at n=50 | MEASURED (simulation, 32 seeds) | §8.4 | `python experiments/sigma_update_holdout_staleness.py` |
| Detection value — internal bundle ΔAUC +0.121→+0.019 as external n grows 2→5 | MEASURED (one model) | §8.6 item 5 | `experiments/sigma_incremental_validity_ouro.py` (GPU; log in PR #2240) |
| Commitment inequality — escape budget B*(n) rises geometrically, saturates | PROVEN on synthetic maps (machine-checked) | §3.1 | `python experiments/sigma0_grounding_deadline.py` → `data/sigma0/grounding_deadline_report.json` |
| Deadline → token-level grounding mapping | CONJECTURED | §3.1 | open — §5 E-S |
| Thresholdout decomposition — mechanism buys validity, pool buys extraction | MEASURED (simulation, 32 seeds) | §8.4 third road | `python -m pytest tests/test_sigma_theta_thresholdout.py -q` → 7 passed |
| Scheduled-vs-reactive race — alarm premium 2.25× (well-conditioned); sliver timing-indifferent | MEASURED (simulation, 200 seeds) | §3.1 (added 2026-07-17, [#2690](https://github.com/alex-place/lantern-os/issues/2690) Phase 0) | `python -m pytest tests/test_sigma0_scheduled_grounding.py -q` → 6 passed; full run: `python experiments/sigma0_scheduled_grounding.py` |
| Composed ledger (§4) | TARGET | — (new composition) | open — all of §5 |

If a command above fails on a fresh clone, this ledger has drifted from the code and should not
be trusted until reconciled — the parent's intended failure mode, inherited.

---

## 1. The Price — what a unit of fresh truth buys, and why nothing else can buy it

**Status: MEASURED (simulation) for the selection half; MEASURED (one model) for the detection
half. The law is a statement of mechanism, not a theorem.**

Let a selection process choose among candidates (checkpoints, answers, updates) using a scoring
signal. Distinguish two roles:

- **Selection** — ranking candidates to promote a champion. Adaptive: the process feeds back.
- **Detection** — flagging a candidate as grossly broken. Non-adaptive, or nearly so.

**The measured price schedule** (cert §8.4, §8.4.1, §8.6-5; all run pointers in the audit table):

| Signal | Price in the selection role | Price in the detection role |
|---|---|---|
| Fresh verified tasks (re-drawn per gate) | **full value** — extracts 12.68 units of true quality at n=50 in the reference simulation | full value |
| Fixed verified holdout (reused) | **n-graded decay** — 22× less than fresh at n=50; within 10% of fresh only at n ≥ 2000 | full value while unburned |
| **Deterministic** internal signal (perplexity, entropy — measured twice, same number) | **~zero** — 1.0–1.2× the holdout alone; strictly *worse* as its weight rises (0.64 → 0.10); a near-oracle internal signal reaches 4.10 vs fresh 12.68 | **real but scarcity-gated** — ΔAUC +0.121 over an n=2 external gate, decaying to +0.019 by n=5; catches gross breakage only |
| **Stochastic** internal signal (self-consistency over re-drawn seeds, MC-dropout) — *re-priced 2026-07-17, [#2692](https://github.com/alex-place/lantern-os/issues/2692)* | **partial** — recovers ≈50% of fresh-flow value at n=50 purely by **de-ratcheting** (zero-information dither reproduces the entire effect, 6.42 vs 6.43); adds no information | same as deterministic |
| Deliberate dither on a fixed holdout (add noise to every score comparison) | **partial, free** — same de-ratcheting effect without any model signal; has an interior optimum (too much hurts) | n/a |

**The mechanism (the freshness law — as re-stated after its own kill test fired,
2026-07-17).** A *deterministic* intrinsic signal's error sticks to the champion exactly the
way a fixed holdout's lucky draw does, so it cannot re-anchor the selection ratchet. But the
E-P falsification ([#2692](https://github.com/alex-place/lantern-os/issues/2692), pre-registered)
found the original one-line law **too strong**: re-drawn *measurement noise* — though it
carries zero information — rescues a large fraction of the budget by **de-ratcheting** the
champion's seat (a zero-information dither reproduces the entire rescue; it is the same
mechanism Thresholdout buys deliberately with Laplace noise). Selection error decomposes into
a **stuck** part (sets the ratchet) and a **fresh** part (breaks it); only re-drawn external
truth both breaks the ratchet *and* ranks candidates, which is why fresh truth still strictly
dominates every internal arm. In three lines now: *internal signals detect; fresh randomness
de-ratchets; only fresh truth informs.*

**Honest scope.** The selection half is simulation-shaped (32 seeds, synthetic hill-climb;
shape, not constants). The detection half is one model (Ouro-1.4B), 8 truth tasks, and a
corruption ladder whose "subtle badness" cell came back empty by construction. The nearest
external work has since occupied the detection lane (Model-Centric Diagnostics,
arXiv:2601.16874; statistical degradation detection, arXiv:2602.10144) — the *incremental*
ΔAUC-over-a-tiny-external-gate design may still be unique; the lane is not.

---

## 2. The Schedule — when grounding must arrive

**Status: the inequality is PROVEN and machine-checked on synthetic maps (cert §3.1); the
mapping onto real token-level grounding is CONJECTURED; the one real-model measurement to date
is a retrodicted null, honestly recorded below.**

Inside a certified basin `{V ≤ c}` with per-step contraction `V(F(x)) ≤ γV(x)`, `γ < 1`
(`V = xᵀPx`), an external anchor of budget `‖a‖ ≤ B` can escape only if

$$B \;>\; B^*(n) \;=\; \frac{\sqrt{c} - \gamma^{n/2}\sqrt{V_0}}{\sqrt{\lambda_{\max}(P)}}
\;\xrightarrow{\;n\to\infty\;}\; B^*_\infty,$$

so any budget `B < B*_∞` stops working after a computable deadline `n*(B)`, and the loop's
**commitment half-life** is `ln 2 / ln(1/γ)` steps. The design consequences (cert §3.1):

1. **Grounding is a cadence, not only an event** — inject external evidence with a period below
   the commitment half-life.
2. **Reactive triggers are structurally late** — critical-slowing-down alarms become reliable
   only after contraction is deep, which is when `B*(n)` has saturated. (Scoped claim: proven
   in the synthetic setting; consistent with, not proven by, the measured rank≠route split.)
3. **Conditioning decides the regime** — `cond(P)` of the local basin decides whether the
   deadline is a hard constraint (well-conditioned) or toothless (sliver). Measuring it is
   cheap and should accompany any certified rate.

**Positioning against prior art (added with the 2026-07-17 audit).** "Compute the next
intervention time from a certified Lyapunov decay rate" is **self-triggered control** — a
mature field (Heemels, Johansson & Tabuada, CDC 2012; Lyapunov event-triggered stabilization
with a known convergence rate, arXiv:1803.08980). This section is that field's recipe applied
to a new plant. What the LLM literature has instead is the *event-triggered* side — FLARE
(arXiv:2305.06983) and DRAGIN (arXiv:2403.10081) trigger retrieval reactively on uncertainty —
and naive fixed-interval retrieval with hand-picked periods. **The open lane is exactly the
self-triggered counterpart: a retrieval cadence derived from the loop's measured dynamics.**
Citing the control literature imports its guarantees; it does not diminish the lane.

**Phase 0 measured (2026-07-17, [#2690](https://github.com/alex-place/lantern-os/issues/2690)).**
The scheduled-vs-reactive race (`experiments/sigma0_scheduled_grounding.py`, 200 seeds, timing
the only variable, canary swept over all healthy-quantile thresholds): in a well-conditioned
basin the charitably-calibrated alarm (FPR 1.5%) lands at median step 14 vs the cadence tick at
step 3, and the **alarm premium is 2.25×** — scheduled grounding reaches ≥90% escape at
0.40·B*_∞ where reactive needs 0.90·B*_∞. In the sliver basin a forced fire-time sweep is fully
timing-indifferent — the Ouro-regime null, produced rather than retrodicted. Synthetic maps;
single-shot policies; one detector family.

**The honest null.** The one real loop measured so far (Ouro-1.4B) is the bad regime for this
theory twice over: its true Jacobian is locally expansive and strongly non-normal
(ρ(J) ≈ 8–11, cert §6 [#2029] correction), and its basin conditioning is sliver-class, so the
theory predicts its own null — grounding stays cheap at all depths, which is what
`experiments/ouro_canary_vs_logprob.py` measured. A retrodiction, not a validation. The
schedule has therefore **never been tested where it should bite**: a well-conditioned,
genuinely contracting loop (e.g. JSRR/STARS-stabilized, ρ < 1 — the gate the project already
adopted, cert §1.2.3). That is experiment E-S (§5), Phases 1–2.

---

## 3. The Budget — how fast the system may safely improve

**Status: MEASURED (simulation) on an imported PROVEN backbone (Dwork/Thresholdout). The
compounding design is HEURISTIC.**

Because only fresh truth selects (§1), and because a reused promotion set lets lucky
checkpoints ratchet in (cert §8.4), the safe update rate is capped:

> **rate(safe promotions) ≤ rate(fresh verified task sourcing), stretched — not uncapped — by
> controlled reuse.**

**The measured decomposition** (cert §8.4 third road; `tests/test_sigma_theta_thresholdout.py`):
wrapping the fixed holdout in a Thresholdout referee and ablating the burned pool separates two
effects that naive accounting conflates:

- **Validity is bought by the mechanism.** The champion's reported-vs-true gap stays below both
  other arms at every n ≤ 2000 (n=50: fixed 0.482 vs Thresholdout 0.187 vs fresh 0.194) — fresh
  per-query noise breaks the sticky-luck ratchet.
- **Extraction is bought by the burned pool.** With no accumulated pool, extraction collapses
  to the naive-fixed arm; with a realistic accumulated pool (4n), the managed arm beats even the
  same-n fresh flow for n ≥ 100 (21.8 vs 18.0 at n=100) while staying *more* honest than fresh.

**The compounding design (HEURISTIC):** retire each promotion set into the burned exploration
pool after use and let the referee arbitrate pool-versus-holdout feedback. Retired truth is not
dead — the tiers form a cycle, not a conveyor. The rotating-tier structure is cert §8.4.1's
four-tier discipline, unchanged.

**Positioning against prior art (added with the 2026-07-17 audit).** The problem shape —
adaptive promotion against a reused evaluation with limited feedback — is the **Ladder**
(Blum & Hardt, arXiv:1502.04585), built for competition leaderboards; the mechanism imported
here is **Thresholdout** (Dwork et al., arXiv:1506.02629), which has almost no applied
literature. The validity/extraction decomposition and the burned-pool cycle appear unpublished.
**The standing counterpoint:** Roelofs et al. (NeurIPS 2019) meta-analyzed ~100 Kaggle
competitions and found *little* adaptive overfitting in practice — so the severe small-n
staleness measured here may describe an adversary real promotion pipelines don't resemble.
Whether the ratchet materializes at practical scale is exactly what experiment E-B (§5) exists
to answer; until it runs, the budget cap is a simulation-shaped claim.

---

## 4. The composed ledger

**Status: TARGET — a design frame, exactly as the parent's Part III is. Nothing below is
proven, and the three columns rest on different evidence classes (see §1–§3).**

One system, three computable columns from its own measured quantities:

| Column | Computed from | The computed thing | Evidence class today |
|---|---|---|---|
| **Price** | signal type (re-drawable vs deterministic) × role (select vs detect) | what a scoring signal is worth, per role | MEASURED (sim); MEASURED (one model) |
| **Schedule** | measured contraction rate γ, basin size c, metric P | grounding cadence (< commitment half-life) and per-depth escape budget B*(n) | PROVEN (synthetic) + CONJECTURED (mapping) |
| **Budget** | fresh-task sourcing rate + reuse mechanism + pool size | max safe promotion rate | MEASURED (sim) on PROVEN backbone |

The joint statement — the ledger's only new sentence:

> A self-improving loop's safe operating point is set by three couplable constraints: it must
> ground **at least** on the schedule's cadence (or re-commitment outruns the anchor), it may
> promote **at most** at the budget's rate (or selection outruns fresh truth), and it must
> price signals by **re-drawability** when deciding what counts as grounding at all. All three
> constraints are computable from measured quantities of the same object — none requires an
> oracle, and none can be relaxed by internal signals.

*In plain words:* the loop has a metabolism. It must eat outside evidence at a floor rate, it
can grow at a ceiling rate, and no amount of introspection substitutes for food.

## 5. Falsification path (before trusting any of this)

Three experiments, ordered by cost, each tracked as a repo issue. Each names its kill
condition — what result would delete which column.

- E-P → [#2692](https://github.com/alex-place/lantern-os/issues/2692) (**done 2026-07-17 — the
  kill condition fired; §1 re-priced**) ·
  E-S → [#2690](https://github.com/alex-place/lantern-os/issues/2690) (Phase 0 done 2026-07-17) ·
  E-B → [#2691](https://github.com/alex-place/lantern-os/issues/2691)

1. **E-P (price — RUN 2026-07-17, kill condition FIRED).** The prediction tested: a
   **stochastic** internal signal (re-drawable noise, checkpoint-fixed bias) still cannot
   extend the selection budget. **Measured outcome
   (`experiments/sigma_update_stochastic_signal.py`, pre-registered):** H-P1 confirmed
   (bias→noise error shift raises extraction 0.81 → 9.36 at n=50), but **H-P2 refuted** —
   re-drawn noise at fixed bias rescued extraction 7.9×, and a post-hoc zero-information
   dither control reproduces the entire rescue (6.42 vs 6.43). The law was too strong; §1's
   price table and mechanism paragraph are re-priced accordingly (de-ratcheting is real and
   nearly free; information still requires fresh truth, which still strictly dominates). The
   optional real-model arm folds into E-B.
2. **E-S (schedule — needs a well-conditioned loop).** Prospective deadline test on a
   JSRR/STARS-stabilized loop (ρ < 1, measured `cond(P)` moderate): predict `B*(n)` and the
   half-life from the measured γ and P *before* the run; then measure actual correction cost vs
   injection depth; then race scheduled grounding (period from the half-life) against
   FLARE-style reactive grounding on a factuality benchmark. **Kill condition:** correction cost
   flat in depth on a well-conditioned loop kills the §2 mapping (the additive-anchor model
   fails); reactive ≥ scheduled everywhere kills the design consequence.
3. **E-B (budget — the cloud A/B/C run, the parent's standing empirical gap).** The three arms
   live around a real RLVR/distill step: fixed holdout vs fresh flow vs Thresholdout+pool,
   scored on truly hidden tasks. **Kill condition:** if the fixed-holdout ratchet does not
   materialize at realistic n and gate counts (the Roelofs counterpoint), the budget cap is a
   worst-case story and §3 must be re-scoped to adversarial promotion processes.

Sequencing note: E-P falls out of the existing harness nearly for free; E-S piggybacks on the
already-merged JSRR gate (cert §1.2.3, PR #2237); E-B is the same cloud-L4 run the parent's
§8.6 teeth 2–3 already require — this ledger adds no new infrastructure demands.

## 6. Relation to the parent certificate

| Ledger column | Imports from cert | Adds |
|---|---|---|
| §1 Price | §8.4 (staleness), §8.4.1 (freshness law), §8.6-5 (detection) | the per-role price table; the E-P falsification |
| §2 Schedule | §3.1 (commitment inequality, deadline, half-life) | the self-triggered-control positioning; the E-S design |
| §3 Budget | §8.4 third road (Thresholdout decomposition), §8.4.1 tiers | the Ladder positioning; the Roelofs counterpoint; the E-B kill condition |
| §4 Composition | Part III's composition *pattern* | the three-constraint operating point (TARGET) |

The parent remains the source of record for every theorem, measurement, and evidence class;
this ledger must never be cited as upgrading any of them. If the two documents disagree, the
parent wins and this one is stale.

---

## References (lineage; every arXiv ID verified on its stated date)

Verified 2026-07-17 (this document's corner audit):

- W. P. M. H. Heemels, K. H. Johansson & P. Tabuada, *An Introduction to Event-triggered and Self-triggered Control*, IEEE CDC 2012 — the schedule column's prior-art field.
- **arXiv:1803.08980** — *Lyapunov Event-triggered Stabilization with a Known Convergence Rate* — intervention timing from a certified decay rate.
- **arXiv:2305.06983** — Jiang et al., *Active Retrieval Augmented Generation* (FLARE) — the reactive/event-triggered side of LLM retrieval timing.
- **arXiv:2403.10081** — *DRAGIN: Dynamic Retrieval Augmented Generation based on the Real-time Information Needs of LLMs* — token-level reactive triggering.
- **arXiv:1502.04585** — Blum & Hardt, *The Ladder: A Reliable Leaderboard for Machine Learning Competitions* — adaptive promotion gating with limited feedback.
- R. Roelofs et al., *A Meta-Analysis of Overfitting in Machine Learning*, NeurIPS 2019 — the budget column's standing counterpoint (little adaptive overfitting across ~100 Kaggle competitions).
- **arXiv:2601.16874** — *Model-Centric Diagnostics: A Framework for Internal State Readouts*; **arXiv:2602.10144** — *When LLMs get significantly worse: a statistical approach to detect model degradations* — the detection lane, now occupied (see cert §8.6-5 correction).
- Abdelfattah et al., *Zero-Cost Proxies for Lightweight NAS*, ICLR 2021; *NAS-Bench-Suite-Zero*, NeurIPS 2022 D&B — internal proxies empirically failing to replace validation (the price column's empirical parallel in NAS).

Verified earlier, in the parent (cited here via the cert, not re-verified): Dwork et al.
arXiv:1506.02629 (Thresholdout); STARS arXiv:2605.26733; per-token commitment arXiv:2604.23235;
TRPO arXiv:1502.05477; Gao arXiv:2210.10760; Shumailov *Nature* 2024; Feng arXiv:2406.07515;
Huang arXiv:2310.01798.

*Per the parent's §References rule — an early draft of the cert once carried four fabricated
arXiv IDs — no ID above is cited unverified, and each carries its verification date.*
