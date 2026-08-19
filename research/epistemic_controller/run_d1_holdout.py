"""Disjoint-seed holdout for D1. The benchmark ran seeds 0-59 and landed at +25.4% against a
pre-registered bar of +25% -- close enough to the line that it could be seed luck. This re-runs
the exact D1 comparison on seeds 200-399, which the tuning never touched. The gate is NOT moved:
still >=25% gain in the repeat regime and >=90% of one-shot in the non-repeat regime."""
import os, sys, json
sys.path.insert(0, os.path.join(os.getcwd(), 'research', 'epistemic_controller'))
import run_discovery_benchmark as B

SEEDS = range(200, 400)
out = {}
for regime, rep in (("repeat", True), ("nonrepeat", False)):
    for arm in ("one-shot", "relmem"):
        rows = [B.run_seed(s, arm, repeat=rep) for s in SEEDS]
        a = B.agg(rows)
        out[f"{regime}/{arm}"] = a
        print(f"{regime:10} {arm:9} disc={a['discoveries']:4}/{a['possible']}  false={a['false']:3}  "
              f"exp={a['experiments']:5}  per_exp={a['per_experiment']:.4f}")
g = 100 * (out["repeat/relmem"]["per_experiment"] / out["repeat/one-shot"]["per_experiment"] - 1)
h = out["nonrepeat/relmem"]["per_experiment"] / out["nonrepeat/one-shot"]["per_experiment"]
print(f"\nHOLDOUT D1  repeat gain {g:+.1f}% (bar +25%)   nonrepeat ratio {h:.3f} (bar >=0.90)")
print("HOLDOUT VERDICT:", "PASS" if (g >= 25 and h >= 0.90) else "FAIL")
json.dump({"seeds": [200, 400], "arms": out, "repeat_gain_pct": g, "nonrepeat_ratio": h,
           "pass": bool(g >= 25 and h >= 0.90)},
          open(os.path.join('research', 'epistemic_controller', 'results', 'd1_holdout.json'), 'w'), indent=2, default=float)
