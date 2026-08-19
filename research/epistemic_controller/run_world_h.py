"""World H -- two explanations fit equally. The kill test for retraction-by-remedy-failure.

The hidden-variable result (run_mvp.py) could be a trick: retraction works there because exactly
one candidate explains the residual, so "nothing explains it" vs "something explains it" is a
clean split. World H offers TWO candidates that both explain it -- the true cause and a cheaper
noisy proxy of it -- so the retraction bar is cleared by both and retraction is BLIND. If the
controller picks the proxy as often as the truth, the mechanism was a hidden-variable trick and
the AUDITED-CANDIDATE status is withdrawn.

PRE-REGISTERED GATES (written before the first run; thresholds not moved after):
  H1  the controller still enters BOUNDARY and expands (the detector side is unaffected)
  H2  KILL TEST: it commits to the TRUE cause over the proxy at a rate meaningfully above the
      50% a coin would give between the two explainers. Bar: >= 70%.
      If < 55% -> KILLED: "retraction by remedy-failure" cannot tell two explanations apart and
      the earlier result was a one-explainer artifact.
  H3  when it does commit to the proxy, final MSE is WORSE than when it commits to the truth
      (i.e. the proxy really is a worse explanation -- the world is adversarial as designed, not
      a world where the proxy is just as good, which would make H2 meaningless).
  H4  CONTROL: the original hidden-variable world, same controller, still passes P3 >= 80% --
      so any H2 failure is attributable to the two-explanations structure, not a regression.

Two controller variants are run, because the honest question is WHAT mechanism (if any) handles
a tie, and the answer should be measured, not assumed:
  commit      the shipped controller: pick max utility, expand, done (RESOLVED)
  hold        same controller, but EXPAND is held as a hypothesis: after expanding it keeps
              scoring the expansion on NEW data for `hold_steps` steps; if the expanded model's
              residual re-structures (the proxy's imperfect agreement shows up as new structure),
              it drops the observable and returns to DESIGN with that candidate excluded.
              This is "retraction" applied to the EXPANSION, not only to the BOUNDARY call --
              the same principle one level further.
If `commit` fails H2 and `hold` passes it, the principle survives and the shipped controller was
incomplete. If BOTH fail, the principle is killed.

Run:  python research/epistemic_controller/run_world_h.py 200
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from controller import Controller, BOUNDARY, DESIGN, EXPAND, RESOLVED, Evidence   # noqa: E402
from environments.two_explanations import TwoExplanationsWorld                   # noqa: E402
from environments.hidden_variable import HiddenVariableWorld                     # noqa: E402
from agents.explorer import Explorer                                             # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "results", "world_h.json")


class HoldController(Controller):
    """The shipped controller + one rule: an EXPANSION is a hypothesis too. After expanding,
    keep scoring the expanded model on fresh data; if its residual re-structures, the chosen
    observable was a proxy -- drop it, exclude it, choose again."""

    def __init__(self, world, *, hold_steps=40, **kw):
        super().__init__(world, **kw)
        self.hold_steps = hold_steps
        self._hold_left = 0
        self._excluded = set()
        self.expansions_dropped = 0

    def _design(self, resid):
        scored = super()._design(resid)
        return [s for s in scored if s["name"] not in self._excluded] or scored

    def run(self):
        out = super().run()
        out["expansions_dropped"] = self.expansions_dropped   # parent run() does not know this field
        return out

    def step(self):
        # Run the parent machine; then, if we are RESOLVED and still in the hold window, re-check.
        alive = super().step()
        if not alive:
            return False
        if self.state == RESOLVED and self.A.features[1:]:
            if self._hold_left == 0 and not getattr(self, "_held_once", False):
                self._hold_left = self.hold_steps
                self._held_once = True
            if self._hold_left > 0:
                self._hold_left -= 1
                resid = self._window_residuals()
                if resid is not None and len(self.xs) % 5 == 0:
                    verdict = self.B.judge(resid)
                    mse = float(np.mean(resid ** 2))
                    # re-structured AND not at the noise floor -> the expansion did not hold
                    if verdict["structured"] and mse > self.mse_k * self.baseline_mse:
                        bad = self.A.features[-1]
                        eid = self.ev.add("expansion_dropped", t=len(self.xs), dropped=bad, mse=mse, **verdict)
                        self.expansions_dropped += 1
                        self._excluded.add(bad)
                        self.extra.pop(bad, None)
                        self.A = Explorer(features=[f for f in self.A.features if f != bad])
                        self._held_once = False
                        self._hold_left = 0
                        self._go(DESIGN, [eid], f"expansion on {bad} re-structured on fresh data; dropped and excluded")
        return True


def run_arm(make_world, ctrl_cls, seeds):
    rows = []
    for s in seeds:
        w = make_world(s); tr = w.truth(); r = ctrl_cls(w).run()
        feats = r["features"][1:]
        committed = feats[-1] if feats else None
        rows.append({"seed": s, "true": tr["true_z"], "proxy": tr.get("proxy_z"),
                     "committed": committed, "entered_boundary": r["entered_boundary"],
                     "final_state": r["final_state"], "final_mse": r["final_mse"],
                     "chose_true": committed == tr["true_z"], "chose_proxy": committed == tr.get("proxy_z"),
                     "dropped": r.get("expansions_dropped", 0) if isinstance(r, dict) else 0,
                     "noise": tr["noise"]})
    return rows


def summarize(name, rows):
    n = len(rows)
    eb = np.mean([x["entered_boundary"] for x in rows])
    expanded = [x for x in rows if x["committed"]]
    t = sum(x["chose_true"] for x in expanded); p = sum(x["chose_proxy"] for x in expanded)
    among = t / max(1, t + p)                      # truth vs proxy, among those that picked one of the two
    mse_t = np.mean([x["final_mse"] for x in expanded if x["chose_true"]]) if t else None
    mse_p = np.mean([x["final_mse"] for x in expanded if x["chose_proxy"]]) if p else None
    return {"arm": name, "n": n, "entered_boundary": round(float(eb), 3), "expanded": len(expanded),
            "chose_true": t, "chose_proxy": p, "other": len(expanded) - t - p,
            "truth_rate_among_two": round(float(among), 3),
            "final_mse_when_true": None if mse_t is None else round(float(mse_t), 3),
            "final_mse_when_proxy": None if mse_p is None else round(float(mse_p), 3)}


def main(n_seeds=200):
    seeds = list(range(n_seeds))
    print(f"=== WORLD H: two explanations fit equally -- {n_seeds} seeds ===")
    print("truth z vs a cheaper proxy that agrees with z 85% of the time; both clear the retraction bar\n")
    arms = {}
    arms["commit"] = summarize("commit (shipped)", run_arm(lambda s: TwoExplanationsWorld(s), Controller, seeds))
    arms["hold"] = summarize("hold (expansion is a hypothesis)", run_arm(lambda s: TwoExplanationsWorld(s), HoldController, seeds))
    # H4 control: the original world, both controllers -- must not regress
    ctrl_commit = run_arm(lambda s: HiddenVariableWorld(s), Controller, seeds[:100])
    ctrl_hold = run_arm(lambda s: HiddenVariableWorld(s), HoldController, seeds[:100])
    ctrlP3 = {"commit": float(np.mean([x["chose_true"] for x in ctrl_commit])),
              "hold": float(np.mean([x["chose_true"] for x in ctrl_hold]))}

    print(f"{'arm':36} {'BOUNDARY':>9} {'expanded':>9} {'truth':>6} {'proxy':>6} {'truth%':>7} {'mse|truth':>10} {'mse|proxy':>10}")
    for k, a in arms.items():
        print(f"{a['arm']:36} {100*a['entered_boundary']:>8.0f}% {a['expanded']:>9} {a['chose_true']:>6} {a['chose_proxy']:>6} "
              f"{100*a['truth_rate_among_two']:>6.0f}% {str(a['final_mse_when_true']):>10} {str(a['final_mse_when_proxy']):>10}")
    print(f"\nH4 control (original hidden-variable world, P3 chose-true): commit {100*ctrlP3['commit']:.0f}%  hold {100*ctrlP3['hold']:.0f}%")

    gates = {}
    for k, a in arms.items():
        h1 = a["entered_boundary"] >= 0.8
        r = a["truth_rate_among_two"]
        h2 = "PASS" if r >= 0.70 else ("KILLED" if r < 0.55 else "INCONCLUSIVE")
        h3 = (a["final_mse_when_proxy"] is None or a["final_mse_when_true"] is None) or a["final_mse_when_proxy"] > a["final_mse_when_true"]
        gates[k] = {"H1_enters_and_expands": h1, "H2_truth_over_proxy": h2, "truth_rate": r,
                    "H3_proxy_is_really_worse": bool(h3), "H4_control_P3": round(ctrlP3[k], 3),
                    "H4_pass": ctrlP3[k] >= 0.8}
    commit_dead = gates["commit"]["H2_truth_over_proxy"] == "KILLED"
    hold_ok = gates["hold"]["H2_truth_over_proxy"] == "PASS" and gates["hold"]["H4_pass"]
    verdict = ("PRINCIPLE SURVIVES, SHIPPED CONTROLLER INCOMPLETE — committing on the first window cannot "
               "separate two explainers; holding the expansion as a hypothesis can"
               if (commit_dead or gates["commit"]["H2_truth_over_proxy"] != "PASS") and hold_ok else
               "BOTH PASS — even one-shot commit separates them (the world is not adversarial enough)"
               if gates["commit"]["H2_truth_over_proxy"] == "PASS" and hold_ok else
               "KILLED — neither variant separates two explanations; retraction-by-remedy-failure is a one-explainer trick"
               if commit_dead and gates["hold"]["H2_truth_over_proxy"] == "KILLED" else
               "PARTIAL — see gates")
    out = {"n_seeds": n_seeds, "arms": arms, "gates": gates, "verdict": verdict}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, default=float)
    print("\nGATES:")
    for k, g in gates.items():
        print(f"  {k:8} {json.dumps(g)}")
    print(f"\nVERDICT: {verdict}")
    print("->", OUT)


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 200)
