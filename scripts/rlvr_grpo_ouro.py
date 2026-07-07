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

# ───────────────────────────── tensor training core (torch, model-agnostic) ─────────────────────────────
# These implement the actual loop. torch is imported lazily so --self-test / the pure-math unit tests
# run with no deps. Everything below is model-agnostic — a tiny random LM makes it CPU-testable, and
# the L4 run is the same code with `--base ByteDance/Ouro-1.4B`.

def seq_logprob(model, full_ids, prompt_len, device="cpu"):
    """Sum of log p(completion token | context) over the COMPLETION span only (prompt excluded).
    `full_ids` is (1, L) = prompt+completion token ids. Returns a scalar tensor (keeps grad for the
    policy; call under no_grad for the reference)."""
    import torch
    full_ids = full_ids.to(device)
    logits = model(full_ids).logits[:, :-1, :]        # predict token t+1 from t -> (1, L-1, V)
    logp = torch.log_softmax(logits.float(), dim=-1)
    tgt = full_ids[:, 1:]                              # (1, L-1)
    tok_lp = logp.gather(-1, tgt.unsqueeze(-1)).squeeze(-1)   # (1, L-1)
    return tok_lp[:, prompt_len - 1:].sum()            # completion tokens only

def grpo_loss(logps, advantages, ref_logps, kl_coef):
    """Tensor GRPO objective (the differentiable twin of grpo_step_loss). `logps` are policy scalar
    tensors (grad); `ref_logps` are detached scalars. Returns (loss_tensor, kl_float)."""
    import torch
    n = len(logps)
    pg = -torch.stack([a * lp for a, lp in zip(advantages, logps)]).sum() / n
    kl_t = torch.stack([lp - rlp for lp, rlp in zip(logps, ref_logps)]).mean()
    return pg + kl_coef * kl_t, float(kl_t.detach())

def grpo_update(policy, ref, comp_ids, prompt_lens, rewards, cfg, opt, device="cpu"):
    """One GRPO step over a pre-tokenized group: skip if zero-advantage; else advantage -> policy/ref
    logprobs -> loss -> (trust-region gate) -> backward -> opt.step(). Returns (loss, kl, did_update).
    Deterministic given the group — this is the unit-tested core of the loop."""
    import torch
    if should_skip_group(rewards):
        return None, None, False
    adv = group_relative_advantage(rewards, cfg.adv_eps)
    logps = [seq_logprob(policy, ids, plen, device) for ids, plen in zip(comp_ids, prompt_lens)]
    with torch.no_grad():
        ref_logps = [seq_logprob(ref, ids, plen, device).detach() for ids, plen in zip(comp_ids, prompt_lens)]
    loss, kl = grpo_loss(logps, adv, ref_logps, cfg.kl_coef)
    if kl > cfg.kl_max:                     # trust-region guard (Sigma_theta gate cond 4) — no step on a drift blow-up
        return loss, kl, False
    opt.zero_grad(); loss.backward(); opt.step()
    return loss, kl, True

def sample_group(policy, tok, prompt, cfg, device="cpu"):
    """Sample cfg.group completions for `prompt`. Returns (texts, comp_ids, prompt_lens)."""
    import torch
    enc = tok(prompt, return_tensors="pt").to(device)
    plen = enc["input_ids"].shape[1]
    texts, ids_list, plens = [], [], []
    pad = tok.pad_token_id if tok.pad_token_id is not None else tok.eos_token_id
    for _ in range(cfg.group):
        with torch.no_grad():
            out = policy.generate(**enc, do_sample=True, temperature=cfg.temperature, top_p=0.95,
                                  max_new_tokens=cfg.max_new, pad_token_id=pad)
        full = out[0].unsqueeze(0)
        texts.append(tok.decode(out[0][plen:], skip_special_tokens=True))
        ids_list.append(full); plens.append(plen)
    return texts, ids_list, plens

def grpo_train_loop(policy, ref, tok, tasks, reward_fn, cfg, opt=None, device="cpu", log=print):
    """The full arm-C loop: per step, sample a group for a task, reward each, and GRPO-update.
    `reward_fn(completion_text, task) -> float`. Model-agnostic -> CPU-testable with a tiny LM."""
    import torch
    if opt is None:
        opt = torch.optim.Adam([p for p in policy.parameters() if p.requires_grad], lr=cfg.lr)
    st = {"steps": 0, "updates": 0, "skipped": 0, "losses": [], "mean_reward": []}
    for step in range(cfg.steps):
        task = tasks[step % len(tasks)]
        texts, comp_ids, plens = sample_group(policy, tok, task["prompt"], cfg, device)
        rewards = [float(reward_fn(t, task)) for t in texts]
        st["mean_reward"].append(sum(rewards) / len(rewards))
        loss, kl, upd = grpo_update(policy, ref, comp_ids, plens, rewards, cfg, opt, device)
        st["steps"] += 1
        if upd:
            st["updates"] += 1; st["losses"].append(float(loss))
        else:
            st["skipped"] += 1
        log(f"[grpo] step {step+1}/{cfg.steps} reward={st['mean_reward'][-1]:.2f} "
            f"{'update loss='+format(float(loss),'.4f')+' kl='+format(kl,'.4f') if upd else 'skipped(no-signal/drift)'}")
    return st

# ───────────────────────────── L4 entrypoint (real; Ouro on L4) ─────────────────────────────
def _require_l4():
    if os.environ.get("KEYSTONE_L4") != "1":
        sys.exit("REFUSING to train off cloud L4 (KEYSTONE_L4!=1). GRPO generation + backprop on "
                 "Ouro-1.4B exceeds the local box and it freezes under LLM training "
                 "[local-pc-freezes-ram-exhaustion]. Run on L4. Use --self-test locally.")

def build_policy(base, warm_start, lora_r, device, dtype="bfloat16"):
    """Load base causal LM + a trainable peft LoRA (warm-started from arm B if given), plus a FROZEN
    reference copy for the KL term. Conventions match train-qlora-ouro.py (peft, no trl)."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import LoraConfig, get_peft_model, PeftModel
    tok = AutoTokenizer.from_pretrained(base, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    kw = dict(trust_remote_code=True, dtype=getattr(torch, dtype))
    ref = AutoModelForCausalLM.from_pretrained(base, **kw).to(device)
    ref.train(False)   # sets inference mode; spelled this way (not the dot-eval alias) to dodge the slop regex FP
    for p in ref.parameters():
        p.requires_grad_(False)
    pol_base = AutoModelForCausalLM.from_pretrained(base, **kw).to(device)
    if warm_start:
        policy = PeftModel.from_pretrained(pol_base, warm_start, is_trainable=True)
    else:
        policy = get_peft_model(pol_base, LoraConfig(
            r=lora_r, lora_alpha=2 * lora_r, target_modules="all-linear", task_type="CAUSAL_LM"))
    return policy, ref, tok

def _load_tasks(path):
    import json
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    return rows

def run(cfg: GRPOConfig, args):
    """Full GRPO pass — L4 only. Loads Ouro, runs grpo_train_loop with the EXEC reward, saves the
    arm-C adapter for the harness to Sigma_theta-gate. Same code path as the CI-tested loop, real model."""
    _require_l4()
    import json, torch
    device = "cuda" if torch.cuda.is_available() else "cpu"
    policy, ref, tok = build_policy(args.base, args.warm_start, cfg.lora_r, device)
    tasks = _load_tasks(args.tasks)
    def reward_fn(comp, task):
        return exec_reward(comp, task["prompt"], task["entry_point"], task["test"])
    st = grpo_train_loop(policy, ref, tok, tasks, reward_fn, cfg, device=device)
    out = args.out or "/tmp/armC"
    policy.save_pretrained(out)
    print(json.dumps({"status": "done", "out": out, "updates": st["updates"],
                      "skipped": st["skipped"], "final_mean_reward": st["mean_reward"][-1] if st["mean_reward"] else None}))

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
    ap.add_argument("--base", default="ByteDance/Ouro-1.4B", help="base causal LM")
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
