# V1 training-set review — TACO, verifiable sets, convergence data, and merged models

**Date:** 2026-07-22 · **Purpose:** decide what the V1 *honest teacher* trains on, before spending
GPU. Grounded in a fresh search pass + what is already cached on this box. Feeds
[AGI-V1.10-WHITE-BOX-HONESTY-DESIGN.md §6 Phase V1](../AGI-V1.10-WHITE-BOX-HONESTY-DESIGN.md).

## The V1 goal (keep it honest)
V1 makes a 7B open model *calibrated*: **assert when it knows, abstain when it doesn't** — measured
as confabulation-on-negatives and over-abstention-on-positives (separately) on the now-powered eval
(162 negatives). It is **not** a capability tune. The literature gives one governing caution:

> **Pure abstention-SFT over-abstains.** Cheng et al. / Brahman et al. (in the abstention survey
> [2407.18418](https://arxiv.org/html/2407.18418v3)) find SFT-on-"I don't know" makes models
> refuse *too much*. The fix is **knowledge-boundary calibration** (Gekhman
> [2405.05904], already cited in [SIGMA0-OURO-CODER §4](../SIGMA0-OURO-CODER.md)): relabel as "I
> don't know" **only what THIS model actually gets wrong**, not generically. Honesty data must be
> model-specific, produced against a verifier — not borrowed wholesale.

That single constraint drives every choice below.

## Sets reviewed (cached on this box unless noted)

| Set | Cached | Role for V1 | Verdict |
|---|---|---|---|
| **tulu-3-sft-mixture** (allenai) | ✅ | the **≥60% general anchor** (survey G3) — prevents the instruct-damage that gave VTD run-1 its −6 | **USE** — anchor mix, sampled |
| **TACO** (BAAI + likaixin/TACO-verified) + `data/eval/taco-easy.jsonl` (1,581) | ✅ | verifiable code problems → the **knowledge-boundary probe**: the exec-verifier says solvable-or-not, which defines what the model must abstain on (Abstain-R1 recipe, [2604.17073](https://arxiv.org/abs/2604.17073)). Apache-2.0 = commercial-safe | **USE (as boundary source, V1→V2)** |
| **gsm8k** (openai) | ✅ | verifiable math → same boundary signal, cheaper/shorter than TACO; good for a fast V1 boundary slice | **USE (V1 boundary slice)** |
| **our convergence records** (220) + mined corpus (1,842) | on disk | the **owned honesty core** — claim/verified/refuted/confidence, already model-relative. Small but exactly the right shape | **USE (honesty core)** |
| our **VTD verified traces** (204, `data/eval/spiral/vtd-corpus-all.jsonl`) | on disk | verified "answerable + correct" pairs already exec-gated — the *assert-when-known* half, free | **USE (assert half)** |
| SWE-HERO / KodCode / SWE-Gym / SWE-rebench (borrow table) | no | larger verifiable pools; **candidates**, not reproduced; KodCode is CC-BY-NC (research-only, taints commercial weights) | **DEFER** to V2 scale-up; KodCode research-only |
| PRIME-RL/Eurus-2-RL, OpenCodeInstruct, livecodebench | ✅ | RL-data / coding-instruct — for **V2 RLVR**, not the V1 SFT teacher | **DEFER to V2** |

## Merged models — reviewed, and mostly declined for now
Techniques: **Task Arithmetic** (average deltas), **TIES** (keep top-magnitude, sign-agree),
**DARE** (drop 90–99% of deltas, rescale), **SLERP** (spherical interpolation) — surveys
[2511.21437](https://arxiv.org/html/2511.21437v1) · [NVIDIA](https://developer.nvidia.com/blog/an-introduction-to-model-merging-for-llms/) ·
DARE [2311.03099](https://arxiv.org/pdf/2311.03099).

- **Measured reality:** merging gains are **modest — generally <1% averaged over tasks**
  ([2511.21437]). It is a *consolidation convenience*, not a capability driver.
- **Contrast with distillation:** the frontier assembly step is **on-policy distillation**
  (DeepSeek-V4 expert→consolidate, Qwen3 strong-to-weak; survey G1) — that is where real gains are,
  and it is the transport we already approved for the student tier.
- **Where merging *does* earn a place for us:** a cheap **DARE-TIES merge of a small honesty LoRA
  into the base** as an ablation control — it tests whether honesty can be added *without* damaging
  general ability (the VTD-run-1 failure mode) at near-zero cost, before committing to a full tune.
  **Decision:** keep merging as a **V1 ablation/sanity control only**, not the main path.

## V1 data recipe (the decision)
Assemble the V1 SFT set — **disjoint from the honesty eval** (5-gram decontam), anchored, both-class:

1. **Anchor (~60%)** — tulu-3-sft-mixture sample. Keeps it a working assistant (G3).
2. **Honesty core (~20%)** — convergence records + mined corpus, reformatted as
   assert/abstain/deny turns with confidence. Owned, model-relative.
3. **Boundary slice (~20%)** — run the base 7B over a gsm8k+TACO slice through the exec-verifier;
   **Gekhman-relabel**: correct→keep the verified answer (assert), wrong→"I don't know" (abstain).
   This is the piece that makes abstention *calibrated to this model*, not generic.

Then: QLoRA SFT (bf16, r16, anchored) → DPO on honesty preference pairs → evaluate on the powered
eval with **both arms** (gated + gates-off). RLVR/Abstain-R1 with the dual verifier is **V2**.

## Open items / honest gaps
- Boundary slice needs a base-model inference pass over gsm8k/TACO (compute; one job at a time).
- KodCode is CC-BY-NC → only for research weights, never commercial-lineage (founder licensing policy).
- Session-mined honesty negatives (Vertex) still pending — would enrich the honesty core.
- DPO drops OOD in some reports ([2407.18418]); CPO/ORPO are calibration-friendlier fallbacks if DPO regresses the eval.
