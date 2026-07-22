"""M5 second pass — offline allocation A/B: shipped linear-ramp vs KKT water-filling.

Quantifies the hypothesized gain of the derived allocator before any live A/B.
Population of nodes with uncertainties u_i; grounding budget B split by:
  uniform      b = B/n
  shipped      b ∝ groundingPolicy(dilation(u, 0, 0.5)) breadth (linear ramp in D,
               fetch cutoff at D<=0.5) — faithful to lib/grounding-policy.js
  waterfill    KKT optimum under e_i(b) = u_i * exp(-gamma b)
Scored under the TRUE exponential-returns model AND under a MISSPECIFIED
power-law returns model (robustness: does the win survive the wrong model?).

Run:  python experiments/owned_math_m5_allocation_sim.py
"""

from __future__ import annotations

import json
import os

import numpy as np

OUT = os.path.join("experiments", "results", "owned_math_m5_allocation_sim.json")
GAMMA = 1.0
N = 200
SEED = 9


def dilation(u, cost=0.0, conf=0.5, prox=0.0):
    raw = (1.0 + u) / ((1.0 + conf) * (1.0 + cost))
    d = min(5.0, max(0.1, raw))
    return (1 - prox) * d + prox * 0.1


def shipped_weights(us):
    w = []
    for u in us:
        D = dilation(u)
        if D <= 0.5:
            w.append(0.0)
        elif D <= 1.0:
            w.append(5.0)                      # base_max_results
        else:
            w.append(5.0 * D)                  # linear ramp
    w = np.array(w)
    return w / w.sum() if w.sum() else np.full(len(us), 1.0 / len(us))


def waterfill(us, Bud, gamma=GAMMA):
    lo, hi = 1e-9, gamma * max(us)
    for _ in range(80):
        nu = 0.5 * (lo + hi)
        b = np.maximum(0.0, np.log(gamma * us / nu) / gamma)
        if b.sum() > Bud:
            lo = nu
        else:
            hi = nu
    return np.maximum(0.0, np.log(gamma * us / hi) / gamma)


def err_true(us, b):
    return float(np.sum(us * np.exp(-GAMMA * b)))


def err_misspec(us, b, alpha=1.5):
    return float(np.sum(us / (1.0 + b) ** alpha))


def main():
    rng = np.random.default_rng(SEED)
    pops = {
        "uniform_u": rng.uniform(0.05, 1.0, N),
        "mostly_confident (Beta(2,5))": rng.beta(2, 5, N),
        "mostly_uncertain (Beta(5,2))": rng.beta(5, 2, N),
    }
    budgets = [20.0, 60.0, 150.0]
    rows = []
    for pname, us in pops.items():
        us = np.clip(us, 0.01, 1.0)
        for Bud in budgets:
            b_uni = np.full(N, Bud / N)
            b_ship = shipped_weights(us) * Bud
            b_wf = waterfill(us, Bud)
            row = {"population": pname, "budget": Bud}
            for model, err in (("true_exp", err_true), ("misspec_pow", err_misspec)):
                e_u, e_s, e_w = err(us, b_uni), err(us, b_ship), err(us, b_wf)
                row[model] = {
                    "uniform": round(e_u, 2), "shipped": round(e_s, 2), "waterfill": round(e_w, 2),
                    "wf_vs_shipped_gain_%": round(100 * (e_s - e_w) / e_s, 1) if e_s else None,
                    "wf_vs_uniform_gain_%": round(100 * (e_u - e_w) / e_u, 1) if e_u else None,
                }
            rows.append(row)

    gains = [r["true_exp"]["wf_vs_shipped_gain_%"] for r in rows]
    gains_mis = [r["misspec_pow"]["wf_vs_shipped_gain_%"] for r in rows]
    report = {
        "config": {"N": N, "gamma": GAMMA, "budgets": budgets},
        "rows": rows,
        "summary": {
            "wf_vs_shipped_gain_true_model_%": {"min": min(gains), "median": float(np.median(gains)), "max": max(gains)},
            "wf_vs_shipped_gain_misspecified_%": {"min": min(gains_mis), "median": float(np.median(gains_mis)), "max": max(gains_mis)},
        },
        "reading": (
            "Positive gains under the true model = the linear ramp leaves measurable "
            "error on the table; the misspecified row is the robustness check — if "
            "gains collapse or go negative there, the live A/B (A8) must arbitrate "
            "before any policy change."
        ),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report, indent=2)[:2600])


if __name__ == "__main__":
    main()
