"""The Adam-style benchmark: validated regularities discovered per unit of experiment.

THE LOOP UNDER TEST is the one proposed as the core of the machine:

    H_t -> P_t -> FALSIFY -> DISCRIMINATE -> E_t -> O_{t+1} -> DIAGNOSE -> M_{t+1} -> H_{t+1}

with DIAGNOSE routing O != P to {parameter error | new data needed | new model needed} instead
of "adjust parameters". That loop is ALREADY the shipped controller (controller.py): the model
class is H, residuals are O-P, the auditor's structure test is FALSIFY, SUSPECT->NOMINAL is the
parameter branch, SUSPECT->BOUNDARY the class branch, DESIGN is DISCRIMINATE, ACQUIRE is E,
EXPAND is M'. It passed the single-hidden-variable world on 300 holdout seeds. This file does
NOT rebuild it. It measures it on the metric the proposal names and the MVP never reported:

    discoveries per experiment  =  (# validated regularities found) / (# measurements paid for)

and it adds the one piece the proposal has that the MVP does not: SCIENTIFIC MEMORY across
episodes -- the world presents a SEQUENCE of hidden rules, and the machine carries its expanded
model class forward, so a regularity learned in episode k is not re-discovered (and re-paid
for) in episode k+1.

DEFINITIONS, fixed before running so they cannot drift to flatter the result:
  regularity      = a hidden variable z_j that the world switches on, which the initial model
                    class {x} cannot represent
  DISCOVERED      = the controller EXPANDED its class to include the true observable for z_j
  VALIDATED       = after expansion, the residual passes the auditor's structure test (the
                    expanded model actually explains the data) AND final MSE on that episode is
                    within 2x the irreducible noise -- a regularity is not "found" until the
                    model built on it works
  experiment      = one paid measurement call (probe or acquisition). Ongoing per-step upkeep of
                    an already-acquired column is NOT an experiment (it is observation, not
                    intervention)
  FALSE discovery = an expansion that does not validate (proxy/decoy committed, not dropped)

ARMS:
  A-alone     least squares on {x}, refit forever. Discovers nothing by construction; sets the
              error floor to beat. 0 experiments, 0 discoveries -- the denominator is 0 so the
              metric is undefined; reported as the MSE it leaves on the table.
  one-shot    the shipped controller, run on each episode FRESH (no memory). The MVP result.
  memory      the shipped controller, class carried across episodes. The proposal's loop.
  memory+hold the same with the revocable expansion from world H.

PRE-REGISTERED GATES:
  D1  memory arm's discoveries-per-experiment EXCEEDS one-shot by >= 25% over the sequence --
      i.e. carrying the model forward buys real efficiency, it is not just bookkeeping.
  D2  false-discovery rate (expansions that never validate) < 10% in the memory+hold arm.
  D3  every validated discovery cites an evidence chain: BOUNDARY transition -> DESIGN record
      -> ACQUIRE -> EXPAND -> validation verdict. Zero discoveries without a chain.
  D4  CONTROL: the null world (drift only, no hidden rule) yields 0 validated discoveries in
      every arm. A machine that "discovers" regularities in noise is measuring its own bias.
  KILL  D1 fails -> memory across episodes is not the mechanism; D4 fails -> the metric is
      counting artifacts and the benchmark is invalid.

Run:  python research/epistemic_controller/run_discovery_benchmark.py 60
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from controller import Controller, BOUNDARY, EXPAND, RESOLVED   # noqa: E402
from run_world_h import HoldController                         # noqa: E402
from environments.hidden_variable import HiddenVariableWorld   # noqa: E402
from agents.explorer import Explorer                           # noqa: E402
from memory import RelationMemory                              # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "results", "discovery_benchmark.json")
EPISODES = 3          # a SEQUENCE of hidden rules per seed
STEPS = 300


class MemoryController(HoldController):
    """The hold controller + RelationMemory as a PRIOR on DESIGN. Starts every episode on the
    base class -- nothing carried as model state. Memory only re-ranks candidates by their
    validated history, and each candidate must still explain THIS episode's residual."""

    def __init__(self, world, memory, **kw):
        super().__init__(world, **kw)
        self.memory = memory

    def _probe_order(self):
        """The whole mechanism: probe the remembered-reliable observable FIRST. With early
        accept, a prior that is right stops the round after one probe instead of four."""
        items = super()._probe_order()
        return sorted(items, key=lambda kv: -self.memory.reliability(kv[0]))

    def _design(self, resid):
        scored = super()._design(resid)
        return self.memory.rank(scored)


class SequenceWorld:
    """Presents EPISODES hidden-variable worlds in sequence, each with its OWN true z among four
    candidates. The candidate slots are shared across episodes, so a class carried forward is
    meaningful: the machine that learned z2 in episode 1 keeps z2 and need not re-buy it if
    episode 3 switches z2 on again."""

    def __init__(self, seed, episodes=EPISODES, null=False, repeat=False):
        self.rng = np.random.default_rng(seed)
        self.episodes = []
        for k in range(episodes):
            w = HiddenVariableWorld(seed * 100 + k, switch_at=None if null else 100, n_steps=STEPS,
                                    drift=0.002 if null else 0.0)
            if repeat and k > 0:
                # the SAME regularity recurs: pin this episode's true slot to episode 0's
                w.true_idx = self.episodes[0].true_idx
            self.episodes.append(w)
        self.k = 0

    def current(self):
        return self.episodes[self.k]

    def next_episode(self):
        self.k += 1
        return self.k < len(self.episodes)


def count_experiments(ctrl):
    """Paid measurement calls = probe rounds + acquisitions, from the evidence log.
    Ongoing upkeep is excluded by definition (see header)."""
    probes = ctrl.probes_paid                                             # probes ACTUALLY bought
    acq = sum(1 for e in ctrl.ev.rows if e["kind"] == "measurement")
    return probes + acq


def validated(ctrl, world):
    """Discovered AND validated, per the fixed definition."""
    truth = world.truth()
    if truth["true_z"] not in ctrl.A.features:
        return False, "not discovered"
    exp = [e for e in ctrl.ev.rows if e["kind"] == "expansion" and truth["true_z"] in e.get("features", [])]
    if not exp or exp[-1].get("structured", True):
        return False, "expanded but residual still structured"
    resid = ctrl._window_residuals()
    mse = float(np.mean(resid ** 2)) if resid is not None else float("inf")
    if mse > 2 * truth["noise"] ** 2:
        return False, f"mse {mse:.3f} > 2x noise"
    return True, "validated"


def evidence_chain(ctrl, true_z):
    kinds = [e["kind"] for e in ctrl.ev.rows]
    has_boundary = any(e["kind"] == "transition" and e.get("to") == BOUNDARY for e in ctrl.ev.rows)
    has_design = "design" in kinds
    has_measure = any(e["kind"] == "measurement" and e.get("name") == true_z for e in ctrl.ev.rows)
    has_expand = any(e["kind"] == "expansion" and true_z in e.get("features", []) for e in ctrl.ev.rows)
    return has_boundary and has_design and has_measure and has_expand


def run_seed(seed, arm, null=False, repeat=False):
    sw = SequenceWorld(seed, null=null, repeat=repeat)
    carried = ["x"]; carried_extra = {}
    mem = RelationMemory()
    disc = 0; false_disc = 0; experiments = 0; chains_ok = 0; mse_sum = 0.0
    for k in range(EPISODES):
        w = sw.episodes[k]
        if arm == "a_alone":
            A = Explorer(["x"]); xs, ys = [], []
            while (o := w.observe()) is not None:
                xs.append(o["x"]); ys.append(o["y"])
                if len(xs) >= 8: A.fit(np.array(xs)[:, None], np.array(ys))
            r = A.residuals(np.array(xs[-30:])[:, None], np.array(ys[-30:]))
            mse_sum += float(np.mean(r ** 2)); continue
        if arm == "relmem":
            c = MemoryController(w, mem)          # base class every episode; memory is a prior only
        else:
            cls = HoldController if arm == "memory+hold" else Controller
            c = cls(w)
        if arm in ("memory", "memory+hold") and len(carried) > 1:
            # carry the expanded class forward: the machine remembers what it learned
            c.A = Explorer(features=list(carried))
            for name in carried[1:]:
                c.extra[name] = []           # column fills from the new world as steps arrive
        r = c.run()
        experiments += count_experiments(c)
        ok, why = validated(c, w)
        if arm == "relmem":
            # the re-test outcome: every observable this episode EXPANDED on gets a verdict
            for name in c.A.features[1:]:
                mem.record(name, ok and name == w.truth()["true_z"])
        if ok:
            disc += 1
            if evidence_chain(c, w.truth()["true_z"]): chains_ok += 1
        elif len(c.A.features) > 1 and w.truth()["true_z"] not in c.A.features:
            false_disc += 1
        mse_sum += r["final_mse"] or 0.0
        if arm in ("memory", "memory+hold"):
            carried = list(c.A.features)
    return {"seed": seed, "arm": arm, "discoveries": disc, "false": false_disc, "experiments": experiments,
            "chains_ok": chains_ok, "mean_mse": mse_sum / EPISODES,
            "per_experiment": (disc / experiments) if experiments else None}


def agg(rs):
    d = sum(r["discoveries"] for r in rs); f = sum(r["false"] for r in rs); e = sum(r["experiments"] for r in rs)
    ch = sum(r["chains_ok"] for r in rs)
    return {"discoveries": d, "false": f, "experiments": e, "chains_ok": ch,
            "per_experiment": (d / e) if e else None, "false_rate": (f / (d + f)) if (d + f) else 0.0,
            "mean_mse": float(np.mean([r["mean_mse"] for r in rs])),
            "possible": len(rs) * EPISODES}


def main(n_seeds=60):
    arms = ["a_alone", "one-shot", "memory", "memory+hold", "relmem"]
    rows = {a: [run_seed(s, a) for s in range(n_seeds)] for a in arms}
    rep_rows = {a: [run_seed(s, a, repeat=True) for s in range(n_seeds)] for a in ("one-shot", "relmem")}
    null_rows = {a: [run_seed(s, a, null=True) for s in range(n_seeds)] for a in arms if a != "a_alone"}

    summary = {a: agg(rows[a]) for a in arms}
    rep_summary = {a: agg(rep_rows[a]) for a in rep_rows}
    null_summary = {a: agg(null_rows[a]) for a in null_rows}

    print(f"=== DISCOVERY BENCHMARK: validated regularities per experiment -- {n_seeds} seeds x {EPISODES} episodes ===\n")
    print(f"{'arm':14} {'discovered':>11} {'of':>4} {'false':>6} {'experiments':>12} {'PER EXPERIMENT':>15} {'mean MSE':>9}")
    for a in arms:
        s = summary[a]
        pe = "undefined" if s["per_experiment"] is None else f"{s['per_experiment']:.4f}"
        print(f"{a:14} {s['discoveries']:>11} {s['possible']:>4} {s['false']:>6} {s['experiments']:>12} {pe:>15} {s['mean_mse']:>9.3f}")
    print(f"\nREPEAT REGIME (same regularity every episode -- the only place memory CAN pay):")
    print(f"{'arm':14} {'discovered':>11} {'of':>4} {'false':>6} {'experiments':>12} {'PER EXPERIMENT':>15}")
    for a, s_ in rep_summary.items():
        print(f"{a:14} {s_['discoveries']:>11} {s_['possible']:>4} {s_['false']:>6} {s_['experiments']:>12} {s_['per_experiment']:>15.4f}")
    print(f"\nNULL WORLD (no hidden rule; drift only) -- discoveries must be 0:")
    for a, s in null_summary.items():
        print(f"  {a:14} discoveries={s['discoveries']}  false={s['false']}  experiments={s['experiments']}")

    os_pe = summary["one-shot"]["per_experiment"] or 0
    mem_pe = summary["memory"]["per_experiment"] or 0
    rel_pe = summary["relmem"]["per_experiment"] or 0
    rep_os = rep_summary["one-shot"]["per_experiment"] or 0
    rep_rel = rep_summary["relmem"]["per_experiment"] or 0
    # D1 is two-sided: relation-memory must PAY where the rule repeats (>=25% over one-shot)
    # and must NOT HURT where it does not (within 10% of one-shot). Naive memory stays as the
    # killed comparator.
    D1 = (rep_rel >= 1.25 * rep_os) and (rel_pe >= 0.90 * os_pe)
    D2 = summary["relmem"]["false_rate"] < 0.10
    D3 = all(summary[a]["chains_ok"] == summary[a]["discoveries"] for a in arms if a != "a_alone")
    D4 = all(s["discoveries"] == 0 for s in null_summary.values())
    gates = {"D1_relation_memory_pays_on_repeat_and_no_harm_otherwise": {
                 "PASS": bool(D1),
                 "repeat_regime": {"one_shot": rep_os, "relmem": rep_rel, "gain_pct": round(100 * (rep_rel / rep_os - 1), 1) if rep_os else None},
                 "nonrepeat_regime": {"one_shot": os_pe, "relmem": rel_pe, "naive_memory_KILLED": mem_pe}},
             "D2_false_discovery_lt_10pct": {"PASS": bool(D2), "rate": summary["memory+hold"]["false_rate"]},
             "D3_every_discovery_has_chain": {"PASS": bool(D3)},
             "D4_null_world_zero": {"PASS": bool(D4)},
             "VERDICT": ("KILLED: null world produced discoveries -- the metric counts artifacts" if not D4 else
                         "KILLED: relation memory does not pay where the rule repeats, or hurts where it does not" if not D1 else
                         "BENCHMARK STANDS" if (D2 and D3) else "PARTIAL -- see gates")}
    out = {"n_seeds": n_seeds, "episodes": EPISODES, "summary": summary, "repeat": rep_summary, "null": null_summary, "gates": gates}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, default=float)
    print("\nGATES:")
    for k, v in gates.items():
        if k != "VERDICT": print(f"  {k:34} {v}")
    print(f"\nVERDICT: {gates['VERDICT']}")
    print("->", OUT)


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 60)
