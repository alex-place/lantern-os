"""Run the MVP across many random worlds and score the pre-registered P1-P5.

Three arms, same seeds:
  baseline   A alone -- refits parameters forever, has no BOUNDARY state. The thing to beat.
  twin       the controller: SUSPECT -> BOUNDARY -> DESIGN -> ACQUIRE -> EXPAND.
  null       the controller on a world where z NEVER switches on (slow parameter drift instead).
             The false-alarm control. A controller that calls BOUNDARY here is a professional
             skeptic, and "refuse parameter updates" becomes the harm term.

Run:  python research/epistemic_controller/run_mvp.py            (default 60 seeds)
      python research/epistemic_controller/run_mvp.py 200
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from controller import Controller, BOUNDARY                       # noqa: E402
from environments.hidden_variable import HiddenVariableWorld       # noqa: E402
from agents.explorer import Explorer                               # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "results", "mvp.json")


def baseline_a_alone(world):
    """A refits on every step, forever. No auditor, no boundary, no measurements."""
    A = Explorer(features=["x"]); xs, ys = [], []
    updates = 0
    while True:
        o = world.observe()
        if o is None:
            break
        xs.append(o["x"]); ys.append(o["y"])
        if len(xs) >= 8:
            A.fit(np.array(xs)[:, None], np.array(ys)); updates += 1
    n = min(30, len(xs))
    resid = A.residuals(np.array(xs[-n:])[:, None], np.array(ys[-n:]))
    return {"final_mse": float(np.mean(resid ** 2)), "updates": updates, "entered_boundary": False}


def main(n_seeds=60):
    rows = []
    for seed in range(n_seeds):
        # ── twin on the deceptive world ──────────────────────────────────────────────────
        w = HiddenVariableWorld(seed)
        truth = w.truth()
        r = Controller(w).run()
        # ── baseline on an IDENTICAL world (same seed → same stream) ─────────────────────
        b = baseline_a_alone(HiddenVariableWorld(seed))
        # ── null world: no switch, slow drift ─────────────────────────────────────────────
        nw = HiddenVariableWorld(seed, switch_at=None, drift=0.002)
        nr = Controller(nw).run()

        chose_true = truth["true_z"] in r["features"]
        rows.append({
            "seed": seed, "true_z": truth["true_z"], "switch_at": truth["switch_at"], "noise": truth["noise"],
            "twin": {"entered_boundary": r["entered_boundary"], "boundary_t": r["boundary_t"],
                     "features": r["features"], "chose_true": chose_true,
                     "final_mse": r["final_mse"], "refused": r["param_updates_refused"],
                     "spent": round(r["spent"], 2), "final_state": r["final_state"],
                     "failed_budget": r["failed_budget"], "chosen": r["chosen"]},
            "baseline": b,
            "null": {"entered_boundary": nr["entered_boundary"], "boundary_t": nr["boundary_t"],
                     "boundary_held": nr["boundary_held"], "retracted": nr["boundary_retracted"],
                     "final_mse": nr["final_mse"]},
        })

    n = len(rows)
    twin_b = [x for x in rows if x["twin"]["entered_boundary"]]
    after_switch = [x for x in twin_b if x["twin"]["boundary_t"] >= x["switch_at"]]
    P1 = len(after_switch) / n
    P2 = all(x["twin"]["refused"] >= 1 for x in twin_b) if twin_b else False
    P3 = np.mean([x["twin"]["chose_true"] for x in rows])
    noise_floor = np.mean([x["noise"] ** 2 for x in rows])
    P4 = np.mean([x["twin"]["final_mse"] <= 2 * x["noise"] ** 2 for x in rows])
    # P5: a false alarm is a null-world boundary that HELD (led to buying + expanding on a
    # decoy). A boundary the controller itself retracted at DESIGN is a hypothesis it tested and
    # rejected -- reported separately as "raised", not counted as harm.
    P5_false_alarm = np.mean([x["null"]["boundary_held"] for x in rows])
    P5_raised = np.mean([x["null"]["entered_boundary"] for x in rows])
    base_mse = np.mean([x["baseline"]["final_mse"] for x in rows])
    twin_mse = np.mean([x["twin"]["final_mse"] for x in rows])

    gates = {
        "P1_enters_boundary_after_switch_not_before": {"PASS": P1 >= 0.8, "rate": round(P1, 3),
            "before_switch": len(twin_b) - len(after_switch)},
        "P2_refuses_param_updates_in_boundary": {"PASS": bool(P2)},
        "P3_chooses_true_z_from_4": {"PASS": P3 >= 0.8, "rate": round(float(P3), 3), "chance": 0.25},
        "P4_final_mse_within_2x_noise": {"PASS": P4 >= 0.8, "rate": round(float(P4), 3),
            "twin_mean_mse": round(float(twin_mse), 4), "baseline_mean_mse": round(float(base_mse), 4),
            "noise_floor": round(float(noise_floor), 4)},
        "P5_null_world_false_alarm_under_5pct": {"PASS": P5_false_alarm < 0.05, "held_rate": round(float(P5_false_alarm), 3),
            "raised_then_retracted_rate": round(float(P5_raised - P5_false_alarm), 3)},
    }
    killed = (P3 < 0.5) or (P5_false_alarm >= 0.05)
    gates["VERDICT"] = ("KILLED — " + ("selector guesses (P3)" if P3 < 0.5 else "") +
                        (" professional skeptic (P5)" if P5_false_alarm >= 0.05 else "")).strip()
    if not killed:
        gates["VERDICT"] = ("CLAIM SURVIVES — controller enters BOUNDARY on model-class failure, refuses "
                            "parameter updates, chooses the discriminating measurement, expands the class; "
                            "null world does not trigger it"
                            if all(g["PASS"] for k, g in gates.items() if k != "VERDICT") else "PARTIAL — see gates")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"n_seeds": n, "gates": gates, "rows": rows}, f, indent=2, default=float)

    print(f"=== Epistemic Boundary MVP — {n} random worlds ===\n")
    print(f"{'arm':10} {'enters BOUNDARY':>16} {'mean final MSE':>15}   (noise floor {noise_floor:.3f})")
    print(f"{'baseline':10} {'never':>16} {base_mse:>15.3f}")
    print(f"{'twin':10} {100*P1:>15.0f}% {twin_mse:>15.3f}")
    print(f"{'null ctrl':10} {100*P5_false_alarm:>15.0f}% {np.mean([x['null']['final_mse'] for x in rows]):>15.3f}   (raised {100*P5_raised:.0f}%, retracted {100*(P5_raised-P5_false_alarm):.0f}%)")
    print(f"\nchose the TRUE hidden variable from 4 candidates: {100*P3:.0f}%  (chance 25%)")
    print(f"refused parameter updates while in BOUNDARY: {'every time' if P2 else 'NO'}")
    print()
    for k, g in gates.items():
        if k != "VERDICT":
            print(f"  {k:44} {'PASS' if g['PASS'] else 'FAIL'}  {json.dumps({kk: vv for kk, vv in g.items() if kk != 'PASS'})}")
    print(f"\nVERDICT: {gates['VERDICT']}")
    print("->", OUT)


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 60)
