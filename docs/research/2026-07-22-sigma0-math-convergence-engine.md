# Σ₀-math → convergence engine: a low-cost, indefinite-horizon spiral

**Date:** 2026-07-22 · **Method:** one `!wide-search` fan-out (10 parallel queries, no workflow),
date-anchored to 2026 · **For:** research epic [#2851](https://github.com/alex-place/lantern-os/issues/2851).
**Thesis:** apply the *existing* Σ₀ owned-math (M1–M6, issues #2786–#2791) as the **control law**
that lets the v1.10 model run the CLAUDE.md loop (Observe→Remember→Reason→Act→Verify→Converge)
**indefinitely, in a spiral, at bounded cost** — instead of answering once.

## The opening (why this is worth doing)
The 2026 literature independently confirms every failure the Σ₀ math targets — **and admits it has
no principled fix**:
- *"Principled solutions don't yet exist — just mitigation patterns"* for long-horizon runaway /
  error-accumulation ([2604.11978](https://arxiv.org/html/2604.11978v1)).
- *"Memory staleness remains unsolved at the tooling level"* ([mem0 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)).
- Agent **drift** over long horizons: **−42% success** (36.7pp absolute), **3.2× human
  interventions**, and stacked mitigations recover only **>81%** ([2601.04170](https://arxiv.org/html/2601.04170);
  numbers full-text-verified).
- Systematic **agentic overconfidence**: **73% predicted vs 35% actual** confidence, gap up to
  **+0.55** (Gemini), self-assessment AUROC only **0.51–0.64** ([2602.06948](https://arxiv.org/pdf/2602.06948);
  full-text-verified — the RLHF-degrades-calibration claim is *not* from this paper).
- Self-improvement loops *"exhibit rapid asymptotic saturation"* (Gödel Agent / DGM / STOP;
  introspection threshold [2607.04277](https://arxiv.org/html/2607.04277v1)).

So the field has the **pieces** but no **control law**. Σ₀'s owned math is exactly that law.

## The map — each owned theorem → an external mechanism → a convergence stage

| Σ₀ math (owned) | External 2026 partner (validates / formalizes) | Convergence stage | The move |
|---|---|---|---|
| **M2** grounding half-life, EOQ cadence `T*=√(2(p_v/p_e)/ρ)` (#2787) | staleness "match decay rate" heuristic; FOREVER forgetting-curve replay; Priority Decay; Supersede memory-update gap ([2606.27472](https://arxiv.org/pdf/2606.27472)) | **Remember** | **the cost lever.** Per-fact decay ρ (from refutation ages) → each fact re-grounds on *its own optimal clock*, not every step. Closed-form where the field uses heuristics. |
| **M4/L3** Kreiss-inflated thresholds (#2789) | contraction→Lyapunov ([2404.11707](https://arxiv.org/html/2404.11707v1)); Fixed-Point Reasoners — halt on convergence to **a single fixed point of the looped block** ([2606.18206](https://arxiv.org/abs/2606.18206)); attractor/equilibrium reasoners ([2605.21488](https://arxiv.org/pdf/2605.21488)); STARS; **decades of Iterative Learning Control** (spectral-radius<1 contraction, US7345448B2 / US8094405B1, see patent landscape) | **Reason** | loop until latent fixed point = halting; Kreiss constant handles the **non-normal transient growth** plain contraction theory misses (our collapse-cert gap). |
| **M5** water-filling dilation, KKT `bᵢ*=max(0,·)` (#2790) | **"Shadow Price of Reasoning"** economic budget ([2606.03092](https://arxiv.org/pdf/2606.03092)); ROI-Reasoning knapsack; AVA value-of-information; UCCI cost-optimal cascade ([2605.18796](https://arxiv.org/pdf/2605.18796)) | **Act** | spend the compute/grounding budget where marginal value-of-information is highest. The shadow-price = our water level — near-identical framing, and we have the closed form. |
| **M1** No-Free-Confidence `ΔJ ≤ η·evidence − λ·unverified` (#2786) | agentic overconfidence ([2602.06948]); **martingale** information-fidelity of tool use ([2602.13320](https://arxiv.org/pdf/2602.13320)) | **Verify / Converge** | confidence is a **supermartingale** unless external evidence arrives — the anti-runaway invariant the calibration literature lacks. |
| **M6** lasing threshold `G/L>1 → runaway` (#2791) | error snowball / autoregressive amplification ([2604.11978]); runaway loops from missing termination | **Verify** | the *quantitative* kill-condition for the "snowball" everyone describes only qualitatively. |
| **M3** monitor indistinguishability (#2788) | drift needs multi-dimensional behavioral metrics; classical ML monitoring "insufficient" ([2601.04170]) | **Verify** | which canary axes are jointly necessary (degeneration + surprise; hard cadence required). |

## The systems substrate (how it runs indefinitely at low cost)
- **Observe — bounded context regardless of duration:** externalize persistent state
  (InfiAgent file-centric abstraction; Self-GC [2607.00692](https://arxiv.org/pdf/2607.00692);
  AgentFold context-folding). Indefinite horizon without unbounded context.
- **Act — the Spiral IS the cost-bound:** cheap-tier-first + verified escalation is the decision-
  theoretic cascade the field converged on (FrugalGPT / RouteLLM / UCCI / C3PO; "Is Escalation
  Worth It" [2605.06350](https://arxiv.org/pdf/2605.06350)). ADR-0030 is already this; M5 tells it
  *how much* budget per step.
- **Reason — halt on convergence:** fixed-point/attractor halting = Ouro Q-exit + our `accel`
  criterion, now with a Kreiss-safe threshold (M4).

## The unification (the owned claim)
An indefinite-horizon **convergence engine at low cost** =
**Spiral** (cheap cascade, Act) + **EOQ-scheduled re-grounding** (per-fact clocks, Remember — the
cost lever) + **fixed-point/Kreiss halting** (Reason) + **supermartingale-confidence + lasing kill**
(Verify) + **water-filling budget** (allocation). The Σ₀ math supplies the convergence guarantee and
the bounded-cost guarantee the drift/snowball literature says is *missing*.

**The saturation escape (ties the whole program together).** Self-improvement loops saturate
because they feed on their own reflection. The only unbounded improvement term in M1 is the
**external-evidence** term — so the engine improves indefinitely **only** by verified grounding, not
introspection. This is the same verification-over-imitation thesis as the Spiral (coding) and v1.10
(honesty): *the verifier is the moat*. The convergence engine is that thesis run as a control loop.

## External validation (full-text verified 2026-07-22 — see [grounding ledger + patent landscape](2026-07-22-grounding-ledger-and-patent-landscape.md))
- **Fresh, tightest match — SEA: Self-Evolving Agents with Anytime-Valid Certificates**
  ([arXiv:2607.00871](https://arxiv.org/abs/2607.00871), 2026-07-01): a **frozen base LLM** + steering
  adapter (no weight fine-tuning) + **anytime-valid statistical gates** for verified self-improvement.
  This is the convergence-engine thesis, independently. **Adopt its anytime-valid certificate** as the
  statistical form of the M1/M6 stopping test — a certificate that stays valid under *indefinite /
  optional stopping*, which is exactly what an indefinite-horizon spiral requires.
- **Cross-domain prior art grounds the Σ₀ math** (16 patents, all FTO-clear): **Iterative Learning
  Control** (spectral-radius<1 contraction; laser-galvo US7345448B2, disk-drive US8094405B1, motor
  US6686716B1) is the 40-year-fielded control precedent for **M4** — each escalation must strictly
  reduce residual or halt. Statistical-stall halting (ECC decoders US6518892B2/US8301987B2) → M4's
  turn-cap replacement. Hierarchical-assay escalation (US6013436A) → the Act cascade contract.
  Surrogate-fitness re-fit against ground truth (US8131656B2) → **M2** cadence. **No patent gates an
  LLM with a ground-truth verifier** — the composition is the owned contribution.

## Honest gaps
- M1/M2/M5 have closed forms but only M4/ROA is machine-checked (#1991); M1/M2/M5/M6 need the
  longitudinal ledger tests their issues specify before we claim the guarantees.
- The economic partners (Shadow Price, UCCI) may *predate* and subsume parts of M5 — a novelty
  audit is owed before claiming priority (same discipline as the Σ₀ cert overlooked-novelty audit).
- "Indefinite" is aspirational until a real multi-day run exercises the drift canaries (M3) on the
  actual product — short-horizon eval "fails to surface latent degradation" ([2601.04170]).
