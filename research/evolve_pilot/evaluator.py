"""Evaluator for the OpenEvolve pilot: fitness from our own gated benchmarks, controls as law.

WHAT THIS IS. The adopt-don't-reimplement pivot (docs/research/2026-08-21-standing-on-current-
shoulders.md): the search loop is OpenEvolve's (AlphaEvolve lineage); the thing that stays OURS
is this evaluator -- the assay with pre-registered controls. OpenEvolve calls
`evaluate(program_path)` on each mutated policy file; this runs the policy inside the epistemic
controller on fixed seeds and returns metrics.

FITNESS = validated discoveries per paid experiment, on the discovery benchmark's hidden-rule
worlds (TRAIN seeds), times a truth-rate factor from world H. HARD CONSTRAINTS, not penalties:
  - the NULL world (drift, no hidden rule) must yield ZERO discoveries. A policy that
    "discovers" in noise scores 0.0 outright -- the same D4 rule the benchmark pre-registered.
  - world H truth-over-proxy must stay >= 0.70 (its pre-registered INCONCLUSIVE floor).
A policy that games the headline by breaking a control gets nothing. This is where evolving
against our evaluator differs from evolving against a naive score.

SEED DISCIPLINE. Evolution sees TRAIN seeds only. The final best-vs-baseline verdict is taken
once, on disjoint HOLDOUT seeds (`python evaluator.py <policy.py> --holdout`), because a policy
evolved on seeds 0..N is fitted to them by construction.

SAFETY (heuristic, not a sandbox): mutated code is rejected before import if it references
imports beyond math, file/network/process access, or randomness. This screens the obvious, and
the run stays on this machine under the operator's account either way.

Known scope limits, stated: TRAIN uses small seed counts so an evaluation stays ~30s; the
benchmark's relmem/memory arms are not exercised (one-shot policy only); world H's H4 regression
control is covered by the discovery worlds themselves (same hidden-variable family).
"""

import importlib.util
import json
import os
import re
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_EC = os.path.abspath(os.path.join(_HERE, "..", "epistemic_controller"))
if _EC not in sys.path:
    sys.path.insert(0, _EC)

from controller import Controller, Evidence  # noqa: E402
from run_world_h import HoldController  # noqa: E402
from run_discovery_benchmark import SequenceWorld, count_experiments, validated, EPISODES  # noqa: E402
from environments.two_explanations import TwoExplanationsWorld  # noqa: E402
from agents.explorer import Explorer  # noqa: E402

TRAIN_BENCH_SEEDS = list(range(12))
TRAIN_H_SEEDS = list(range(30))
HOLDOUT_BENCH_SEEDS = list(range(200, 230))
HOLDOUT_H_SEEDS = list(range(300, 360))

FORBIDDEN = re.compile(
    r"\b(import\s+(?!math\b)\w|from\s+(?!math\b)\w+\s+import|open\s*\(|exec\s*\(|eval\s*\(|"
    r"__import__|os\.|sys\.|subprocess|socket|random|urllib|requests|pathlib|shutil)"
)


def load_policy(program_path):
    src = open(program_path, "r", encoding="utf-8").read()
    body = re.sub(r'^\s*(""".*?"""|import\s+math\s*)', "", src, flags=re.S)  # docstring/math exempt
    m = FORBIDDEN.search(body)
    if m:
        raise ValueError(f"forbidden construct in policy: {m.group(0)!r}")
    spec = importlib.util.spec_from_file_location("evolved_policy", program_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for name in ("RETRACT_BELOW", "EARLY_ACCEPT", "HOLD_STEPS", "candidate_utility", "probe_order"):
        if not hasattr(mod, name):
            raise ValueError(f"policy missing {name}")
    if not (0.5 < float(mod.RETRACT_BELOW) < 0.999):
        raise ValueError("RETRACT_BELOW out of range")
    if not (0.5 < float(mod.EARLY_ACCEPT) <= 1.0):
        raise ValueError("EARLY_ACCEPT out of range")
    if not (0 <= int(mod.HOLD_STEPS) <= 200):
        raise ValueError("HOLD_STEPS out of range")
    return mod


def make_controller(policy, world):
    """HoldController with the DESIGN policy swapped for the evolved one. The probe/refit
    machinery is transcribed from controller._design so the evolved surface is ONLY the policy:
    utility, probe order, early-accept bar, retraction bar, hold length."""

    class PolicyController(HoldController):
        def __init__(self, w, **kw):
            super().__init__(w, hold_steps=int(policy.HOLD_STEPS), **kw)
            self.retract_below = float(policy.RETRACT_BELOW)

        def _probe_order(self):
            base = super()._probe_order()          # keeps the rejected-candidate exclusion
            try:
                ordered = policy.probe_order(list(base))
                names = {n for n, _ in base}
                ordered = [kv for kv in ordered if kv[0] in names]
                return ordered if len(ordered) == len(base) else base
            except Exception:
                return base

        def _design(self, resid):
            n = len(resid)
            scored = []
            for name, cost in self._probe_order():
                probe = self.world.measure(name, n)
                self.spent += cost * 0.25
                self.probes_paid += 1
                v = np.array(probe["values"])
                X = np.column_stack([np.ones(n), np.array(self.xs[-n:]), v])
                beta, *_ = np.linalg.lstsq(X, resid, rcond=None)
                r2 = 1 - np.var(resid - X @ beta) / max(np.var(resid), 1e-12)
                try:
                    util = float(policy.candidate_utility(float(max(0.0, r2)), float(cost),
                                                          float(self.spent), float(self.budget)))
                except Exception:
                    util = 0.0
                if not np.isfinite(util):
                    util = 0.0
                scored.append({"name": name, "cost": cost, "explained": float(max(0.0, r2)),
                               "utility": util})
                if r2 >= float(policy.EARLY_ACCEPT):
                    break
            scored.sort(key=lambda s: -s["utility"])
            return scored

    return PolicyController(world)


def run_bench(policy, seeds, null=False):
    disc = false_disc = experiments = 0
    for seed in seeds:
        sw = SequenceWorld(seed, null=null)
        for k in range(EPISODES):
            w = sw.episodes[k]
            c = make_controller(policy, w)
            c.run()
            experiments += count_experiments(c)
            ok, _why = validated(c, w)
            if null:
                if c.A.features[1:]:
                    false_disc += 1
            elif ok:
                disc += 1
            elif c.A.features[1:]:
                false_disc += 1
    return {"discoveries": disc, "false": false_disc, "experiments": experiments,
            "per_experiment": (disc / experiments) if experiments else 0.0}


def run_world_h(policy, seeds):
    t = p = 0
    for seed in seeds:
        w = TwoExplanationsWorld(seed)
        c = make_controller(policy, w)
        r = c.run()
        tr = w.truth()
        feats = r["features"][1:]
        committed = feats[-1] if feats else None
        if committed == tr["true_z"]:
            t += 1
        elif committed == tr.get("proxy_z"):
            p += 1
    return {"chose_true": t, "chose_proxy": p, "truth_rate": t / max(1, t + p)}


def _evaluate(program_path, bench_seeds, h_seeds):
    policy = load_policy(program_path)
    bench = run_bench(policy, bench_seeds)
    null = run_bench(policy, bench_seeds, null=True)
    wh = run_world_h(policy, h_seeds)
    null_clean = null["discoveries"] == 0 and null["false"] == 0
    truth_ok = wh["truth_rate"] >= 0.70
    # Fitness: per-experiment discovery rate, scaled by truth rate so a proxy-buying policy
    # cannot win on volume. Controls are hard zeros, not penalties.
    combined = bench["per_experiment"] * wh["truth_rate"] if (null_clean and truth_ok) else 0.0
    return {
        "combined_score": float(combined),
        "per_experiment": float(bench["per_experiment"]),
        "discoveries": float(bench["discoveries"]),
        "false_discoveries": float(bench["false"]),
        "experiments": float(bench["experiments"]),
        "null_discoveries": float(null["discoveries"] + null["false"]),
        "worldh_truth_rate": float(wh["truth_rate"]),
        "control_null_clean": float(null_clean),
        "control_truth_ok": float(truth_ok),
    }


def evaluate(program_path):
    try:
        return _evaluate(program_path, TRAIN_BENCH_SEEDS, TRAIN_H_SEEDS)
    except Exception as e:
        return {"combined_score": 0.0, "error": 1.0, "error_msg": str(e)[:200]}


if __name__ == "__main__":
    path = sys.argv[1]
    holdout = "--holdout" in sys.argv
    seeds = (HOLDOUT_BENCH_SEEDS, HOLDOUT_H_SEEDS) if holdout else (TRAIN_BENCH_SEEDS, TRAIN_H_SEEDS)
    out = _evaluate(path, *seeds)
    out["seed_set"] = "HOLDOUT" if holdout else "TRAIN"
    print(json.dumps(out, indent=2))
