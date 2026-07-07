# Σ_θ A/B/C Continual-Update Harness — Cloud L4 Spec

_Status: **Spec** (the gate + decision logic are implemented and self-tested; the training
arms run on cloud L4). Governs: [ADR-0025](adr/0025-rlvr-dreaming-continual-updates-double-gated.md).
Theory: [SIGMA0-COLLAPSE-CERTIFICATE.md](SIGMA0-COLLAPSE-CERTIFICATE.md) Part II (§8). Loop stage:
**Verify** (the update gate) + **Remember** (verified-replay buffer). Author: 2026-07-07._

## 0. The one question
**Does a weight update earn its keep over frozen-base + retrieval at 1.4B?** Everything here is
built to answer that cheaply and honestly, and to *stop* if the answer is no. This is the Phase-1
falsifiable experiment ADR-0025 calls for — the single move that converts the whole Σ_θ theory into
evidence. Nothing ships from it without operator approval.

**Constitutional framing (Rule 0 holds).** The North Star forbids weight modification as the default
(“Learning is retrieval + experience, NOT weight modification”). This harness does not change that:
frozen base + JSONL/CSF retrieval stays the overwhelming common case; a weight update is a **rare,
certified, double-gated exception** whose safe rate is bounded by fresh verified ground truth (the
§8.4 law, measured in `experiments/sigma_update_holdout_staleness.py`). If the experiment shows no
arm beats retrieval, the correct outcome is **do not update weights** — and that is a first-class
result of the decision tree, not a failure.

## 1. The three arms (equal compute, same frozen Ouro-1.4B base)
| Arm | Recipe | Isolates |
|---|---|---|
| **A** | verified distillation only — LoRA (rank ≤16) on *passing* traces | does distillation help at all? |
| **B** | A + verified generative replay (retention set + generic anchor data) | does replay prevent forgetting / aid new-task? |
| **C** | B + narrow RLVR/GRPO on execution-graded tasks | does on-policy RL add value *beyond* replay? |

All three start from the identical frozen checkpoint and are trained to **equal GPU-hours** (not equal
epochs) so the comparison is compute-fair. Base + trainer: `scripts/train-qlora-ouro.py`
(`--base ByteDance/Ouro-1.4B --lora-r 16`). Arm C's RL stage is the one **genuinely missing piece** —
see §6 (the GRPO trainer is not yet in-repo; it is the only new training code this program needs).

## 2. Data pipeline (verified-only; decontaminated; rotating holdouts)
**Sources (verified traces only):** `data/csf_memory/raw.jsonl`, `data/autowork-runs/*.jsonl` —
passing patches, successful tool trajectories, source-checked research, human-approved drafts.
**Guardrail (ADR-0025 #3):** NEVER train on the model’s *unverified* self-generated “thoughts” — an
example enters any arm’s data only if a compiler/test/source-check/human verified it. Internally
generated, unverified text is a model-collapse feeder and is excluded by construction.

**Decontamination:** run `scripts/decontaminate_training.py` against every eval set below before any
training — a HumanEval/MBPP/promotion item leaking into training data invalidates the whole run.

**Rotating holdout tiers (§8.4, MEASURED — fresh flow strictly dominates a fixed set, penalty worst
when small):**
```
exploration set        → tune / select freely (assume burned)
private retention set   → rare reads; the historic "mastered" suite (Gate cond 2)
fresh promotion set     → used ONCE for the release decision, then retired (Gate cond 1)
incoming verified tasks → continually replenish the promotion pool — THE FLOW; its sourcing
                          rate is the hard rate-limit on how often a weight update may ship
```
The measured law (`sigma_update_holdout_staleness.py`, 32 seeds): a fixed promotion set extracts up
to **22× less** true improvement than a fresh flow at small n, converging only at n ≥ ~2000. So the
promotion set must be **fresh and retired after one use**, not reused across candidates.

## 3. Evaluation battery → the 7 gate metrics
Each candidate is measured on (existing scripts in parens):
1. **fresh_pass1** — new execution-graded coding tasks, the used-once promotion set (`eval_humaneval_ouro.py` style on held-fresh tasks)
2. **retention_pass1** — the historic mastered suite (`eval_sigma0_adapter.py` / MBPP-retention split)
3. **proxy_reward** vs **world_eval** — the RL proxy reward vs an independent world eval (anti-Goodhart, cond 3)
4. **kl_from_prior**, **adapter_norm** — drift budget (cond 4)
5. **stability_ok** — Σ₀ Part-I collapse monitor on the decode Jacobian (cond 5; cheap early-abort)
6. **no_contamination**, **provenance_present** — data integrity (cond 6)
7. **rollback_available** — prior adapter still deployable (cond 7)
Plus tool-call correctness, source-grounded research accuracy, and latency/memory (reported, not gated).

## 4. Runbook — exact L4 stages (each shells to a tracked script)
> Training refuses to run off L4 (`KEYSTONE_L4=1` required; the local 8GB/12GB box freezes under LLM
> training — [local-pc-freezes-ram-exhaustion]). Sealed-eval + gate logic run anywhere.

```bash
# 0. SEAL evals first (≈15 GPU-h): build + decontaminate promotion/retention/world sets, hash-lock them
python scripts/decontaminate_training.py --against data/eval/promotion,data/eval/retention
# 1. baseline: frozen base + retrieval on the promotion set (the bar every arm must beat)
python scripts/eval_sigma0_adapter.py --base ByteDance/Ouro-1.4B --adapter "" --tasks <promotion>
# 2. ARM A — distillation only (≈ equal-compute slice of the 40 GPU-h distill budget)
KEYSTONE_L4=1 python scripts/train-qlora-ouro.py --base ByteDance/Ouro-1.4B --data <verified_distill> --lora-r 16 --out A/
# 3. ARM B — + verified replay + generic anchor (25 GPU-h replay-ablation budget)
KEYSTONE_L4=1 python scripts/train-qlora-ouro.py --base ByteDance/Ouro-1.4B --data <distill+replay+anchor> --lora-r 16 --out B/
# 4. ARM C — B recipe + narrow RLVR/GRPO (15 GPU-h; needs the GRPO trainer, §6)
KEYSTONE_L4=1 python scripts/rlvr_grpo_ouro.py --warm-start B/ --tasks <exec_graded> --out C/     # TODO trainer
# 5. EVAL all three + baseline → the 7 metrics, then gate + decide (NO GPU; runs in CI too)
python experiments/sigma_theta_abc/harness.py --run   # applies sigma_theta_gate + abc_decision
# 6. RED-TEAM (5 GPU-h): plant a reward-hack, a retention regression, a format exploit; confirm the
#    gate rejects each where a Part-I-only gate would accept (this is the §8.6 legs-1–3 teeth).
```
**Compute budget (100 GPU-h; ADR-0025 — an operating recommendation, not a literature result):**
15h sealed evals · 40h distillation · 25h replay ablations · 15h RLVR pilot · 5h red-team+rollback.

## 5. Gate + decision (IMPLEMENTED, self-tested, no GPU)
`experiments/sigma_theta_abc/harness.py` implements both, and `--self-test` proves them in CI:
- **`sigma_theta_gate(metrics)`** — the 7-condition release gate (§8.1.2). Load-bearing = exec-holdout
  conds 1–3 (fresh gain, retention, anti-Goodhart); cond 5 (Σ₀ stability) is a cheap early-abort,
  never the authority. Self-test proves a reward-hack (proxy↑, world↓) is rejected by cond 3, a
  forgetting regression by cond 2, instability by cond 5, over-budget drift by cond 4.
- **`abc_decision(results)`** — the decision tree: **C wins** only if it clears its gate AND beats B
  on fresh tasks without worse retention/reward-divergence/instability → ship C, enable RL; **B wins**
  → dreaming = replay+verification, RLVR waits; **A wins** → replay recipe needs work; **none beat
  retrieval** → stop updating weights, improve retrieval/tools (Rule 0 holds).

## 6. What is real now vs the remaining gap
- **REAL now (no GPU):** the Σ_θ gate, the A/B/C decision tree, and their self-test (8/8 green); the
  data/holdout discipline; the measured §8.4 fresh-flow law that sets the promotion-set policy.
- **NEEDS cloud L4 (the empirical gap):** the three training runs themselves, and one piece of **new**
  training code — a narrow **GRPO/RLVR trainer** for Ouro (`scripts/rlvr_grpo_ouro.py`, TODO). Arms A/B
  reuse `train-qlora-ouro.py` unchanged; only arm C needs the RL loop. Per ADR-0025, RL stays disabled
  until Gate A’s holdout is flat-or-up over a sustained window, so A/B can run first and C is optional.

## 7. Evidence discipline
Every result carries a class (PROVEN/MEASURED/HEURISTIC) and an artifact pointer; the promotion set is
hash-locked and retired after one use; the run is `--self-test`-gated before it may spend a GPU-hour.
No arm ships without explicit operator approval. If the honest outcome is “retrieval wins,” that is the
result — the harness is designed to be able to tell you *not* to update weights.
