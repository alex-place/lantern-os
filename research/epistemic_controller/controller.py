"""The epistemic controller: a deterministic state machine with explicit, logged transitions.

Neither agent decides the transition. The controller does, from evidence both agents produce,
and every transition is appended to the evidence log with the evidence ids it rests on.

Roles in the MVP (no LLM anywhere -- see EPISTEMIC_BOUNDARY_MVP.md for why):
  A  explorer: ordinary least squares on the current feature set. Knows nothing about z.
  B  auditor:  a residual-structure test. Knows nothing about z either -- it only knows what
               noise looks like, and reports when residuals do not look like it.
  selector:    utility = expected explained residual variance / cost, per candidate observable.

The transition the whole thing exists to measure: SUSPECT -> BOUNDARY -> DESIGN, and that
BOUNDARY never exits to a parameter update.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field

import numpy as np

from agents.explorer import Explorer
from agents.auditor import Auditor

NOMINAL, SUSPECT, BOUNDARY, DESIGN, ACQUIRE, EXPAND, RESOLVED = (
    "NOMINAL", "SUSPECT", "BOUNDARY", "DESIGN", "ACQUIRE", "EXPAND", "RESOLVED")


@dataclass
class Evidence:
    """Append-only. Every entry has an id; transitions cite ids."""
    rows: list = field(default_factory=list)

    def add(self, kind, **payload):
        eid = f"e{len(self.rows)}"
        self.rows.append({"id": eid, "kind": kind, **payload})
        return eid


class Controller:
    def __init__(self, world, *, window=30, mse_k=3.0, alpha=0.05, hold=2, budget=10.0,
                 refuse_updates_in_boundary=True, log=None):
        self.world = world
        self.W = window
        self.mse_k = mse_k                  # SUSPECT when MSE > k x nominal baseline
        self.alpha = alpha                  # structure-test significance
        self.hold = hold                    # consecutive windows of structure before BOUNDARY
        self.budget = budget                # measurement budget (cost units)
        self.refuse = refuse_updates_in_boundary
        self.state = NOMINAL
        self.ev = Evidence()
        self.A = Explorer(features=["x"])
        self.B = Auditor(alpha=alpha)
        self.xs, self.ys = [], []
        self.extra = {}                     # acquired observables, name -> list aligned to xs
        self.baseline_mse = None
        self.structured_streak = 0
        self.spent = 0.0
        self.transitions = []               # (t, from, to, evidence_ids, note)
        self.param_updates_refused = 0
        self.param_updates_done = 0
        self.boundary_retracted = 0
        # DESIGN retracts BOUNDARY if no candidate explains at least this much of the residual.
        # Set at the MEASURED separation, not a round number: on real hidden-variable boundaries
        # the best candidate explains >= 0.96 (min over 200 seeds); on null-world drift the best
        # decoy reaches 0.90-0.92 (the x-correlated decoy, because drift residual IS a lagging
        # function of x). 0.94 sits in the gap. Budget 10 = one full probe round (~2) + one
        # measurement (~3) + ongoing upkeep, so a correctly-diagnosed variable is affordable;
        # at 6, 20% of seeds diagnosed correctly and could not pay.
        self.retract_below = 0.94
        self.probes_paid = 0                # probes actually bought (see _design: sequential + early accept)
        # Candidates bought and REJECTED this episode (EXPAND did not remove the structure, or a
        # held expansion was dropped). A tested-and-rejected hypothesis is not re-bought. Found
        # 2026-08-19 by tracing world S: the shipped controller re-bought the same proxy twice
        # in one episode and burned its budget doing so.
        self.excluded = set()
        # Utility = explained / cost**cost_exponent. Exposed because it is a property of the
        # SCIENTIST, not of the world: a machine that can diagnose its own selection policy
        # needs a knob its diagnosis can turn (see run_world_s.py).
        self.cost_exponent = 1.0
        self.log = log

    # ── helpers ───────────────────────────────────────────────────────────────────────────
    def _go(self, to, eids, note=""):
        t = len(self.xs)
        self.transitions.append({"t": t, "from": self.state, "to": to, "evidence": eids, "note": note})
        self.ev.add("transition", t=t, frm=self.state, to=to, cites=eids, note=note)
        self.state = to

    def _design_matrix(self, n=None):
        n = n or len(self.xs)
        cols = [np.array(self.xs[-n:])]
        for name in self.A.features[1:]:
            cols.append(np.array(self.extra[name][-n:]))
        return np.column_stack(cols)

    def _window_residuals(self):
        n = min(self.W, len(self.xs))
        if n < 8:
            return None
        X = self._design_matrix(n)
        y = np.array(self.ys[-n:])
        return self.A.residuals(X, y)

    # ── the selector: utility = explained residual variance / cost ───────────────────────
    def _probe_order(self):
        """The order candidates are probed in, minus anything rejected this episode. The base
        controller has no prior, so it is the world's fixed order. Subclasses that HAVE a prior
        override this -- that is the only channel through which a prior can save experiment cost
        (see _design)."""
        return [kv for kv in self.world.candidates().items() if kv[0] not in self.excluded]

    def _design(self, resid):
        """Score each candidate by how much of the CURRENT structured residual it would explain
        per unit cost, using a cheap probe (a few samples) before committing the budget.

        The probe itself costs 1/4 of the full measurement -- buying information about which
        measurement to buy. Decoys correlated with x get explained away by x and score low;
        the true z explains the residual and scores high. Logged with runner-up scores.

        PROBING IS SEQUENTIAL WITH EARLY ACCEPT. Candidates are probed in _probe_order() and
        the round STOPS as soon as one explains at least `retract_below` of the residual --
        the same bar DESIGN already uses to decide "something explains this". No new constant.
        Stopping early is what makes probe order matter: a machine that looks in a better order
        pays for fewer looks. (Before 2026-08-19 every candidate was probed unconditionally,
        which made order free and cost-invariant -- an instrument that could not measure the
        thing it was built to measure. The old flat charge is kept as `probes_flat` so the
        earlier numbers remain reconstructible.)"""
        n = len(resid)
        scored = []
        for name, cost in self._probe_order():
            probe = self.world.measure(name, n)
            self.spent += cost * 0.25
            self.probes_paid += 1
            v = np.array(probe["values"])
            # explained variance of the residual by this observable, after x is already in
            X = np.column_stack([np.ones(n), np.array(self.xs[-n:]), v])
            beta, *_ = np.linalg.lstsq(X, resid, rcond=None)
            r2 = 1 - np.var(resid - X @ beta) / max(np.var(resid), 1e-12)
            scored.append({"name": name, "cost": cost, "explained": float(max(0.0, r2)),
                           "utility": float(max(0.0, r2) / (cost ** self.cost_exponent))})
            if r2 >= self.retract_below:
                break                       # explains it: stop paying to look further
        scored.sort(key=lambda s: -s["utility"])
        return scored

    # ── one step ──────────────────────────────────────────────────────────────────────────
    def step(self):
        obs = self.world.observe()
        if obs is None:
            return False
        self.xs.append(obs["x"]); self.ys.append(obs["y"])
        for name in self.extra:                          # keep acquired columns aligned
            if len(self.extra[name]) < len(self.xs):
                self.extra[name].append(self.world.measure(name, 1)["values"][0])
                self.spent += self.world.costs[name] * 0.05   # ongoing per-step cost, small
        t = len(self.xs)
        if t < 8:
            return True

        resid = self._window_residuals()
        mse = float(np.mean(resid ** 2))

        # ── NOMINAL: learn, track the baseline, permit parameter updates ─────────────────
        if self.state == NOMINAL:
            X = self._design_matrix(); y = np.array(self.ys)
            self.A.fit(X, y); self.param_updates_done += 1
            # Baseline = median windowed MSE over the SETTLED part of the warm-up (t in [20,40)),
            # not an EMA seeded at t=8. The EMA version froze at ~35x the true nominal level
            # because the first pre-fit window (MSE ~20) had not decayed by t=40, so the 3x
            # threshold sat at ~8 and a real 30x jump never tripped it -- 58% of worlds never
            # left NOMINAL. That was a controller bug, found by the MVP's own P1, not a property
            # of the claim. The fix is a robust estimate from a window the model has already fit.
            self._mse_hist = getattr(self, "_mse_hist", [])
            if t < 40:
                if t >= 20:
                    self._mse_hist.append(mse)
                self.baseline_mse = float(np.median(self._mse_hist)) if self._mse_hist else mse
            elif mse > self.mse_k * self.baseline_mse:
                eid = self.ev.add("residual", t=t, mse=mse, baseline=self.baseline_mse)
                self._go(SUSPECT, [eid], f"MSE {mse:.3f} > {self.mse_k}x baseline {self.baseline_mse:.3f}")
            return True

        # ── SUSPECT: exhaust PARAMETER explanations first, THEN ask B about class ────────
        #
        # The first version refit on ALL data and asked B "is the residual structured?". In the
        # null world (slow drift, no hidden variable) that fired BOUNDARY 38% of the time: a
        # model fit to all history lags a drifting truth, so its recent residual has a slope --
        # genuinely structured, and B was RIGHT to say so -- but the failure is PARAMETRIC (the
        # fix is forget old data), not MODEL_CLASS (add a variable). "Structured" != "class is
        # wrong". The machine even told us: in BOUNDARY it bought the same decoy twice, because
        # NO candidate explains drift.
        #
        # So SUSPECT now does what the MVP doc says: it exhausts the parameter-failure
        # hypothesis before declaring a class failure. A refit on the RECENT window only
        # (recency refit -- the strongest parametric repair available) is tried; if that
        # removes the structure, it was parameters, and we return to NOMINAL with the refit.
        # Only structure that survives the recency refit counts toward BOUNDARY.
        if self.state == SUSPECT:
            X = self._design_matrix(); y = np.array(self.ys)
            self.A.fit(X, y); self.param_updates_done += 1          # parameter refit is ALLOWED here
            resid = self._window_residuals(); mse = float(np.mean(resid ** 2))
            if mse <= self.mse_k * self.baseline_mse:
                eid = self.ev.add("residual", t=t, mse=mse, note="refit recovered")
                self._go(NOMINAL, [eid], "PARAMETER failure: refit recovered"); self.structured_streak = 0
                return True
            # Recency refit: the strongest parametric repair. Fit on the window alone.
            n = min(self.W, len(self.xs))
            Xr = self._design_matrix(n); yr = np.array(self.ys[-n:])
            probe = Explorer(features=self.A.features); probe.fit(Xr, yr)
            resid_recent = probe.residuals(Xr, yr)
            verdict = self.B.judge(resid_recent)
            eid = self.ev.add("structure", t=t, basis="recency-refit residual", **verdict)
            if not verdict["structured"] and float(np.mean(resid_recent ** 2)) <= self.mse_k * self.baseline_mse:
                # A recency refit explains it -> parameters drifted. Adopt it, go home.
                self.A = probe; self.param_updates_done += 1
                self._go(NOMINAL, [eid], "PARAMETER failure: recency refit removed structure")
                self.structured_streak = 0
                return True
            if verdict["structured"]:
                self.structured_streak += 1
                if self.structured_streak >= self.hold:
                    cid = self.ev.add("failure_class", t=t, cls="MODEL_CLASS", cites=[eid],
                                      why="residuals structured after refit, sustained")
                    self._go(BOUNDARY, [eid, cid], "MODEL_CLASS failure: structure survives refit")
            else:
                self.structured_streak = 0
            return True

        # ── BOUNDARY: parameter updates REFUSED. Only legal exit is DESIGN. ──────────────
        if self.state == BOUNDARY:
            if self.refuse:
                self.param_updates_refused += 1
            else:
                X = self._design_matrix(); y = np.array(self.ys)
                self.A.fit(X, y); self.param_updates_done += 1
            self._go(DESIGN, [], "BOUNDARY's only exit")
            return True

        if self.state == DESIGN:
            cheapest = min(self.world.candidates().values())
            if self.spent + cheapest * 0.25 > self.budget:
                # probes cost real budget. Without this gate a controller that keeps retracting
                # and re-designing buys probe rounds forever -- measured at 200+ experiments and
                # 11x the budget on a single episode before the gate existed.
                eid = self.ev.add("budget", t=t, spent=self.spent, need=cheapest * 0.25, phase="design")
                self._go(RESOLVED, [eid], "budget exhausted before probing; resolved-with-failure")
                self.failed_budget = True
                return True
            scored = self._design(resid)
            # RETRACT: the BOUNDARY call was a hypothesis ("a variable is missing"), and DESIGN
            # is its test. If NO available observable explains the structured residual, the
            # honest conclusion is that the class hypothesis was wrong -- not "buy the best
            # decoy". Measured: on real hidden-variable boundaries the best candidate explains
            # >= 0.96 of the residual; on null-world false alarms (drift) the best explains
            # ~0.77, max 0.89 -- disjoint. So a retraction bar at 0.9 is a property of the
            # evidence, not a tuned knob. A retracted boundary returns to SUSPECT (not NOMINAL:
            # the error is still real) with a recency refit as the parametric repair.
            best = max((c_["explained"] for c_ in scored), default=0.0)
            if best < self.retract_below and self.excluded:
                # "nothing left explains it" is evidence that an earlier REJECTION was wrong --
                # a candidate can fail its expansion transiently (bought a few steps after the
                # switch, the window still straddles the old regime, the auditor still sees
                # structure). A rejection is a hypothesis too, so before retracting the whole
                # boundary, re-admit what was rejected and look again.
                eid = self.ev.add("rejections_cleared", t=t, readmitted=sorted(self.excluded))
                self.excluded.clear()
                self._go(DESIGN, [eid], "no candidate left explains it; re-admitting rejected candidates")
                return True
            if best < self.retract_below:
                eid = self.ev.add("design", t=t, candidates=scored, chosen=None,
                                  why=f"RETRACT: no candidate explains the residual (best {best:.2f} < {self.retract_below})")
                self.boundary_retracted += 1
                n = min(self.W, len(self.xs))
                probe = Explorer(features=self.A.features); probe.fit(self._design_matrix(n), np.array(self.ys[-n:]))
                self.A = probe; self.param_updates_done += 1
                self.structured_streak = 0
                self._go(SUSPECT, [eid], "boundary RETRACTED: no observable explains it; parametric repair instead")
                return True
            eid = self.ev.add("design", t=t, candidates=scored, chosen=scored[0]["name"],
                              why="max explained-residual-variance per cost")
            self._chosen = scored[0]
            runner = (f"runner-up {scored[1]['name']} {scored[1]['utility']:.3f}"
                      if len(scored) > 1 else "no runner-up: accepted on first probe")
            self._go(ACQUIRE, [eid], f"chose {scored[0]['name']} (util {scored[0]['utility']:.3f}, {runner})")
            return True

        if self.state == ACQUIRE:
            name = self._chosen["name"]
            if self.spent + self.world.costs[name] > self.budget:
                eid = self.ev.add("budget", t=t, spent=self.spent, need=self.world.costs[name])
                self._go(RESOLVED, [eid], "budget exhausted; resolved-with-failure")
                self.failed_budget = True
                return True
            m = self.world.measure(name, len(self.xs))
            self.spent += m["cost"]
            self.extra[name] = list(m["values"])
            eid = self.ev.add("measurement", t=t, name=name, n=len(m["values"]), cost=m["cost"])
            self._go(EXPAND, [eid], f"acquired {name}")
            return True

        if self.state == EXPAND:
            name = self._chosen["name"]
            if name not in self.A.features:
                self.A = Explorer(features=self.A.features + [name])
            X = self._design_matrix(); y = np.array(self.ys)
            self.A.fit(X, y); self.param_updates_done += 1
            resid = self._window_residuals(); verdict = self.B.judge(resid)
            eid = self.ev.add("expansion", t=t, features=self.A.features, mse=float(np.mean(resid ** 2)), **verdict)
            if not verdict["structured"]:
                self._go(RESOLVED, [eid], f"expanded class {self.A.features} explains the data")
            else:
                # the chosen observable did not explain it -- reject it, REFIT the reduced class,
                # and choose again among what is left. The refit matters: an unfitted explorer
                # predicts 0, so the next DESIGN would score candidates against the raw y, which
                # x alone "explains" -- every candidate then clears the bar and the cheapest (the
                # proxy) wins. That was the shipped behaviour until 2026-08-19.
                self.excluded.add(name)
                self.A = Explorer(features=[f for f in self.A.features if f != name])
                self.extra.pop(name, None)
                self.A.fit(self._design_matrix(), np.array(self.ys)); self.param_updates_done += 1
                rid = self.ev.add("expansion_rejected", t=t, rejected=name, cost=self.world.costs[name])
                self._go(DESIGN, [eid, rid], f"{name} did not remove structure; rejected; choose again")
            return True

        if self.state == RESOLVED:
            # back to nominal on the NEW class; ordinary updates resume
            X = self._design_matrix(); y = np.array(self.ys)
            self.A.fit(X, y); self.param_updates_done += 1
            return True
        return True

    def run(self):
        self.failed_budget = False
        while self.step():
            pass
        resid = self._window_residuals()
        return {
            "final_state": self.state,
            "features": self.A.features,
            "final_mse": float(np.mean(resid ** 2)) if resid is not None else None,
            "transitions": self.transitions,
            "param_updates_done": self.param_updates_done,
            "param_updates_refused": self.param_updates_refused,
            "spent": self.spent,
            "entered_boundary": any(tr["to"] == BOUNDARY for tr in self.transitions),
            "boundary_retracted": self.boundary_retracted,
            # a boundary that DESIGN retracted never led to an expansion -- it is a tested-and-
            # rejected hypothesis, which is the controller working, not a false alarm
            "boundary_held": any(tr["to"] == BOUNDARY for tr in self.transitions) and any(tr["to"] == EXPAND for tr in self.transitions),
            "boundary_t": next((tr["t"] for tr in self.transitions if tr["to"] == BOUNDARY), None),
            "chosen": [tr["note"] for tr in self.transitions if tr["to"] == ACQUIRE],
            "failed_budget": self.failed_budget,
            "probes_paid": self.probes_paid,
            "evidence": self.ev.rows,
        }
