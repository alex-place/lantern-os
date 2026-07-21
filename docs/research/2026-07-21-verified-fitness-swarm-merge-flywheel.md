# Verified-fitness swarm-merge: a self-improving, cost-decreasing coding agent

**Date:** 2026-07-21 · **Status:** synthesis grounded in 2024–2025 primary literature; build spec + first step (#2729).
**Honest grade:** a *novel synthesis* of public components with a defensible wedge (objective judge in code +
owned verified-arena + tuning-free merge). Not a new theorem, no patent — an architecture edge and a data moat.

---

## The one-line eureka

Every self-improvement method on the frontier is bottlenecked by the same thing — **the judge** — and **code is
the one domain where the judge is free, objective, and un-gameable** (the exec-verify test). The verified cascade
already *produces* that judge. So the cost engine is secretly a **self-improvement** engine:

> **Cascade → Verified-Arena → Swarm-Merge → a cheaper, stronger cheap tier → repeat.**

Cost-per-solved-task falls monotonically; capability rises; both compound with owned verified data.

## The frontier this stands on (primary sources)

| component | source | load-bearing result |
|---|---|---|
| verified cascade cuts cost | FrugalGPT (Chen/Zaharia/Zou, 2305.05176); RouteLLM (Ong et al., Berkeley, 2406.18665); **cascade-routing** (Dekoninck/Baader/Vechev, **ETH, ICML 2025**) | up to **98%** cheaper matching GPT-4; RouteLLM **2×** + transfers across model swaps; cascade-routing **provably dominates** routing *and* cascading |
| cheap ensemble > frontier | Mixture-of-Agents (Wang et al., Together, 2406.04692) | **65.1%** vs GPT-4o **57.5%** (AlpacaEval 2.0) |
| **tuning-free merge, weak→strong** | **Model Swarms** (Feng et al., Google/UW, **ICML 2025**, 2410.11163) | PSO over **weight space** guided by a **utility function**; **+21%** over 12 baselines; **200 examples**; tuning-free; "weak-to-strong transition of experts" |
| merge beats bigger parents | Evolutionary Model Merge (Akiba et al., Sakana, **Nature MI 2025**, 2403.13187); FuseChat (Wan et al., 2408.07990) | merged small model "surpassing models with significantly more parameters"; FuseChat fuses **6 architectures → 1** |
| self-judging model → beats GPT-4 | **Self-Rewarding LMs** (Yuan et al., Meta, **ICML 2024**, 2401.10020) | 3 iters of Llama-2-70B beats GPT-4-0613, Claude 2, Gemini Pro |
| lossless decode speedup | EAGLE (2401.15077) / Medusa (2401.10774) | **2×–6.5×**, identical outputs |
| adjacent prior art (distinct) | A Self-Improving Coding Agent (Robeyns/Szummer, **ICLR-W 2025**, 2504.15228) | edits its own **scaffold** (non-gradient) — **not** weight-merging by verified fitness |

## The specific insight (why nobody's flywheel runs un-bottlenecked)

- **Self-Rewarding** uses an LLM-as-judge — subjective, gameable, capped by the model's own taste.
- **RLHF / LMArena** use human votes — slow, costly, subjective.
- **Model Swarms** *assumes you already have a utility function.*
- **RLVR** (o1 / DeepSeek-R1) *does* use verifiable rewards — but needs a **GPU training cluster**.

Two facts collapse into a wedge only a code-domain agent has:
1. **Code gives a free objective judge** — the exec-verify test is un-gameable ground truth (External Reality Rule,
   in the one domain it's cheap).
2. **Model-Swarms merging is tuning-free** — no gradients, ~200 examples, which the cascade emits as a byproduct.

→ Unisona can run the verified self-improvement loop RLVR needs a cluster for, **with no cluster** — fitness is
free (tests), merge is tuning-free (swarms). That asymmetry is what a small operator can exploit.

## The loop (ties every product lever)

1. **Cascade** — cheap-first, exec-verify gate, escalate on fail (proven live, PR #2800). Emits verified outcomes.
2. **Verified-Arena** — those outcomes `[task, tier, verified pass/fail, cost]` are an *objective* fitness signal
   (strictly better than Self-Rewarding's LLM-judge). This is the owned data.
3. **Swarm-Merge** — Model-Swarms weight search over a pool of coding experts/adapters, **utility = verified
   pass-rate**, → a merged cheap tier. Tuning-free (Model Swarms), beats bigger (Sakana), cross-arch (FuseChat).
4. **Cheaper Cascade** — better cheap tier → higher cheap-pass-rate → fewer escalations → lower cost → more
   verified data → better merge. Loop.

- **Agent better** → merged cheap tier compounds (+21% Model Swarms; Self-Rewarding beats GPT-4).
- **Compute gain** → escalations fall *over time* + smaller merged model + EAGLE decode. Monotone, not one-shot.
- **Compression edge** → merging **is** capability compression (Sakana small>big; FuseChat 6→1); arena stored CSF.

## The moat (defensible, honestly graded)

Algorithms are all public — no patent. The moat is three owned artifacts the papers can't hand a competitor:
1. the accumulated **verified-outcome arena** (your data);
2. the **objective judge itself** — you have it only because you chose *code* as the wedge; open-ended chat has no
   free objective judge, so a competitor's flywheel stays bottlenecked;
3. the **merged cheap tier**, evolved on your task distribution.

## Build spec (concrete, incremental)

**Phase 0 — the arena substrate (mostly done).** Cascade emits verified outcomes (PR #2800: the
`data/eval/cascade/*.jsonl` rows). Extend the logger to every production coding turn (#2798) so the arena accrues.

**Phase 1 — expert #1, and make it selectable (#2729).** Train the first own-data coding adapter (QLoRA on
Ouro-1.4B, `data/eval/distill.jsonl`, 2000 exec-verified records). *The real gap:* the trainer is
**selection-blind** — no val split / best-checkpoint selection, which violates the freshness law (Σ_G §1). Add:
100-record val split, `eval_steps=50`, `load_best_model_at_end`, cap 3 epochs (~375–400 steps), overfit tripwire
(abort if train loss < 0.2 before epoch 2). This yields expert #1 *and* its held-out fitness — the first arena point.

**Phase 2 — the swarm pool.** Gather ≥3 coding experts (expert #1 + open coder adapters/models, same base family).
Model-Swarms search (2410.11163 reference impl) with **utility = verified pass-rate on a held-out cascade-outcome
slice**. Output: a merged cheap tier. Tuning-free; runs on the L4 used for eval, no training cluster.

**Phase 3 — close the loop.** Swap the merged tier in as the cascade's cheap model behind `CODING_CASCADE`;
measure cheap-pass-rate lift and escalation-rate drop on the live harness (PR #2800 runner). Re-feed outcomes → Phase 2.

**Metric that matters:** cheap-pass-rate (↑) and escalation-rate (↓) over successive merges — the monotone
cost-down/capability-up curve. Report it per merge.

## Sellable pitch (why now)

*"A coding agent that gets cheaper **and** smarter every time you use it — it merges its own test-verified wins into
a stronger cheap model, with no training cluster."* Frontier quality, monotone-falling cost, a moat that compounds
per run. The papers all landed 2024–2025 and are reproducible; the wedge is exactly the coding-agent surface.

## Honest limits / falsification

- Model Swarms' +21% is on *its* tasks; the lift on **our** cascade fitness is the measurement (Phase 2/3), not an
  assumption.
- Tuning-free merge helps only if the pool has complementary strengths; a homogeneous pool won't improve — so the
  swarm must include genuinely diverse coders.
- The wedge is **code-shaped**: it degrades for tasks without a cheap objective test. Honest scope: start in code.
