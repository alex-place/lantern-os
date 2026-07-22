"""Unit tests for the #2833 decay-prediction analysis, on synthetic trajectories with a
KNOWN exit step — so the prediction logic is verified independent of the GPU run.

Run: .venv-train/Scripts/python experiments/oracle_spiral/test_decay_prediction.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from decay_prediction import (
    predict_n_converge, estimate_lambda, predict_exit_step, actual_exit_step,
    evaluate_run, summarize, decide,
)

fails = 0
def check(name, cond):
    global fails
    if cond: print(f"  ok  - {name}")
    else: fails += 1; print(f"  FAIL- {name}")

EPS = 0.05

# clean geometric decay λ=0.5: r = 1, .5, .25, .125, .0625, .03125 → first < .05 at idx5 → step 6
geo = [1.0, 0.5, 0.25, 0.125, 0.0625, 0.03125]
check("actual_exit_step finds the first sub-eps step (6)", actual_exit_step(geo, EPS) == 6)
check("estimate_lambda recovers λ=0.5", abs(estimate_lambda(geo, 3) - 0.5) < 1e-6)
check("predict_n_converge(0.25, .5, .05) == 3", predict_n_converge(0.25, 0.5, EPS) == 3)
check("early prediction (observe 3 steps) hits the actual exit step 6",
      predict_exit_step(geo, EPS, observe_k=3) == 6)

# faster decay λ=0.25 converges sooner; early λ̂ should still predict close.
# r: 1, .25, .0625, .0156 → first < .05 is .0156 at idx3 → step 4 (.0625 is still > eps).
fast = [1.0, 0.25, 0.0625, 0.015625]
check("fast decay: actual exit at step 4", actual_exit_step(fast, EPS) == 4)
check("fast decay: predicted within 1 of actual",
      abs(predict_exit_step(fast, EPS, 3) - actual_exit_step(fast, EPS)) <= 1)

# non-contracting (λ=1) → predict barrier (None), actual never converges (None) → agree
flat = [0.4, 0.4, 0.4, 0.4, 0.4]
check("flat loop → predicted barrier (None)", predict_exit_step(flat, EPS, 3) is None)
check("flat loop → actual max-depth (None)", actual_exit_step(flat, EPS) is None)

# diverging (λ>1) → predict barrier
div = [0.1, 0.2, 0.4, 0.8, 1.6]
check("diverging loop → λ̂>1 → predicted barrier", predict_exit_step(div, EPS, 3) is None)

# already converged at observation point → 0 more steps
check("already-small residual → n_converge 0", predict_n_converge(0.01, 0.5, EPS) == 0.0)

# ── aggregate + decision on a PREDICTIVE synthetic set (λ̂ should track the door) ──
runs = []
for i, lam in enumerate([0.5, 0.4, 0.6, 0.3, 0.55, 0.45]):
    d, r = [], 1.0
    for _ in range(12):
        d.append(r); r *= lam
    runs.append(evaluate_run(f"p{i}", d, EPS, observe_k=3, grounded=True))
# add two genuine barrier cases (flat) that fail groundedness
for j in range(2):
    runs.append(evaluate_run(f"b{j}", [0.4]*10, EPS, observe_k=3, grounded=False))

s = summarize(runs)
check("predictive set: MAE ≤ 1 step", s["mae_steps"] is not None and s["mae_steps"] <= 1.0)
check("predictive set: within-1-step ≥ 0.8", s["within_1_step"] >= 0.8)
check("predictive set: barrier agreement == 1.0", s["barrier_agreement"] == 1.0)
check("groundedness: barrier cases fail more than converging ones",
      s["groundedness_fail_rate_barrier"] == 1.0 and s["groundedness_fail_rate_converge"] == 0.0)
d = decide(s)
check("decision on predictive synthetic data == 'predictive'", d["verdict"] == "predictive")

# ── a NON-predictive set: exit steps random vs λ̂ → decision must say not_predictive ──
import math
bad = []
# residuals that jump to sub-eps at a step UNRELATED to the early decay rate
bad.append(evaluate_run("x0", [0.9, 0.89, 0.88, 0.01], EPS, 3, grounded=True))   # sudden drop
bad.append(evaluate_run("x1", [0.9, 0.89, 0.88, 0.87, 0.86, 0.01], EPS, 3, grounded=True))
bad.append(evaluate_run("x2", [0.9, 0.895, 0.89, 0.885, 0.88, 0.875, 0.87, 0.01], EPS, 3, grounded=True))
sb = summarize(bad)
db = decide(sb)
check("decision on non-predictive data == 'not_predictive'", db["verdict"] == "not_predictive")

print("\nall passed" if not fails else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)
