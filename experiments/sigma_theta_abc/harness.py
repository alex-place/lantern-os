"""Σ_θ A/B/C continual-update harness — the Phase-1 falsifiable experiment (ADR-0025).

Does a weight update earn its keep over frozen-base + retrieval at 1.4B? Trains THREE
adapters from the same frozen Ouro-1.4B checkpoint at EQUAL compute and gates each with the
Σ_θ release gate (SIGMA0-COLLAPSE-CERTIFICATE §8.1.2), then applies the A/B/C decision tree:

  A = verified distillation only
  B = distillation + verified generative replay (+ generic anchor)
  C = distillation + replay + narrow RLVR/GRPO

This file is an ORCHESTRATOR, not a new training subsystem — it shells to the existing
scripts (train-qlora-ouro.py, eval_sigma0_adapter.py, eval_humaneval_ouro.py,
continual_ouro_pipeline.py) and adds (1) the real Σ_θ gate logic and (2) the A/B/C decision
tree, both self-testable with NO GPU. Training itself runs ONLY on cloud L4 — the local box
freezes under LLM training ([local-pc-freezes-ram-exhaustion]); `--train` refuses off-L4.

    # no-GPU: verify the gate + decision-tree logic (runs in CI)
    python experiments/sigma_theta_abc/harness.py --self-test
    # cloud L4: full run
    KEYSTONE_L4=1 python experiments/sigma_theta_abc/harness.py --run --budget-hours 100
"""
from __future__ import annotations
import argparse, json, os, sys
from dataclasses import dataclass, field, asdict

# ─────────────────────────── gate thresholds (ADR-0025 / cert §8.1.2) ───────────────────────────
@dataclass
class GateConfig:
    gamma_gain: float = 0.02     # min fresh-task pass@1 gain over incumbent to count as improvement
    eps_retention: float = 0.01  # max allowed drop on the historic verified suite (hard no-regression)
    kl_max: float = 0.15         # max KL(candidate ‖ prior checkpoint) — drift budget
    adapter_norm_max: float = 8.0
    require_stability: bool = True   # Σ₀ Part-I collapse monitor must show max Re λ(A) < 0

# ─────────────────────────── the Σ_θ release gate (§8.1.2, 7 conditions) ───────────────────────────
def sigma_theta_gate(m: dict, cfg: GateConfig) -> dict:
    """Apply the 7-condition Σ_θ release gate to one candidate's measured metrics `m`.
    Returns {accept: bool, reasons: [...], conditions: {name: pass}}. Load-bearing gate is the
    exec holdout (conds 1-3); Σ₀ stability (cond 5) is a cheap early-abort, never the authority."""
    c = {}
    # 1. fresh-task GAIN — must improve on the FRESH (used-once) promotion set, not just not-regress
    c["1_fresh_gain"] = (m["fresh_pass1"] - m["incumbent_fresh_pass1"]) >= cfg.gamma_gain
    # 2. retention — historic verified suite drops no more than eps (hard no-regression bar)
    c["2_retention"] = (m["incumbent_retention_pass1"] - m["retention_pass1"]) <= cfg.eps_retention
    # 3. reward integrity (anti-Goodhart) — proxy reward may rise ONLY if independent world eval does not fall
    proxy_up = m["proxy_reward"] > m["incumbent_proxy_reward"]
    world_down = m["world_eval"] < m["incumbent_world_eval"] - 1e-9
    c["3_reward_integrity"] = not (proxy_up and world_down)
    # 4. drift budget — KL from prior checkpoint + adapter norm within limits
    c["4_drift"] = (m["kl_from_prior"] <= cfg.kl_max) and (m["adapter_norm"] <= cfg.adapter_norm_max)
    # 5. fast-state stability — Σ₀ Part-I monitor (cheap early-abort, necessary not sufficient)
    c["5_stability"] = (not cfg.require_stability) or bool(m["stability_ok"])
    # 6. data integrity — no holdout contamination detected + full provenance present
    c["6_data_integrity"] = bool(m["no_contamination"]) and bool(m["provenance_present"])
    # 7. rollback — the prior adapter/checkpoint remains immediately deployable
    c["7_rollback"] = bool(m["rollback_available"])
    reasons = [k for k, ok in c.items() if not ok]
    return {"accept": not reasons, "failed": reasons, "conditions": c}

# ─────────────────────────── the A/B/C decision tree (ADR-0025) ───────────────────────────
def abc_decision(res: dict, cfg: GateConfig) -> dict:
    """res = {arm: metrics} for arms A,B,C plus a 'retrieval' baseline (frozen base + RAG).
    Encodes: C wins only if it beats B on new tasks WITHOUT worse retention / more reward-eval
    divergence / instability; else B if it beats A and retrieval; else A; else stop weight updates."""
    base = res["retrieval"]["fresh_pass1"]
    def beats_retrieval(a): return res[a]["fresh_pass1"] - base >= cfg.gamma_gain
    gated = {a: sigma_theta_gate(res[a], cfg)["accept"] for a in ("A", "B", "C")}

    # C must clear its gate AND strictly dominate B on new tasks without regressions
    c_dominates_b = (
        gated["C"]
        and (res["C"]["fresh_pass1"] - res["B"]["fresh_pass1"]) >= cfg.gamma_gain
        and (res["B"]["retention_pass1"] - res["C"]["retention_pass1"]) <= cfg.eps_retention
        and not (res["C"]["proxy_reward"] > res["C"]["world_eval"] + res["B"].get("goodhart_gap", 0))
        and res["C"]["stability_ok"]
    )
    if c_dominates_b and beats_retrieval("C"):
        return {"winner": "C", "verdict": "RLVR earns its keep — ship C (replay+RLVR)",
                "rl_enabled": True, "gated": gated}
    if gated["B"] and beats_retrieval("B") and res["B"]["fresh_pass1"] >= res["A"]["fresh_pass1"]:
        return {"winner": "B", "verdict": "dreaming = replay+verification; RLVR waits (no added value yet)",
                "rl_enabled": False, "gated": gated}
    if gated["A"] and beats_retrieval("A"):
        return {"winner": "A", "verdict": "distillation helps but the replay recipe needs work",
                "rl_enabled": False, "gated": gated}
    return {"winner": None, "verdict": "NO weight update earns its keep over retrieval — stop updating, "
            "improve retrieval/tools instead (Rule 0 holds)", "rl_enabled": False, "gated": gated}

# ─────────────────────────── orchestration (cloud L4 only) ───────────────────────────
ARMS = {
    "A": {"replay": False, "rlvr": False, "desc": "verified distillation only"},
    "B": {"replay": True,  "rlvr": False, "desc": "distillation + verified replay + generic anchor"},
    "C": {"replay": True,  "rlvr": True,  "desc": "distillation + replay + narrow RLVR/GRPO"},
}

def _require_l4():
    if os.environ.get("KEYSTONE_L4") != "1":
        sys.exit("REFUSING to train off cloud L4 (KEYSTONE_L4!=1). The local box freezes under LLM "
                 "training [local-pc-freezes-ram-exhaustion]. Run the spec on L4. Use --self-test locally.")

def plan_commands(args):
    """The deterministic training recipe: the exact subprocess command per arm (SPEC §4 runbook).
    Pure — returns a list of {arm, cmd}. Testable without a GPU; the L4 host just runs each `cmd`."""
    base = getattr(args, "base", "ByteDance/Ouro-1.4B")
    out = getattr(args, "out", "runs/abc")
    plans = []
    for arm, spec in ARMS.items():
        if spec["rlvr"]:   # arm C — the GRPO trainer, warm-started from arm B
            cmd = ["python", "scripts/rlvr_grpo_ouro.py", "--run", "--base", base,
                   "--warm-start", f"{out}/B", "--tasks", "data/eval/rlvr-train.jsonl",
                   "--out", f"{out}/{arm}", "--group", "8", "--steps", "300"]
        else:              # arms A/B — the existing distillation trainer, different data mix
            data = "data/eval/distill-replay.jsonl" if spec["replay"] else "data/eval/distill.jsonl"
            cmd = ["python", "scripts/train-qlora-ouro.py", "--base", base, "--data", data,
                   "--lora-r", "16", "--out", f"{out}/{arm}"]
        plans.append({"arm": arm, "replay": spec["replay"], "rlvr": spec["rlvr"], "cmd": cmd})
    return plans

def decide(results, cfg=None):
    """Evaluate + decide from measured per-arm metrics (the back half — NO GPU). `results` maps
    'retrieval'/'A'/'B'/'C' -> the 7-metric dict. Returns {decision, gates} — the shippable verdict."""
    cfg = cfg or GateConfig()
    decision = abc_decision(results, cfg)
    gates = {a: sigma_theta_gate(results[a], cfg) for a in ("A", "B", "C") if a in results}
    return {"decision": decision, "gates": {a: {"accept": g["accept"], "failed": g["failed"]} for a, g in gates.items()}}

def run(args):
    """A/B/C run. Two entry points:
      --results FILE : evaluate + decide from measured metrics (the back half; no GPU, CI-safe).
      (default)      : the training front half — L4 only; runs plan_commands() then re-invokes
                       --results on the assembled metrics. Each arm shells to a tracked script."""
    import json, subprocess
    if getattr(args, "results", None):
        with open(args.results, encoding="utf-8") as f:
            report = decide(json.load(f))
        print(json.dumps(report, indent=2, default=lambda o: o))
        return report
    _require_l4()   # the training half is L4-only
    for p in plan_commands(args):
        print(f"[abc] arm {p['arm']}: {' '.join(p['cmd'])}")
        subprocess.run(p["cmd"], check=True)
    # after training, evaluate each arm -> assemble the 7-metric results, then decide. The eval glue
    # (eval_sigma0_adapter.py / eval_humaneval_ouro.py -> the 7 metrics) is the remaining L4-host wiring;
    # it writes <out>/results.json, which is then fed back through `decide` above.
    raise SystemExit("Training arms dispatched; wire the eval->7-metric assembly on the L4 host "
                     "(SPEC §3), then re-run with --results <out>/results.json to gate + decide.")

# ─────────────────────────── self-test (no GPU, CI-safe) ───────────────────────────
def selftest() -> int:
    cfg = GateConfig()
    fails = 0
    def check(name, cond):
        nonlocal fails
        print(f"[selftest] {'PASS' if cond else 'FAIL'}  {name}")
        fails += 0 if cond else 1

    good = dict(fresh_pass1=0.86, incumbent_fresh_pass1=0.82, retention_pass1=0.90,
                incumbent_retention_pass1=0.90, proxy_reward=0.8, incumbent_proxy_reward=0.7,
                world_eval=0.85, incumbent_world_eval=0.83, kl_from_prior=0.05, adapter_norm=4.0,
                stability_ok=True, no_contamination=True, provenance_present=True, rollback_available=True)
    check("clean improvement accepted", sigma_theta_gate(good, cfg)["accept"])

    # reward hacking: proxy up, world eval down → cond 3 must reject (the failure Part I can't see)
    hack = dict(good, proxy_reward=0.95, world_eval=0.80)  # world < incumbent 0.83
    g = sigma_theta_gate(hack, cfg)
    check("reward-hack rejected by cond 3", (not g["accept"]) and "3_reward_integrity" in g["failed"])

    # retention regression (correct-set turnover) → cond 2 rejects
    forget = dict(good, retention_pass1=0.85)  # dropped 0.05 > eps 0.01
    g = sigma_theta_gate(forget, cfg)
    check("forgetting rejected by cond 2", (not g["accept"]) and "2_retention" in g["failed"])

    # stability degeneration → cond 5 early-abort
    unstable = dict(good, stability_ok=False)
    check("instability rejected by cond 5", "5_stability" in sigma_theta_gate(unstable, cfg)["failed"])

    # drift over budget → cond 4
    drift = dict(good, kl_from_prior=0.30)
    check("drift rejected by cond 4", "4_drift" in sigma_theta_gate(drift, cfg)["failed"])

    # decision tree: B wins when RLVR adds nothing
    res_bwins = {
        "retrieval": dict(good, fresh_pass1=0.80),
        "A": dict(good, fresh_pass1=0.84),
        "B": dict(good, fresh_pass1=0.86, retention_pass1=0.90),
        "C": dict(good, fresh_pass1=0.86, retention_pass1=0.88),  # no fresh gain over B, worse retention
    }
    d = abc_decision(res_bwins, cfg)
    check("decision: B wins when RLVR adds no gain", d["winner"] == "B" and not d["rl_enabled"])

    # decision tree: C wins when RLVR genuinely helps
    res_cwins = {
        "retrieval": dict(good, fresh_pass1=0.80),
        "A": dict(good, fresh_pass1=0.84),
        "B": dict(good, fresh_pass1=0.86, retention_pass1=0.90),
        "C": dict(good, fresh_pass1=0.90, retention_pass1=0.90, proxy_reward=0.8, world_eval=0.89),
    }
    d = abc_decision(res_cwins, cfg)
    check("decision: C wins when RLVR helps", d["winner"] == "C" and d["rl_enabled"])

    # decision tree: nothing beats retrieval → stop updating
    res_none = {"retrieval": dict(good, fresh_pass1=0.86),
                "A": dict(good, fresh_pass1=0.865), "B": dict(good, fresh_pass1=0.865),
                "C": dict(good, fresh_pass1=0.865)}
    d = abc_decision(res_none, cfg)
    check("decision: none beat retrieval -> stop weight updates", d["winner"] is None)

    print(f"\n[selftest] {'ALL PASSED' if not fails else str(fails)+' FAILED'}")
    return 1 if fails else 0

def main():
    ap = argparse.ArgumentParser(description="Σ_θ A/B/C continual-update harness (ADR-0025)")
    ap.add_argument("--self-test", action="store_true", help="verify gate + decision logic, no GPU (CI)")
    ap.add_argument("--run", action="store_true", help="A/B/C run: train (L4) or --results decide (no GPU)")
    ap.add_argument("--results", default=None, help="per-arm metrics JSON -> gate + decide (no GPU)")
    ap.add_argument("--base", default="ByteDance/Ouro-1.4B")
    ap.add_argument("--out", default="runs/abc")
    ap.add_argument("--budget-hours", type=float, default=100.0)
    a = ap.parse_args()
    if a.self_test:
        sys.exit(selftest())
    if a.run or a.results:
        run(a)
        return
    ap.print_help()

if __name__ == "__main__":
    main()
