# Î£â‚€ Reading Pack â€” verified sources for the model-design + frontier-training briefs

**Date:** 2026-07-06 Â· **Rule:** every arXiv ID below was verified against arXiv (or against a
primary source pasted in-session) on 2026-07-05/06 before inclusion. **Never cite an ID you have
not opened** â€” an earlier draft pipeline produced three wrong IDs and a literal `2305.XXXX`
placeholder across two lists; all corrected here. Companion briefs:
[SIGMA0-MODEL-DESIGN-BRIEF.md](SIGMA0-MODEL-DESIGN-BRIEF.md) (serving) Â·
[SIGMA0-FRONTIER-TRAIN-BRIEF.md](SIGMA0-FRONTIER-TRAIN-BRIEF.md) (training, ADR-0024).

## Architecture â€” recurrent depth Ã— MoE (frontier brief D2/D3)

| ID | Paper | Use |
|---|---|---|
| [2405.16039](https://arxiv.org/abs/2405.16039) | **MoEUT** â€” MoE Universal Transformers | Primary recipe: G=2 ABAB grouping + peri-layernorm ported **as a package**; fine-grained experts; the SUT/ACT ablation (learned halting hurt) |
| [1807.03819](https://arxiv.org/abs/1807.03819) | Universal Transformers (Dehghani et al.) | The foundational recurrent-depth prior |
| [2310.10837](https://arxiv.org/abs/2310.10837) | Ïƒ-MoE (Approximating Two-Layer FFNs) | The FFN-MoE mechanism inside MoEUT |
| [2312.07987](https://arxiv.org/abs/2312.07987) | SwitchHead | The attention-MoE mechanism inside MoEUT |
| [2202.09368](https://arxiv.org/abs/2202.09368) | Expert Choice Routing | The lower-discontinuity router comparator (experts pick tokens; balance by design) â€” certificate-relevant |
| [2402.07871](https://arxiv.org/abs/2402.07871) | Fine-Grained MoE Scaling Laws | External support for many-small-experts (d_expertâ‰ˆ128) |
| [2101.03961](https://arxiv.org/abs/2101.03961) | Switch Transformers | Large-scale MoE baseline lessons |
| [2510.25741](https://arxiv.org/abs/2510.25741) | **Ouro** â€” Scaling Latent Reasoning via Looped LMs | The served base; 7.7T-token existence proof for recurrent depth |
| [2605.26733](https://arxiv.org/abs/2605.26733) | **STARS** | Jacobian spectral-radius regularization for looped LMs â€” training-time depth-stability, and the **novelty boundary** (do not claim generic Jacobian regularization of loops as ours) |
| [1603.08983](https://arxiv.org/abs/1603.08983) | Adaptive Computation Time (Graves) | The learned-halting prior our policy-depth stance argues against (with MoEUT's ablation + our Q-exit nulls) |
| [2604.11791](https://arxiv.org/pdf/2604.11791) / [2604.07822](https://arxiv.org/html/2604.07822v1) / [2507.02199](https://arxiv.org/pdf/2507.02199) / [2604.21999](https://arxiv.org/pdf/2604.21999) | Mechanistic analyses of looped/depth-recurrent LMs | What the loop computes; depth-state trade-offs |

## Honesty objective & data (both briefs D2â€“D5)

| ID | Paper | Use |
|---|---|---|
| [2509.04664](https://arxiv.org/abs/2509.04664) | **Why Language Models Hallucinate** (Kalai/Nachum/Vempala/Zhang) | The theoretical backbone: 0-1-scored evals reward guessing; incumbents benchmark-locked â€” the frontier thesis |
| [2509.25760](https://arxiv.org/pdf/2509.25760) | **TruthRL** | Ternary reward (+1/0/âˆ’1) at RL scale â€” our strictly-proper eval objective as training |
| [2505.13988](https://arxiv.org/pdf/2505.13988) | Hallucination Tax of RFT | RL fine-tuning erodes abstention â€” corroborates our imbalance-collapse finding |
| [2503.02623](https://arxiv.org/html/2503.02623) | Rewarding Doubt | Proper-scoring-ruleâ€“asâ€“reward option |
| [2604.03904](https://arxiv.org/pdf/2604.03904) | I-CALM | Confidence-aware abstention incentives |
| [2510.24020](https://arxiv.org/pdf/2510.24020) | Fine-Grained Semantic Confidence Reward | Claim-level abstention shaping |
| [2403.18349](https://arxiv.org/pdf/2403.18349) | Refuse Unknown via RL from Knowledge Feedback | Knowledge-boundary-aware negatives |
| [2311.09677](https://arxiv.org/abs/2311.09677) | R-Tuning | The original teach-"I don't know" recipe |
| [2604.14324](https://arxiv.org/pdf/2604.14324) | Purging the Gray Zone | Latent knowledge-boundary sharpening |
| [2511.12991](https://arxiv.org/pdf/2511.12991) | Fine-Tuned LLMs Know They Don't Know | The knowledge-vs-calibration (expression) split â€” serving brief D1's discriminator |

## Gating & grounding (serving brief D4â€“D5; measured on our harness)

[2305.06983](https://arxiv.org/abs/2305.06983) **FLARE** (the only signal with a measured positive routing edge â€” #2047/#2059) Â·
[2604.04743](https://arxiv.org/html/2604.04743) Hallucination Basins Â·
[2604.15400](https://arxiv.org/pdf/2604.15400) Trajectory Commitment Â·
[2604.25931](https://arxiv.org/pdf/2604.25931) Anchored Confabulation (partial anchors amplify) Â·
[2605.02236](https://arxiv.org/pdf/2605.02236) Perturbation dose-response in recursive loops Â·
[2602.01637](https://arxiv.org/pdf/2602.01637) Chance-constrained inference (conformal guarantees) Â·
[2604.23235](https://arxiv.org/pdf/2604.23235) Per-token commitment timing (early > late, measured).

## Stability math for routed loops (certificate Â§1.2.2; frontier brief D6)

| ID | Paper | Use |
|---|---|---|
| [2405.03560](https://arxiv.org/pdf/2405.03560) | Converse Lyapunov, average dwell-time | THE framework for MoE-as-switched-system |
| [2303.17858](https://arxiv.org/pdf/2303.17858) | LP dwell-time bounds via multiple Lyapunov fns | Machine-checkable, #1991-style |
| [2008.06546](https://arxiv.org/pdf/2008.06546) | Learning Lyapunov fns for piecewise-affine systems | Synthesis route for routed models |
| [2307.13543](https://arxiv.org/pdf/2307.13543) | Multiple Lyapunov + symbolic dynamics | Mode-sequence-aware stability |
| [2605.02526](https://arxiv.org/abs/2605.02526) | **Set-based neural barrier certificates** (loss=0 âŸ¹ formally valid) | The credible formal-methods upgrade path for the grounding-deadline note |
| [2309.06090](https://arxiv.org/pdf/2309.06090) | Certificate-synthesis framework | Tooling landscape |
| [2511.06341](https://arxiv.org/pdf/2511.06341) | Scalable neural-CBF verification | Bound propagation at hidden-state scale |
| [2601.20324](https://arxiv.org/pdf/2601.20324) | Reach-while-avoid certificates | The Î£â‚€â»Â¹ escape-shape |

## Eval protocol (serving brief D7) â€” external, OSS, never trained on

[2506.09038](https://arxiv.org/pdf/2506.09038) **AbstentionBench** (facebookresearch; abstention precision/recall/F1 â€” closest external mark to our golden/confab/over-abstain triple) Â·
[2509.07968](https://arxiv.org/abs/2509.07968) SimpleQA-Verified (DeepMind; Attempted/Acc|Attempted/F1 â€” the calibrated-hedger profile) Â·
HaluEval (RUCAIBox; local subset in-repo, in active use) Â· TruthfulQA (MC, judge-free) â€” *dataset IDs for the last two not re-verified this pass; datasets verified by use/registry.*

## Red-team â€” Â§7.2's trained gamer (both briefs D8)

[2412.14093](https://arxiv.org/html/2412.14093v2) **Alignment Faking** (the measured watched-vs-unwatched compliance gap) Â·
[2510.20487](https://arxiv.org/pdf/2510.20487) Steering evaluation-aware LMs Â·
[2509.18058](https://arxiv.org/html/2509.18058v1) Strategic dishonesty undermines safety evals Â·
[2604.20995](https://arxiv.org/pdf/2604.20995) Value-conflict alignment-faking diagnostics Â·
[2405.05466](https://arxiv.org/pdf/2405.05466) Poser (unmasking fakers via internals) Â·
[2605.28591](https://arxiv.org/html/2605.28591v1) Models that know how evals are designed.

## Corrections ledger (why this pack exists)

Wrong IDs seen in draft lists this cycle, all corrected above: UT `1707.01488`â†’**1807.03819**;
Ïƒ-MoE `2305.19099`â†’**2310.10837**; SwitchHead `2305.16355`â†’**2312.07987**; plus one literal
`2305.XXXX` placeholder (peri-layernorm is MoEUT Â§2.4 itself, not an external paper). A reading
list about grounding carried a 43% bad-citation rate until anchored â€” the discipline is the point.
