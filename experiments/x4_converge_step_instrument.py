"""
X4 — Convergence-measurement instrument validation for the 3^12 lattice "motion face" (E2).

GOAL
----
Validate that the Sigma0 latent-loop CONVERGENCE INSTRUMENT faithfully MEASURES
latent contraction: it must report a fixed point exactly when the trajectory
contracts, and must NOT when the trajectory orbits or diverges.

IMPORTANT HONESTY NOTE (read first)
-----------------------------------
The task brief asserts that `src/sigma0/loop_lm.py` contains a pure staticmethod

    Sigma0LoopLM.converge_step(hidden_per_step, eps, max_steps)
        -> (exit_step_1indexed, rel_delta, reason, deltas)

that computes rel = ||h_t - h_{t-1}|| / ||h_{t-1}|| over a list of last-token
hidden-state tensors and exits at the first rel < eps ("fixed_point") else
"max_depth".

As of this repo state that method DOES NOT EXIST. The only convergence/exit
instrument in loop_lm.py is:

    Sigma0LoopLM.qexit_step(gate_steps, q, max_steps)
        -> (exit_step_1indexed, confidence_cdf, reason)

which is a *Q-exit over per-step exit-gate logits* (a CDF threshold on learned
gate probabilities), NOT a hidden-state relative-delta contraction test. It does
not take hidden tensors and has no eps/"fixed_point" semantics.

So this experiment does TWO things, both reported transparently:

  (A) Implements the contraction instrument EXACTLY as specified in the E2 brief
      (the `converge_step` contraction semantics), as a local reference
      `converge_step_ref`, and validates it against three synthetic trajectories
      of KNOWN ground truth (CONTRACTION / ORBIT / DIVERGENCE). This validates
      the MEASUREMENT LOGIC the E2 instrument is supposed to embody.

  (B) Probes the REAL repo instrument `Sigma0LoopLM.qexit_step` to honestly
      document the API/semantics mismatch (it is gate/CDF based, not contraction
      based), so nobody over-claims that loop_lm.py already measures contraction.

This validates the MEASUREMENT, not a real Ouro-1.4B latent trajectory. torch is
CPU-only here; a real Ouro forward pass is attempted only as an optional bonus.

Run:
    PYTHONPATH=src python experiments/x4_converge_step_instrument.py
"""
from __future__ import annotations

import json
import math

import torch


# ---------------------------------------------------------------------------
# (A) Reference implementation of the contraction instrument, EXACTLY per the
#     E2 brief's converge_step contract. Pure function over a list of 1-D
#     torch tensors (last-token hidden states per UT step).
# ---------------------------------------------------------------------------
def converge_step_ref(hidden_per_step, eps: float, max_steps: int):
    """Brief-specified contraction instrument.

    hidden_per_step : list of 1-D torch tensors (last-token hidden state per step)
    Returns (exit_step_1indexed, rel_delta_at_exit, reason, deltas)
      rel_t  = ||h_t - h_{t-1}|| / ||h_{t-1}||  for t = 1..n-1 (0-indexed steps)
      exit at first rel_t < eps  -> reason "fixed_point"
      else                       -> reason "max_depth"
    deltas is the full list of rel_t computed (in encounter order).
    """
    deltas = []
    n = min(len(hidden_per_step), max_steps)
    for t in range(1, n):
        prev = hidden_per_step[t - 1]
        cur = hidden_per_step[t]
        denom = float(torch.linalg.vector_norm(prev))
        num = float(torch.linalg.vector_norm(cur - prev))
        rel = num / denom if denom != 0.0 else float("inf")
        deltas.append(rel)
        if rel < eps:
            # exit step is 1-indexed position of the step we just landed on (t+1
            # in 1-indexed terms, since hidden_per_step[t] is the (t+1)-th state)
            return t + 1, rel, "fixed_point", deltas
    last = deltas[-1] if deltas else float("nan")
    return n, last, "max_depth", deltas


# ---------------------------------------------------------------------------
# Synthetic trajectory builders (KNOWN ground truth), all as torch tensors.
# ---------------------------------------------------------------------------
def make_contraction(dim: int, steps: int):
    """h_t = h_star + 0.5**t * (h0 - h_star). Geometrically contracts to h_star.
    rel_t should be strictly decreasing -> hits eps -> 'fixed_point'."""
    g = torch.Generator().manual_seed(11)
    h_star = torch.randn(dim, generator=g, dtype=torch.float64)
    h0 = h_star + torch.randn(dim, generator=g, dtype=torch.float64) * 3.0
    return [h_star + (0.5 ** t) * (h0 - h_star) for t in range(steps)]


def make_orbit(dim: int, steps: int, angle: float = 0.7):
    """Constant-norm rotation by a fixed angle each step in a fixed 2-plane of an
    n-D vector. ||h_t|| is constant and ||h_t - h_{t-1}|| is constant, so rel_t is
    a constant > eps -> never exits -> 'max_depth' (NO false fixed_point)."""
    g = torch.Generator().manual_seed(23)
    base = torch.randn(dim, generator=g, dtype=torch.float64)
    # rotate components 0 and 1 by `angle` each step; leave the rest fixed.
    traj = []
    c, s = math.cos(angle), math.sin(angle)
    for t in range(steps):
        v = base.clone()
        x0, x1 = float(base[0]), float(base[1])
        # apply rotation t times == rotate by t*angle
        ct, st = math.cos(t * angle), math.sin(t * angle)
        v[0] = ct * x0 - st * x1
        v[1] = st * x0 + ct * x1
        traj.append(v)
    return traj


def make_divergence(dim: int, steps: int, growth: float = 1.3):
    """h_t = growth**t * h0. ||h_t - h_{t-1}|| / ||h_{t-1}|| = (growth - 1),
    constant and > eps; magnitudes blow up -> 'max_depth', never 'fixed_point'."""
    g = torch.Generator().manual_seed(37)
    h0 = torch.randn(dim, generator=g, dtype=torch.float64)
    return [(growth ** t) * h0 for t in range(steps)]


# ---------------------------------------------------------------------------
# Ground-truth expectations + checks
# ---------------------------------------------------------------------------
def is_strictly_decreasing(xs, tol=1e-12):
    return all(xs[i + 1] < xs[i] - tol for i in range(len(xs) - 1))


def is_non_decreasing(xs, tol=1e-9):
    return all(xs[i + 1] >= xs[i] - tol for i in range(len(xs) - 1))


def is_roughly_constant(xs, rel_tol=1e-6):
    if not xs:
        return False
    lo, hi = min(xs), max(xs)
    mid = (lo + hi) / 2.0 or 1.0
    return (hi - lo) / abs(mid) < rel_tol


def main():
    eps = 0.05
    max_steps = 12
    dim = 16
    results = {}
    all_pass = True

    # --- CONTRACTION ---
    traj = make_contraction(dim, max_steps)
    step, rel, reason, deltas = converge_step_ref(traj, eps, max_steps)
    expect_reason = "fixed_point"
    pass_reason = reason == expect_reason
    pass_decr = is_strictly_decreasing(deltas[: deltas.index(min(deltas)) + 1]) and is_strictly_decreasing(
        deltas[: (deltas.index(rel) + 1)]
    )
    # simpler/robust: the deltas up to and including exit must be strictly decreasing
    pass_decr = is_strictly_decreasing(deltas)
    contraction_pass = pass_reason and pass_decr
    all_pass &= contraction_pass
    results["contraction"] = {
        "ground_truth": "h_t = h_star + 0.5**t*(h0-h_star); converges to h_star",
        "deltas": deltas,
        "exit_reason": reason,
        "exit_step_1indexed": step,
        "rel_at_exit": rel,
        "expected_reason": expect_reason,
        "checks": {
            "reason_is_fixed_point": pass_reason,
            "deltas_strictly_decreasing": pass_decr,
        },
        "verdict": "PASS" if contraction_pass else "FAIL",
    }

    # --- ORBIT ---
    traj = make_orbit(dim, max_steps, angle=0.7)
    step, rel, reason, deltas = converge_step_ref(traj, eps, max_steps)
    expect_reason = "max_depth"
    pass_reason = reason == expect_reason
    pass_above_eps = all(d > eps for d in deltas)
    pass_const = is_roughly_constant(deltas)
    orbit_pass = pass_reason and pass_above_eps and pass_const
    all_pass &= orbit_pass
    results["orbit"] = {
        "ground_truth": "constant-norm rotation by fixed angle 0.7 rad/step in a 2-plane",
        "deltas": deltas,
        "exit_reason": reason,
        "exit_step_1indexed": step,
        "rel_at_exit": rel,
        "expected_reason": expect_reason,
        "checks": {
            "reason_is_max_depth": pass_reason,
            "all_rel_above_eps": pass_above_eps,
            "rel_roughly_constant": pass_const,
            "no_false_fixed_point": reason != "fixed_point",
        },
        "verdict": "PASS" if orbit_pass else "FAIL",
    }

    # --- DIVERGENCE ---
    traj = make_divergence(dim, max_steps, growth=1.3)
    step, rel, reason, deltas = converge_step_ref(traj, eps, max_steps)
    expect_reason = "max_depth"
    pass_reason = reason == expect_reason
    pass_nondecr = is_non_decreasing(deltas)
    pass_above_eps = all(d > eps for d in deltas)
    divergence_pass = pass_reason and pass_nondecr and pass_above_eps
    all_pass &= divergence_pass
    results["divergence"] = {
        "ground_truth": "h_t = 1.3**t * h0; magnitudes blow up",
        "deltas": deltas,
        "exit_reason": reason,
        "exit_step_1indexed": step,
        "rel_at_exit": rel,
        "expected_reason": expect_reason,
        "checks": {
            "reason_is_max_depth": pass_reason,
            "deltas_non_decreasing": pass_nondecr,
            "all_rel_above_eps": pass_above_eps,
            "no_false_fixed_point": reason != "fixed_point",
        },
        "verdict": "PASS" if divergence_pass else "FAIL",
    }

    # --- (B) Probe the REAL repo instrument to document the mismatch honestly ---
    repo_probe = {}
    try:
        from sigma0.loop_lm import Sigma0LoopLM

        has_converge_step = hasattr(Sigma0LoopLM, "converge_step")
        has_qexit_step = hasattr(Sigma0LoopLM, "qexit_step")
        repo_probe["has_converge_step_in_repo"] = has_converge_step
        repo_probe["has_qexit_step_in_repo"] = has_qexit_step
        if has_qexit_step:
            # qexit_step is gate-LOGIT/CDF based, NOT contraction based. Demonstrate
            # it on a sanity input: monotonically rising gate logits -> early threshold.
            rising = [-3.0, -1.0, 0.5, 2.0]  # increasing exit confidence
            t, cdf, reason = Sigma0LoopLM.qexit_step(rising, q=0.5, max_steps=4)
            repo_probe["qexit_demo_rising_gates"] = {
                "gate_logits": rising,
                "q": 0.5,
                "exit_step": t,
                "confidence_cdf": cdf,
                "reason": reason,
            }
        repo_probe["note"] = (
            "Repo's qexit_step measures a CDF over learned exit-gate LOGITS, not "
            "hidden-state relative-delta contraction. The brief's converge_step "
            "(hidden_per_step, eps) contract is NOT present in loop_lm.py; "
            "converge_step_ref in THIS file is a faithful local implementation of "
            "the brief's contraction semantics, and is what the PASS/FAIL above test."
        )
    except Exception as e:  # pragma: no cover - import/probe must never fail the run
        repo_probe["error"] = f"{type(e).__name__}: {e}"

    # --- (BONUS) optional real Ouro-1.4B CPU forward pass ---
    bonus = {"attempted": True, "succeeded": False}
    try:
        bonus.update(_try_real_ouro())
    except Exception as e:  # pragma: no cover
        bonus["blocker"] = f"{type(e).__name__}: {e}"

    out = {
        "experiment": "X4_converge_step_instrument",
        "instrument_under_test": "converge_step_ref (brief-specified contraction semantics)",
        "params": {"eps": eps, "max_steps": max_steps, "dim": dim},
        "torch": {"version": torch.__version__, "cuda": torch.cuda.is_available()},
        "trajectories": results,
        "repo_instrument_probe": repo_probe,
        "real_ouro_bonus": bonus,
        "all_synthetic_pass": all_pass,
        "verdict": "supported" if all_pass else "refuted",
    }
    print(json.dumps(out, indent=2, default=str))
    return out


def _try_real_ouro():
    """Optional: a few-token CPU forward pass on Ouro-1.4B, measuring mean
    hidden-state contraction across UT steps. Must never raise out of main()."""
    import os

    os.environ.setdefault("HF_HOME", "D:/hf-cache")
    from transformers import AutoModelForCausalLM, AutoTokenizer

    base = "ByteDance/Ouro-1.4B"
    tok = AutoTokenizer.from_pretrained(base, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        base, trust_remote_code=True, dtype=torch.float32, device_map=None
    )
    model = model.to("cpu")
    model.eval()
    bb = model.get_base_model() if hasattr(model, "get_base_model") else model
    ids = tok("In one sentence, what is a looped language model?", return_tensors="pt").input_ids
    ids = ids.to("cpu")
    with torch.no_grad():
        _out, hidden_states_list, _gate_list = bb.model(input_ids=ids, use_cache=False)
    # last-token hidden per UT step -> contraction instrument
    per_step = [h[0, -1, :].to(torch.float64) for h in hidden_states_list]
    step, rel, reason, deltas = converge_step_ref(per_step, eps=0.05, max_steps=12)
    return {
        "succeeded": True,
        "n_ut_steps": len(per_step),
        "deltas": deltas,
        "mean_contraction": (sum(deltas) / len(deltas)) if deltas else None,
        "exit_step": step,
        "exit_reason": reason,
        "device": "cpu",
    }


if __name__ == "__main__":
    main()
