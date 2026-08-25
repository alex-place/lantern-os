"""What the repair is worth -- the oracle world S is trying to find on its own.

World S asks whether the machine can DIAGNOSE that its selection policy over-weights cost and
repair it. That question only means something if the repair is worth making. This measures that
directly, by sweeping the exponent the self-model is allowed to move:

    utility = explained / cost^e,    e in {1.0, 0.5, 0.0}

on world H (truth z versus a CHEAPER proxy that agrees with it 85% of the time). No self-model,
no diagnosis -- just each policy run as if it had always been the policy. This is the ceiling a
self-diagnosing machine could reach, and the number that says whether a failure in world S is a
failure of DIAGNOSIS or of the repair itself.

Reported per rung:
  truth committed   the run ended with the true cause in the model class
  proxy bought      the proxy was PAID FOR at some point, even if later dropped. This is the
                    cost of the bias: the truth rate can look fine while the machine keeps
                    buying the wrong thing first and repairing afterwards.
  experiments       probes + acquisitions, the price of getting there

Run:  python research/epistemic_controller/run_cost_exponent_sweep.py 200
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from run_world_h import HoldController                            # noqa: E402
from environments.two_explanations import TwoExplanationsWorld    # noqa: E402
from self_model import LADDER                                     # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "results", "cost_exponent_sweep.json")


def run(e, seeds):
    truth = proxy = experiments = 0
    for seed in seeds:
        w = TwoExplanationsWorld(seed)
        c = HoldController(w)
        c.cost_exponent = e
        r = c.run()
        tr = w.truth()
        feats = r["features"][1:]
        committed = feats[-1] if feats else None
        acquired = [x["name"] for x in c.ev.rows if x["kind"] == "measurement"]
        truth += committed == tr["true_z"]
        proxy += tr["proxy_z"] in acquired
        experiments += c.probes_paid + len(acquired)
    n = len(seeds)
    return {"cost_exponent": e, "n": n, "truth_rate": truth / n, "proxy_bought_rate": proxy / n,
            "experiments": experiments, "experiments_per_seed": experiments / n}


def main(n_seeds=200):
    seeds = list(range(n_seeds))
    rows = [run(e, seeds) for e in LADDER]
    print(f"=== COST EXPONENT SWEEP on world H -- {n_seeds} seeds ===\n")
    print(f"{'e':>5} {'truth committed':>16} {'proxy bought':>14} {'experiments/seed':>18}")
    for r in rows:
        print(f"{r['cost_exponent']:>5} {100*r['truth_rate']:>15.0f}% {100*r['proxy_bought_rate']:>13.0f}% {r['experiments_per_seed']:>18.2f}")
    base, best = rows[0], min(rows, key=lambda r: r["proxy_bought_rate"])
    cut = 1 - (best["proxy_bought_rate"] / base["proxy_bought_rate"]) if base["proxy_bought_rate"] else 0.0
    verdict = (f"the repair is worth making: moving e from {base['cost_exponent']} to {best['cost_exponent']} cuts "
               f"wasted proxy purchases by {100*cut:.0f}% "
               f"({100*base['proxy_bought_rate']:.0f}% -> {100*best['proxy_bought_rate']:.0f}% of seeds)"
               if cut >= 0.25 else
               "the repair is NOT worth making: the cost exponent barely changes what gets bought, so "
               "world S is asking the machine to diagnose a defect that costs it nothing")
    out = {"n_seeds": n_seeds, "rows": rows, "verdict": verdict}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, default=float)
    print(f"\nVERDICT: {verdict}")
    print("->", OUT)


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 200)
