---
author: Keystone (Claude lane)
created: 2026-06-29
status: living
---

# Σ₀ Worklist — Council, Evals, and the Coder Swap

Consolidated backlog from the 2026-06-29 design session. Every item names the loop stage it
strengthens (Observe / Remember / Reason / Act / Verify / Converge) — anything that names no
stage is rejected as sprawl. Done items link the artifact; next items link the blocker.

## The thesis (why these, in this order)

A council is a **route + verify + ground** machine, not a capability amplifier — capability is
best-member-bounded. So gains come from: (1) the model in the chair (routing/swap), (2) hard
external checks (execution-verify, RAG), (3) measurement turning projections into numbers.
Distillation is the **deferred last resort** ([ADR-0010](adr/0010-verify-gated-continual-learning-last-resort.md)),
behind the frozen-base levers.

## Done (this session)

| Item | Stage | Artifact |
|---|---|---|
| Council unified into one Δ + 3-way answerability gate (grounded / seam-open / pin) | Verify→Converge | [`lib/council-review.js`](../apps/lantern-garage/lib/council-review.js) + test 7/7 |
| Operator-escalation backtest instrument (honest n=0, ready) | Converge | [`experiments/council_escalation_backtest.py`](../experiments/council_escalation_backtest.py) |
| LoopCoder-v2 4-bit feasibility probe (FIT/RUNS/SPEED verdict) | Reason | [`experiments/loopcoder_v2_4bit_probe.py`](../experiments/loopcoder_v2_4bit_probe.py) |
| SWE-bench single-shot chat harness + `--grade` (Docker/Modal) | Verify | [`scripts/eval_swebench_chat.py`](../scripts/eval_swebench_chat.py) |
| Distillation = deferred last resort (Proposed) | Converge | [ADR-0010](adr/0010-verify-gated-continual-learning-last-resort.md) |

## Next (prioritized by leverage × unblocking)

1. **Swap Qwen2.5-Coder in** — `LOCAL_CAPABILITY_FIRST=1`, verify it's actually served (`/api/tags`). 32k context unblocks a fair SWE single-shot run (Ouro's 8k overflows the ~13k bm25 prompt). *Reason. Blocker: ollama has qwen pulled.*
2. **First real SWE number** — run `eval_swebench_chat.py --dataset princeton-nlp/SWE-bench_Lite_bm25_13K --limit 10 --grade` on the box. Uncontaminated, execution-graded. *Verify. Blocker: server + Qwen + Docker.*
3. **Run the LoopCoder-v2 probe** → BUILD the 4-bit serve-proxy or stay on Qwen. *Reason. Blocker: 3070 + ~14GB download.*
4. **Active System Integration** — wire execution (run tests in a sandbox) into the autowork loop on top of `councilReview`. The keystone capability: it's the #1 grounding lever AND the precondition that makes long-horizon self-correction real (without an external check, self-correction is the dead 42-state). *Act→Verify. Build.*
5. **Wire `councilReview` into the live decision path** + an outcome labeller (decisionId → commit/PR → reverted?), so the escalation backtest accrues real data. *Verify→Converge. Build + real-UI verify.*
6. **RAG + citation grounding** on the groundedness face — the ~40% hallucination lever. *Remember→Verify. Build.*
7. **Agentic SWE driver** — map each SWE instance → an autowork task that explores the cloned repo (higher ceiling than single-shot; what LoopCoder's 64.4 used). *Act. Build.*
8. **Council design ADR** (ADR-0011, Proposed) — record one-council-two-faces-answerability-gate. *Governance. Doc.*
9. **Land the session's work** on a `claude/sigma0-council` lane + PR. *Ops.*

## Honest caps (do not relitigate)

- Capability evals (HumanEval/SWE/GPQA) are **best-member-bounded** — the council doesn't manufacture them; routing + execution-verify do.
- "99%" that's real = verified pass-rate / grounding, NOT a saturated-benchmark score. The benchmark is never the optimization target (ADR-0010).
- LoopCoder-v2's 64.4 SWE is **unverified**; every prediction in this session is a hypothesis until the harness on line 2 returns a number.
