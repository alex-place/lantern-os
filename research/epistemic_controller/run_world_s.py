"""World S -- the SELF experiment. Can the scientist diagnose a defect in its own experiment-
selection policy from the pattern of its own mistakes, test a repair on itself, and keep it only
if it pays -- while staying silent when its failures have a different cause?

THE SETUP. A sequence of EPISODES of world H (truth z vs a CHEAPER proxy that agrees with it 85%
of the time). The shipped selection policy utility = explained / cost is biased toward the proxy.
The hold controller corrects the mistake inside each episode (proxy fails to hold -> dropped ->
truth bought) but pays for the same mistake every episode: it repairs its world-model, never its
policy. The self-model (self_model.py) watches the drops, diagnoses "cost-patterned", proposes a
repair to the policy (cost exponent 1 -> 0.5 -> 0), runs the next two episodes as a TRIAL, keeps
the repair only if the drop rate fell, reverts otherwise.

Truth/proxy slots are re-randomised EVERY episode, so nothing about NAMES carries over. The only
thing the machine can learn across episodes here is something about ITSELF.

ARMS
  hold        HoldController fresh per episode, policy fixed. The scientist that fixes mistakes
              but never learns from them.
  self        policy owned by a persistent SelfModel reading its MISTAKE LEDGER (killed 2026-08-19:
              specific but silent).
  self-loose  the same, with the loose cost reference (loud but wrong: fires on both controls).
  self-cf     policy owned by a SelfModel doing COUNTERFACTUAL replay -- at every DESIGN round
              already paid for, would a different cost exponent have picked the observable that
              survived? Paired, discordant rounds only. Same gates, same thresholds.

CONTROLS (self arm; the question is FALSE firing)
  C1  hidden-variable world sequence (no proxy at all): drops should be rare; the self-model
      must not touch the policy.
  C2  hidden-variable world with a LEVEL-SHIFT BURST after the expansion (b jumps +2 for 40
      steps). The truth is expanded, the burst re-structures the residual, the hold drops the
      truth WRONGLY. Failures exist -- but their cause is the world moving, not the cost policy,
      and the dropped candidate is not cheaper than any survivor. The self-model must say "not
      cost-patterned" and leave the policy alone. This is the control that separates a diagnosis
      from a reflex.

PRE-REGISTERED GATES (written before the first run; thresholds not moved after)
  S1  BASELINE DOES NOT LEARN: `hold` proxy-acquired rate in episodes 4-6 is within 10 points of
      episodes 1-3.
  S2  SELF LEARNS: `self` proxy-acquired rate in episodes 4-6 is <= 50% of its rate in episodes
      1-3 (relative halving), AND repairs kept > repairs reverted.
  S3  DIAGNOSIS IS SPECIFIC: the self-model changes cost_exponent in < 10% of seeds in C1 and in
      < 10% of seeds in C2.
  S4  IT PAYS: `self` experiments per validated discovery in episodes 4-6 is at least 10% lower
      than `hold`'s.
  KILL  S2 fails -> self-diagnosis from the mistake ledger does not work; S3 fails -> it fires
      without cause and is a reflex, not a diagnosis -- either way the SELF experiment is killed.

Run:  python research/epistemic_controller/run_world_s.py 100
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from run_world_h import HoldController                            # noqa: E402
from environments.two_explanations import TwoExplanationsWorld    # noqa: E402
from environments.hidden_variable import HiddenVariableWorld      # noqa: E402
from self_model import SelfModel                                  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "results",
                   "world_s.json" if int(os.environ.get("WORLD_S_EPISODES") or 6) == 6
                   else f"world_s_e{os.environ['WORLD_S_EPISODES']}.json")
# Episodes per seed. 6 is the PRE-REGISTERED setting and the one the recorded kill was run at.
# It is env-overridable because the 6-episode result turned out to be evidence-budget-bound, not
# mechanism-bound: the repair itself works (cost_exponent 1 -> 0 cuts proxy purchases from 17/100
# to 3/100 on world H), but a single scientist rarely sees enough discordant rounds in 6 episodes
# to justify making it. Running longer is a DIFFERENT experiment, reported separately -- the gates
# and their thresholds are unchanged.
EPISODES = int(os.environ.get("WORLD_S_EPISODES") or 6)
EARLY, LATE = (0, EPISODES // 2), (EPISODES // 2, EPISODES)


class ShiftBurstWorld(HiddenVariableWorld):
    """Hidden-variable world whose intercept jumps for a while after the switch. The truth is
    still the truth; the world just moved. A controller that blames its last expansion for this
    is wrong, and a self-model that blames its cost policy is doubly wrong."""

    def __init__(self, seed, *, burst_at=160, burst_len=40, burst=2.0, **kw):
        super().__init__(seed, **kw)
        self.burst_at, self.burst_len, self.burst = burst_at, burst_len, burst

    def observe(self):
        obs = super().observe()
        if obs is None:
            return None
        if self.burst_at <= obs["t"] < self.burst_at + self.burst_len:
            obs["y"] += self.burst
            x, z, y = self._history[-1]
            self._history[-1] = (x, z, y + self.burst)
        return obs


def make_world(kind, seed, k):
    s = seed * 100 + k
    if kind == "H":
        return TwoExplanationsWorld(s)
    if kind == "C1":
        return HiddenVariableWorld(s, n_steps=400)
    if kind == "C2":
        return ShiftBurstWorld(s, n_steps=400)
    raise ValueError(kind)


def count_experiments(ctrl):
    return ctrl.probes_paid + sum(1 for e in ctrl.ev.rows if e["kind"] == "measurement")


def validated(ctrl, world):
    tz = world.truth()["true_z"]
    if tz not in ctrl.A.features:
        return False
    exp = [e for e in ctrl.ev.rows if e["kind"] == "expansion" and tz in e.get("features", [])]
    if not exp or exp[-1].get("structured", True):
        return False
    resid = ctrl._window_residuals()
    return resid is not None and float(np.mean(resid ** 2)) <= 2 * world.truth()["noise"] ** 2


def run_seed(seed, arm, kind="H"):
    sm = (SelfModel(cost_reference="median") if arm == "self-loose"
          else SelfModel(mode="counterfactual") if arm == "self-cf"
          else SelfModel() if arm == "self" else None)
    eps = []
    for k in range(EPISODES):
        w = make_world(kind, seed, k)
        c = HoldController(w)
        if sm:
            sm.configure(c)
        c.run()
        tr = w.truth()
        acquired = [e["name"] for e in c.ev.rows if e["kind"] == "measurement"]
        proxy = tr.get("proxy_z")
        eps.append({"k": k, "proxy_acquired": proxy is not None and proxy in acquired,
                    "drops": sum(1 for e in c.ev.rows if e["kind"] in ("expansion_dropped", "expansion_rejected")),
                    "validated": validated(c, w), "experiments": count_experiments(c),
                    "cost_exponent": c.cost_exponent})
        if sm:
            sm.observe_episode(c, w)
    return {"seed": seed, "episodes": eps, "self": sm.snapshot() if sm else None}


def rate(rows, key, span):
    vals = [e[key] for r in rows for e in r["episodes"][span[0]:span[1]]]
    return float(np.mean(vals)) if vals else 0.0


def per_discovery(rows, span):
    d = sum(e["validated"] for r in rows for e in r["episodes"][span[0]:span[1]])
    x = sum(e["experiments"] for r in rows for e in r["episodes"][span[0]:span[1]])
    return (x / d) if d else float("inf")


def main(n_seeds=100):
    seeds = range(n_seeds)
    print(f"=== WORLD S: the self experiment -- {n_seeds} seeds x {EPISODES} episodes of world H ===")
    print(f"    early window = episodes 1-{EARLY[1]}, late window = episodes {LATE[0]+1}-{LATE[1]}")
    print()
    hold = [run_seed(s, "hold") for s in seeds]
    selfa = [run_seed(s, "self") for s in seeds]
    loose = [run_seed(s, "self-loose") for s in seeds]
    cf = [run_seed(s, "self-cf") for s in seeds]
    c1 = [run_seed(s, "self", "C1") for s in seeds]
    c2 = [run_seed(s, "self", "C2") for s in seeds]
    c1L = [run_seed(s, "self-loose", "C1") for s in seeds]
    c2L = [run_seed(s, "self-loose", "C2") for s in seeds]
    c1F = [run_seed(s, "self-cf", "C1") for s in seeds]
    c2F = [run_seed(s, "self-cf", "C2") for s in seeds]

    def block(rows):
        return {"proxy_early": rate(rows, "proxy_acquired", EARLY), "proxy_late": rate(rows, "proxy_acquired", LATE),
                "drops_early": rate(rows, "drops", EARLY), "drops_late": rate(rows, "drops", LATE),
                "exp_per_disc_early": per_discovery(rows, EARLY), "exp_per_disc_late": per_discovery(rows, LATE),
                "validated_late": rate(rows, "validated", LATE)}

    H = {"hold": block(hold), "self": block(selfa), "self-loose": block(loose), "self-cf": block(cf)}
    print(f"{'arm':6} {'proxy ep1-3':>12} {'proxy ep4-6':>12} {'drops/ep 1-3':>13} {'drops/ep 4-6':>13} {'exp/disc 1-3':>13} {'exp/disc 4-6':>13}")
    for a, b in H.items():
        print(f"{a:6} {100*b['proxy_early']:>11.0f}% {100*b['proxy_late']:>11.0f}% {b['drops_early']:>13.2f} {b['drops_late']:>13.2f} "
              f"{b['exp_per_disc_early']:>13.2f} {b['exp_per_disc_late']:>13.2f}")

    def fired(rows):
        return float(np.mean([r["self"]["cost_exponent"] != 1.0 for r in rows]))
    kept = sum(r["self"]["repairs_kept"] for r in selfa); rev = sum(r["self"]["repairs_reverted"] for r in selfa)
    nulls = sum(r["self"]["null_diagnoses"] for r in selfa)
    final_e = [r["self"]["cost_exponent"] for r in selfa]
    dist = {float(k): int(v) for k, v in zip(*np.unique(final_e, return_counts=True))}
    print()
    print(f"self arm: repairs kept {kept}, reverted {rev}, null diagnoses {nulls}; final cost_exponent distribution {dist}")
    c1_drops = rate(c1, "drops", (0, EPISODES)); c2_drops = rate(c2, "drops", (0, EPISODES))
    c1_nulls = sum(r["self"]["null_diagnoses"] for r in c1); c2_nulls = sum(r["self"]["null_diagnoses"] for r in c2)
    keptL = sum(r["self"]["repairs_kept"] for r in loose); revL = sum(r["self"]["repairs_reverted"] for r in loose)
    keptF = sum(r["self"]["repairs_kept"] for r in cf); revF = sum(r["self"]["repairs_reverted"] for r in cf)
    usable = sum(r["self"]["rounds_usable"] for r in cf); seen = sum(r["self"]["rounds_seen"] for r in cf)
    disc = sum(sum(v) for r in cf for v in r["self"]["discordant_pairs"].values())
    print(f"self-cf (counterfactual replay): repairs kept {keptF}, reverted {revF}; "
          f"DESIGN rounds usable {usable}/{seen}, discordant pairs {disc}")
    print(f"self-loose (cost reference = median): repairs kept {keptL}, reverted {revL}")
    print(f"C1 (no proxy):      drops/ep {c1_drops:.2f}  policy changed in {100*fired(c1):.0f}% (ledger) / "
          f"{100*fired(c1L):.0f}% (loose) / {100*fired(c1F):.0f}% (counterfactual)  null-diagnoses {c1_nulls}")
    print(f"C2 (shift burst):   drops/ep {c2_drops:.2f}  policy changed in {100*fired(c2):.0f}% (ledger) / "
          f"{100*fired(c2L):.0f}% (loose) / {100*fired(c2F):.0f}% (counterfactual)  null-diagnoses {c2_nulls}")

    S1 = abs(H["hold"]["proxy_late"] - H["hold"]["proxy_early"]) <= 0.10
    S2 = (H["self"]["proxy_late"] <= 0.5 * H["self"]["proxy_early"]) and kept > rev
    S3 = fired(c1) < 0.10 and fired(c2) < 0.10
    S3L = fired(c1L) < 0.10 and fired(c2L) < 0.10
    S2L = (H["self-loose"]["proxy_late"] <= 0.5 * H["self-loose"]["proxy_early"]) and keptL > revL
    S3F = fired(c1F) < 0.10 and fired(c2F) < 0.10
    S2F = (H["self-cf"]["proxy_late"] <= 0.5 * H["self-cf"]["proxy_early"]) and keptF > revF
    S4F = H["self-cf"]["exp_per_disc_late"] <= 0.90 * H["hold"]["exp_per_disc_late"]
    S4 = H["self"]["exp_per_disc_late"] <= 0.90 * H["hold"]["exp_per_disc_late"]
    gates = {"S1_baseline_does_not_learn": {"PASS": bool(S1), "hold_early": H["hold"]["proxy_early"], "hold_late": H["hold"]["proxy_late"]},
             "S2_self_learns": {"PASS": bool(S2), "self_early": H["self"]["proxy_early"], "self_late": H["self"]["proxy_late"],
                                "kept": kept, "reverted": rev},
             "S3_diagnosis_specific": {"PASS": bool(S3), "C1_fired": fired(c1), "C2_fired": fired(c2),
                                       "C2_drops_per_episode": c2_drops, "C2_null_diagnoses": c2_nulls},
             "S2_S3_S4_counterfactual": {"S2_PASS": bool(S2F), "S3_PASS": bool(S3F), "S4_PASS": bool(S4F),
                                        "kept": keptF, "reverted": revF,
                                        "self_early": H["self-cf"]["proxy_early"], "self_late": H["self-cf"]["proxy_late"],
                                        "C1_fired": fired(c1F), "C2_fired": fired(c2F),
                                        "rounds_usable": usable, "rounds_seen": seen, "discordant_pairs": disc,
                                        "exp_per_disc_late": H["self-cf"]["exp_per_disc_late"],
                                        "hold_exp_per_disc_late": H["hold"]["exp_per_disc_late"]},
             "S2_S3_loose_variant": {"S2_PASS": bool(S2L), "S3_PASS": bool(S3L), "kept": keptL, "reverted": revL,
                                     "C1_fired": fired(c1L), "C2_fired": fired(c2L),
                                     "note": "cost reference = median: fires 2x more often and fires on BOTH controls"},
             "S4_it_pays": {"PASS": bool(S4), "hold_late": H["hold"]["exp_per_disc_late"], "self_late": H["self"]["exp_per_disc_late"],
                            "saving_pct": round(100 * (1 - H["self"]["exp_per_disc_late"] / H["hold"]["exp_per_disc_late"]), 1)}}
    verdict = ("SELF EXPERIMENT STANDS via COUNTERFACTUAL REPLAY" if S2F and S3F else
               "SELF EXPERIMENT STANDS" if S2 and S3 else
               "KILLED: self-diagnosis fires without cause (reflex, not diagnosis)" if S2 and not S3 else
               "KILLED: the mistake ledger does not let the scientist repair its own policy" if not S2 else "PARTIAL")
    if S2 and S3 and not S4:
        verdict += " -- but it does not pay at the 10% bar (S4)"
    if not S1:
        verdict += " [S1 baseline moved on its own; S2 reading is confounded]"
    out = {"n_seeds": n_seeds, "episodes": EPISODES, "H": H,
           "controls": {"C1_fired": fired(c1), "C2_fired": fired(c2), "C1_drops": c1_drops, "C2_drops": c2_drops,
                        "C1_fired_counterfactual": fired(c1F), "C2_fired_counterfactual": fired(c2F)},
           "gates": gates, "verdict": verdict}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, default=float)
    print()
    print("GATES:")
    for k, g in gates.items():
        print(f"  {k:28} {json.dumps(g)}")
    print()
    print(f"VERDICT: {verdict}")
    print("->", OUT)


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 100)
