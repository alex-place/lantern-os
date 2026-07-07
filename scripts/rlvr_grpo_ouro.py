"""Arm-C RLVR trainer — GRPO on Ouro-1.4B with execution-verified rewards (ADR-0025 / Σ_θ §8).

The one genuinely-new piece of training code the A/B/C harness (experiments/sigma_theta_abc/
harness.py) needs: arms A/B reuse train-qlora-ouro.py unchanged; arm C = warm-start from B's
adapter, then a *narrow* on-policy GRPO pass on execution-graded coding tasks.

WHY GRPO + RLVR (not more SFT): on-policy sampling keeps updates in a low reverse-KL region near
the base, which is what makes RL far more forgetting-robust than SFT (ADR-0025 leg 1, MEASURED in
the corpus). The reward is VERIFIABLE — code is run against tests, reward ∈ {0,1} — so there is no
learned reward model to hack. GRPO needs no value critic: advantage is group-relative (a candidate's
reward minus its sibling group's mean). Its known pathology — correct-set turnover (arXiv:2606.03087):
previously-solved problems regress as mass concentrates on new solutions — is NOT caught by the loss;
it is caught by Gate A (the exec holdout in the harness). RL stays OFF until Gate A is flat-or-up.

DESIGN (matches scripts/train-qlora-ouro.py conventions: peft + transformers directly, NO trl —
trl's GRPOTrainer fights Ouro's custom transformers-4.57 loop code):
  per step: sample G completions/prompt (temp>0) → EXEC-grade each → group-relative advantage →
            skip zero-advantage groups (adaptive rollout, arXiv:2602.14338 — all-pass/all-fail groups
            carry no gradient and waste a forward pass) → GRPO policy-gradient loss on LoRA params
            with a KL trust region to the frozen base (drift budget, feeds Σ_θ gate cond 4).
  Ouro is a LoopLM: generation applies the tied weights T times/token; we backprop through the LoRA
  deltas only, exactly as train-qlora-ouro.py does (Hybrid-LoRA for RLVR, arXiv:2605.18822).

WHAT IS REAL HERE (no GPU, CI-tested): the GRPO advantage math, the adaptive-rollout skip, the exec
reward wiring, the KL-penalty term, config, and --self-test. The generation + optimizer loop is
L4-ONLY (KEYSTONE_L4=1) — the local box freezes under LLM training [local-pc-freezes-ram-exhaustion].

    # no-GPU: verify the GRPO math + rollout logic (CI)
    python scripts/rlvr_grpo_ouro.py --self-test
    # cloud L4: the narrow RLVR pass for arm C
    KEYSTONE_L4=1 .venv-train/Scripts/python scripts/rlvr_grpo_ouro.py --run \
        --warm-start B/ --tasks data/eval/rlvr-train.jsonl --out C/ --group 8 --steps 300
"""
from __future__ import annotations
import argparse, math, os, sys
from dataclasses import dataclass

if os.name == "nt":
    os.environ.setdefault("HF_HOME", "D:/hf-cache")

# ───────────────────────────── config ─────────────────────────────
@dataclass
class GRPOConfig:
    group: int = 8            # G completions sampled per prompt (the "group")
    steps: int = 300          # optimizer steps
    lr: float = 1e-6          # RL LR is much lower than SFT's 2e-4
    kl_coef: float = 0.04     # KL trust-region penalty toward the frozen base (drift budget)
    kl_max: float = 0.15      # hard stop: abort the step if batch KL exceeds this (Σ_θ gate cond 4)
    temperature: float = 1.0  # sampling temp (>0 so the group has variance)
    adv_eps: float = 1e-4     # std floor for advantage normalization
    max_new: int = 512
    lora_r: int = 16          # warm-started from arm B; rank kept identical

# ───────────────────────────── GRPO core (REAL, testable) ─────────────────────────────
def group_relative_advantage(rewards, eps=1e-4):
    """GRPO advantage: A_i = (r_i - mean(group)) / (std(group)+eps). No value critic.
    Returns a list aligned to `rewards`. An all-equal group → all zeros (no learning signal)."""
    n = len(rewards)
    if n == 0:
        return []
    mean = sum(rewards) / n
    var = sum((r - mean) ** 2 for r in rewards) / n
    std = math.sqrt(var)
    return [(r - mean) / (std + eps) for r in rewards]

def should_skip_group(rewards, tol=1e-9):
    """Adaptive rollout (arXiv:2602.14338): a group whose rewards are all identical (all pass or all
    fail) yields zero advantage everywhere → zero gradient. Skip it: don't spend the backward pass."""
    if not rewards:
        return True
    return (max(rewards) - min(rewards)) <= tol

def grpo_step_loss(logps, advantages, ref_logps, kl_coef):
    """Per-group scalar loss (to MINIMIZE), given per-completion sequence log-probs under the policy
    (`logps`), their advantages, and their log-probs under the frozen reference (`ref_logps`).
    Policy-gradient surrogate: -A * logπ  (upweight high-advantage completions), plus a KL penalty
    kl_coef * KL(policy‖ref) estimated per-sample as (logp - ref_logp). Pure function — the real
    trainer supplies logps from the model; here it is unit-testable with synthetic numbers."""
    n = len(logps)
    if n == 0:
        return 0.0, 0.0
    pg = -sum(a * lp for a, lp in zip(advantages, logps)) / n
    kl = sum(lp - rlp for lp, rlp in zip(logps, ref_logps)) / n   # sample estimate of KL(policy‖ref)
    return pg + kl_coef * kl, kl

# ───────────────────────────── execution reward (REAL wiring) ─────────────────────────────
def exec_reward(completion, prompt, entry_point, test, timeout=10.0):
    """Verifiable reward: 1.0 iff the generated code passes the task's tests, else 0.0. Reuses the
    canonical grader (make_candidate/run_test) so RLVR reward == the eval metric — no separate,
    hackable reward model. Import is lazy so --self-test needs no deps."""
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
    from eval_humaneval_ouro import make_candidate, run_test
    cand = make_candidate(completion, entry_point, prompt)
    ok, _ = run_test(cand, test, entry_point, timeout=timeout)
    return 1.0 if ok else 0.0

# ───────────────────────────── L4 training loop (stub — spec only) ─────────────────────────────
def _require_l4():
    if os.environ.get("KEYSTONE_L4") != "1":
        sys.exit("REFUSING to train off cloud L4 (KEYSTONE_L4!=1). GRPO generation + backprop on "
                 "Ouro-1.4B exceeds the local box and it freezes under LLM training "
                 "[local-pc-freezes-ram-exhaustion]. Run on L4. Use --self-test locally.")

def run(cfg: GRPOConfig, args):
    """Full GRPO pass — L4 only. The recipe (deterministic; the model calls are the GPU part):
      0. load Ouro-1.4B + peft LoRA warm-started from arm B's adapter (train-qlora-ouro.py conventions);
         keep a frozen reference copy of the base for the KL term.
      1. for each step: draw a prompt batch from --tasks (exec-graded, DECONTAMINATED vs all evals);
      2. sample cfg.group completions/prompt at cfg.temperature (model.generate);
      3. exec_reward() each; form groups; drop zero-advantage groups via should_skip_group();
      4. group_relative_advantage() → grpo_step_loss() with the frozen-ref KL term;
      5. if batch KL > cfg.kl_max: skip the update (trust-region guard, Σ_θ cond 4);
      6. optimizer.step() on LoRA params only; every N steps eval Gate A (exec holdout) — if it
         regresses (correct-set turnover), STOP and roll back. RL runs only while Gate A is flat-or-up.
      7. save candidate adapter to --out for the harness to Σ_θ-gate.
    The per-call model/optimizer wiring lives on the L4 host; this scaffold owns the math + policy."""
    _require_l4()
    raise SystemExit("GRPO generation/optimizer loop is L4-host wiring — the deterministic recipe is "
                     "the docstring above + docs/SIGMA-THETA-ABC-HARNESS-SPEC.md §6. Steps 3-5 (the "
                     "GRPO math) are the tested functions in this module; wire model.generate + the "
                     "peft optimizer around them on L4.")

# ───────────────────────────── self-test (no GPU, CI) ─────────────────────────────
def selftest() -> int:
    fails = 0
    def check(name, cond):
        nonlocal fails
        print(f"[selftest] {'PASS' if cond else 'FAIL'}  {name}")
        fails += 0 if cond else 1

    # all-pass and all-fail groups carry no signal → skipped, advantages all zero
    check("all-pass group skipped", should_skip_group([1.0, 1.0, 1.0]))
    check("all-fail group skipped", should_skip_group([0.0, 0.0, 0.0]))
    check("mixed group kept", not should_skip_group([1.0, 0.0, 1.0]))
    check("all-equal advantages are zero", all(abs(a) < 1e-9 for a in group_relative_advantage([1.0, 1.0, 1.0])))

    # mixed group: passing completions get POSITIVE advantage, failing get NEGATIVE
    adv = group_relative_advantage([1.0, 0.0, 0.0, 0.0])
    check("passing completion has +advantage", adv[0] > 0)
    check("failing completions have -advantage", all(a < 0 for a in adv[1:]))
    check("advantages are mean-zero", abs(sum(adv)) < 1e-9)

    # GRPO loss upweights the high-advantage completion: increasing its logp must LOWER the loss
    logps_lo = [-2.0, -2.0, -2.0, -2.0]
    logps_hi = [-1.0, -2.0, -2.0, -2.0]   # policy assigns MORE prob to the passing (adv>0) one
    ref = [-2.0, -2.0, -2.0, -2.0]
    loss_lo, _ = grpo_step_loss(logps_lo, adv, ref, kl_coef=0.0)
    loss_hi, _ = grpo_step_loss(logps_hi, adv, ref, kl_coef=0.0)
    check("raising logp of the passing completion lowers the loss", loss_hi < loss_lo)

    # KL penalty: drifting from the reference raises the loss
    drift = [-0.5, -0.5, -0.5, -0.5]      # policy far from ref (-2.0) → positive KL
    l_nokl, _ = grpo_step_loss(drift, adv, ref, kl_coef=0.0)
    l_kl, kl = grpo_step_loss(drift, adv, ref, kl_coef=0.5)
    check("KL term penalizes drift from base", (l_kl > l_nokl) and kl > 0)

    print(f"\n[selftest] {'ALL PASSED' if not fails else str(fails)+' FAILED'}")
    return 1 if fails else 0

def main():
    ap = argparse.ArgumentParser(description="Arm-C GRPO/RLVR trainer for Ouro-1.4B (ADR-0025)")
    ap.add_argument("--self-test", action="store_true", help="verify GRPO math + rollout logic, no GPU (CI)")
    ap.add_argument("--run", action="store_true", help="full GRPO pass (cloud L4 only)")
    ap.add_argument("--warm-start", default=None, help="arm B adapter dir to init from")
    ap.add_argument("--tasks", default="data/eval/rlvr-train.jsonl", help="exec-graded train tasks (decontaminated)")
    ap.add_argument("--out", default=None, help="output adapter dir (arm C)")
    ap.add_argument("--group", type=int, default=GRPOConfig.group)
    ap.add_argument("--steps", type=int, default=GRPOConfig.steps)
    a = ap.parse_args()
    if a.self_test:
        sys.exit(selftest())
    if a.run:
        run(GRPOConfig(group=a.group, steps=a.steps), a)
    ap.print_help()

if __name__ == "__main__":
    main()
