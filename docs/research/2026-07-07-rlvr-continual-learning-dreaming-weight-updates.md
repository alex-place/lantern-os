# Spending compute to update Σ₀'s base weights: RLVR + dreaming, gated by the stability certificate

- **Task:** research how to spend compute to update the base model weights for Σ₀ using RLVR (RL with verifiable rewards) for continual learning + a "dreaming" (offline replay) phase, gated by the Σ₀ stability/collapse certificate.
- **Date:** 2026-07-07
- **Engine:** `!research` — local arXiv corpus (F:, post-cutoff 2025-07→) via `scripts/arxiv_query.js` + web fan-out + one adversarial cross-check (grok-4 headless).
- **Overall confidence:** ~0.78. Legs 1–2 well-grounded in post-cutoff papers; Leg 3 (the load-bearing finding) triple-sourced; Leg 4 upgraded from directional to corpus-grounded this pass.

---

## 0. The constitutional tension (state it first)

The North Star forbids exactly this by default: *"Learning is retrieval + experience, NOT weight modification — never retrain"* ([CLAUDE.md](../../CLAUDE.md), session-grounding principle 5; [ADR-0010](../adr/0010-verify-gated-continual-learning-last-resort.md) Rule 0/Rule 3 make adapter-only the sole sanctioned weight path). But the operator's 2026-07-06 directive ([ADR-0024](../adr/0024-sigma0-frontier-training-program.md)) scopes frontier training *in*. The honest reconciliation: **a weight update is a rare, certified exception to the frozen-base default, never the default itself.** The frozen base + JSONL/CSF retrieval loop stays Rule 0; a weight update ships only when it beats retrieval on a frozen held-out suite. Everything below is engineered to preserve that.

## 1. Leg 1 — RLVR is the *right* update rule because it is unusually forgetting-robust

The strongest empirical argument for RLVR here is counterintuitive:

- **[MEASURED]** RL/RLVR is far more robust to catastrophic forgetting than SFT. Mechanism: on-policy data keeps updates in a low **reverse-KL** (mode-seeking) region near the base, so the policy "naturally biases toward solutions maintaining proximity to the original model," while SFT minimizes forward KL (mode-covering) and can drift arbitrarily far, erasing prior capability. Ablations show **explicit KL penalty is not what does it** — on-policy sampling implicitly produces low-KL solutions. Source: [Wolfe, "Continual Learning with RL for LLMs" (2026)](https://cameronrwolfe.substack.com/p/rl-continual-learning).
- **[MEASURED]** RLVR's own failure mode is *intra-task* forgetting: "previously solvable problems become unsolvable as training proceeds… policy updates concentrate probability mass on newly reinforced solutions." Source: [Learning to Solve, Forgetting to Retain: Correct-Set Turnover in RLVR, arXiv:2606.03087](https://arxiv.org/abs/2606.03087).

**Implication:** RLVR (on-policy, execution-graded GRPO-family) is the update engine — it structurally protects the base — but the quantity to gate on is **correct-set turnover**, a held-out exec metric, not a hidden-state property.

## 2. Leg 2 — "Dreaming" = generative replay + sleep-time consolidation (well-supported; maps to the loop without sprawl)

The North Star bans a *separate dream engine* but permits *dreaming as a reasoning/replay strategy*. The literature supports exactly that framing:

- **[MEASURED]** [Dream2Learn, arXiv:2603.01935](https://arxiv.org/abs/2603.01935) — a model "autonomously generates structured synthetic experiences from its own internal representations and uses them for self-improvement," to balance plasticity/stability and mitigate forgetting.
- **[MEASURED]** [Language Models Need Sleep, arXiv:2606.03979](https://arxiv.org/abs/2606.03979) + [Sleep-time Compute, arXiv:2504.13171](https://arxiv.org/abs/2504.13171) — move consolidation to an *offline* phase (replay accumulated context, update fast weights via a learned local rule), preserving wake-time latency. Directly relevant to an 8GB box that cannot train while serving.
- **[MEASURED]** [MSSR, arXiv:2603.09892](https://arxiv.org/abs/2603.09892) and [Replaying pre-training data improves fine-tuning, arXiv:2603.04964](https://arxiv.org/abs/2603.04964) — replaying generic/pre-training data during fine-tuning prevents (and can *reverse*) forgetting. Cheap, no RL required.

**Implication:** "dreaming" is concretely an offline phase that replays the **verified JSONL/CSF memory** you already have as the experience buffer, mixing generic data to anchor. Improves Remember→Reason; adds no new memory system.

## 3. Leg 3 — The stability cert cannot gate the failure mode you care about (critical finding)

This converges from three independent directions:

- **[repo doc]** The Σ₀ collapse certificate certifies **local hidden-state trajectory contraction** (`max Re λ(A) < 0` on the decode Jacobian) — the *local linear Jacobian, not a global guarantee* ([SIGMA0-COLLAPSE-CERTIFICATE.md](../SIGMA0-COLLAPSE-CERTIFICATE.md) §1). Its trigger is a **late detector: precision 1.0, snapshot recall ≈ 0.08** (§2, #1990). The repo already documents **instrument↔actuator decoupling** — the monitor watches abstract state the greedy decoder never feeds (#766).
- **[adversarial cross-check, grok-4 headless]** An independent skeptical pass landed unprompted on the same point: *"You certify the wrong dynamical system… Hidden-state stability cannot detect reward hacking or forgetting; those live in the reward boundary and held-out task distribution, not in whether `max Re λ(A)` looks tame. A 1.4B model can pass every spectral screen while becoming a reward parrot."*
- **[MEASURED]** Reward hacking is the dominant RLVR pathology (format hacks, memorized fixtures); [Rubrics as Rewards, arXiv:2507.17746](https://arxiv.org/abs/2507.17746) exists because binary verifiable rewards get gamed.

**Implication:** Keep the cert — it is a cheap, *no-op-cost* screen against representational **collapse/degeneration** during a bad update, and a real Verify-stage contribution. But the **load-bearing gate must be a frozen held-out execution suite** (does this checkpoint regress problems it used to pass, and did it cheat?). The cert gates *"did the model degenerate?"*; the exec holdout gates *"did it actually improve without cheating or forgetting?"* You need both; only the second catches reward hacking and correct-set turnover. (Suggestive bridge: [FuRA, arXiv:2605.22869](https://arxiv.org/abs/2605.22869) does spectral **preconditioning** so fine-tuning gradients don't perturb pretrained spectral structure — a training-time cousin of the cert that acts *before* the update rather than gating *after* it.)

## 4. Leg 4 — Small-scale RLVR feasibility (corpus-grounded this pass)

Naive GRPO at 1.4B/8GB is a trickle (rollout generation dominates cost). But the 2026 literature is almost entirely about making it cheap:

- **[MEASURED]** [Discounted Beta-Bernoulli Reward Estimation, arXiv:2603.18444](https://arxiv.org/abs/2603.18444) — fixes the high-variance point-estimate problem from *few rollouts per query*, i.e. exactly the small-budget regime.
- **[MEASURED]** [sGPO: Trading Inference FLOPs for Training Efficiency in RLVR, arXiv:2606.08854](https://arxiv.org/abs/2606.08854) and [DUET: token-budget allocation, arXiv:2605.08441](https://arxiv.org/abs/2605.08441) — allocate rollouts/length by per-query difficulty instead of a fixed budget.
- **[MEASURED]** [Train Less, Learn More: Adaptive Efficient Rollout, arXiv:2602.14338](https://arxiv.org/abs/2602.14338) — skip zero-advantage groups (all-same-outcome), the dominant wasted spend.
- **[MEASURED]** [How Much Online RL is Enough?, arXiv:2605.21266](https://arxiv.org/abs/2605.21266) — bounded online rollouts then offline DPO as a cheaper stand-in for continuous GRPO.
- **[MEASURED]** [Hybrid-LoRA, arXiv:2605.18822](https://arxiv.org/abs/2605.18822) answers the LoRA-vs-full question for RLVR post-training; [Memory-Efficient Policy Libraries with LoRA in RL, arXiv:2606.25700](https://arxiv.org/abs/2606.25700) confirms LoRA-in-RL memory savings. Full finetune + optimizer states won't fit 8GB; the in-repo #2178/adapter finding says the **adapter, not recurrent depth, carries capability**.
- **[MEASURED]** [RL via Self-Distillation, arXiv:2601.20802](https://arxiv.org/abs/2601.20802) — use rich textual feedback (runtime errors) instead of scalar outcome reward; ties directly to your exec-verify teacher (ADR-0015).

**Implication:** Do RLVR at small scale with (a) LoRA rank ≤16 on existing adapter modules, (b) sample-efficient reward estimation + adaptive rollout skipping, (c) execution as teacher-of-record. Realistic cadence: nightly GRPO over 16–32 short, execution-graded problems on cloud L4 — never on the 12GB local box ([local-pc-freezes-ram-exhaustion]).

## 5. Recommendation — minimum viable version (compute allocation, cheapest/safest first)

1. **Rule 0 stays:** frozen base + JSONL/CSF retrieval is the default; no weight update ships unless it beats retrieval on the holdout. (~0 GPU.)
2. **Verified distillation is the primary weight-update spend** (not raw RL yet): cloud teacher proposes, **execution is teacher-of-record**, train LoRA (rank ≤16) on passing traces only. This is ADR-0015 extended, not new.
3. **"Dreaming" = offline replay of the verified JSONL buffer** into that distillation set (Dream2Learn / sleep-time framing), mixed with generic data (arXiv:2603.04964) to anchor. Runs in the sleep phase; cloud L4.
4. **RLVR/GRPO last and small** — on-policy is what buys forgetting-robustness (Leg 1). Gate every candidate checkpoint on **BOTH**: (a) Σ₀ stability cert (cheap early-abort on degenerate hidden-state dynamics), **and** (b) a frozen held-out **exec suite with a hard no-regression bar** (the real gate — catches reward hacking + correct-set turnover). Don't enable the RL loop until the holdout is flat-or-up over a sustained window.

**One-line convergence:** RLVR is the right engine (protects the base by construction); dreaming is legitimate generative replay in the sleep phase; the stability cert is a *necessary-but-insufficient* screen — the update must be certified by downstream **verified error rates**, with the hidden-state cert as the cheap early-abort, never the sole authority.

## 6. Honest scope / what not to claim

- The 15×-latency and HumanEval-peak figures for Ouro-at-1.4B are directional (grok-cited / prior-session memory), **not measured this pass** — spike before committing GPU-months.
- No claim that the stability cert *prevents* reward hacking; the corpus + repo evidence says the opposite (§3).
- Full-text of the cited arXiv papers was not fetched (network egress); grounding is on abstracts/snippets + web summaries. Abstracts are citable anchors (arXiv ids); the deeper method details are HELD pending full-text.

## Sources
Local corpus (arXiv ids above) + web: [Wolfe RL-continual-learning](https://cameronrwolfe.substack.com/p/rl-continual-learning) · [Correct-Set Turnover 2606.03087](https://arxiv.org/abs/2606.03087) · [Sleep-time Compute 2504.13171](https://arxiv.org/abs/2504.13171) · repo [SIGMA0-COLLAPSE-CERTIFICATE.md](../SIGMA0-COLLAPSE-CERTIFICATE.md), [ADR-0010](../adr/0010-verify-gated-continual-learning-last-resort.md), [ADR-0015](../adr/0015-qwen-teacher-verified-distillation.md), [ADR-0024](../adr/0024-sigma0-frontier-training-program.md). Adversarial cross-check: grok-4 headless (`grok -p`), 2026-07-07.
