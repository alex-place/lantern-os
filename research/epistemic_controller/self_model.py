"""The scientist as an experimental object -- the first SELF experiment.

WHAT THIS IS. The controller already runs the loop H -> P -> E -> O and diagnoses O != P into
{parameter error, missing observation, wrong model class} -- all of those are diagnoses about
the WORLD-model. This module adds one diagnosis about the SCIENTIST:

    "my experiment-selection policy is systematically choosing wrong"

and treats the repair of that policy the same way the controller treats everything else: as a
hypothesis that has to pay for itself on fresh data or be reverted.

THE CONCRETE CASE. DESIGN ranks candidate observables by utility = explained / cost^e with e=1.
World H showed that rule is biased toward a cheaper proxy of the truth; the hold mechanism
catches the mistake inside an episode (the proxy fails to hold, is dropped, the truth is bought)
-- but the scientist pays for the SAME mistake every episode forever, because nothing looks at
the pattern of its own mistakes. This module looks.

THE LOOP, one level up:
  ledger      every dropped expansion is recorded with the cost of what was dropped and the cost
              of what eventually survived -- the O != P of the selection policy
  diagnose    if there are enough drops AND they are cost-patterned (the dropped candidate was
              the cheaper one >= pattern_bar of the time) -> hypothesis: "the policy over-weights
              cost". If drops exist but are NOT cost-patterned -> "failures observed, this cause
              ruled out" and the policy is left alone. (That null branch is what makes it a
              diagnosis and not a reflex.)
  repair      propose the next rung of a small ladder e in {1.0, 0.5, 0.0}
  TRIAL       run the next `trial_episodes` episodes under the repaired policy. KEEP it only if
              the drop rate during the trial is lower than the rate before it; otherwise REVERT.
              The scientist experiments on itself and takes the result.

WHAT IT IS NOT. It is not a learned meta-policy, not an LLM judging itself, and the ladder is
fixed and tiny. That is deliberate: the question is whether a deterministic, auditable
self-diagnosis can (a) fire when its cause is real, (b) stay silent when failures have a
different cause, and (c) pay. run_world_s.py measures exactly those three with pre-registered
gates and two controls.

Pure; no I/O. Harness calls configure(ctrl) before an episode and observe_episode(ctrl, world)
after it.
"""

from __future__ import annotations

LADDER = [1.0, 0.5, 0.0]


class SelfModel:
    def __init__(self, *, min_drops=2, pattern_bar=0.75, trial_episodes=2, cost_reference="survivor"):
        self.cost_exponent = LADDER[0]
        self.rung = 0
        self.min_drops = min_drops
        self.pattern_bar = pattern_bar
        self.trial_episodes = trial_episodes
        # What "the miss was the cheap one" is measured against. "survivor": cheaper than the
        # candidate that finally worked -- strict, unanswerable when the episode ran out of
        # budget with no survivor (~60% of failures). "median": cheaper than the median
        # candidate -- always answerable. run_world_s.py runs both: the strict reference is
        # specific but almost never fires; the loose one fires on the controls. That trade is
        # the result, not a tuning choice.
        self.cost_reference = cost_reference
        self.ledger = []            # one row per episode: {"drops": [(name, cost)], "survivor": (name, cost) | None}
        self.trial = None           # {"from", "to", "baseline_rate", "left", "drops"}
        self.log = []               # evidence: diagnoses, trials, keeps, reverts
        self.repairs_kept = 0
        self.repairs_reverted = 0
        self.diagnoses_fired = 0
        self.null_diagnoses = 0     # drops seen, cost-pattern ruled out, policy left alone
        self.refuted = set()        # rungs whose trial failed; a refuted repair is not re-proposed

    # ── the harness hooks ──────────────────────────────────────────────────────────────
    def configure(self, ctrl):
        ctrl.cost_exponent = self.cost_exponent

    def observe_episode(self, ctrl, world):
        costs = world.costs
        # a MISS is anything bought that did not survive: rejected at EXPAND or dropped in hold
        drops = [(e["dropped"], costs[e["dropped"]]) for e in ctrl.ev.rows if e["kind"] == "expansion_dropped"]
        drops += [(e["rejected"], e["cost"]) for e in ctrl.ev.rows if e["kind"] == "expansion_rejected"]
        surv = ctrl.A.features[-1] if ctrl.A.features[1:] else None
        med = sorted(costs.values())[len(costs) // 2]
        row = {"drops": drops, "survivor": (surv, costs[surv]) if surv else None, "median_cost": med}
        self.ledger.append(row)
        if self.trial is not None:
            self._score_trial(row)
        else:
            self._diagnose()

    # ── the self-experiment ────────────────────────────────────────────────────────────
    def _diagnose(self):
        rows = self.ledger
        if self.cost_reference == "median":
            drops = [(d, r["median_cost"]) for r in rows for d in r["drops"]]
        else:
            drops = [(d, r["survivor"][1] if r["survivor"] else None) for r in rows for d in r["drops"]]
        if len(drops) < self.min_drops:
            return
        # Compared against the MEDIAN candidate cost, not against the survivor. The first
        # version asked "was the miss cheaper than what finally worked?", which is unanswerable
        # in the episodes that matter most: when the machine runs out of budget there IS no
        # survivor, and those were ~60% of all failures -- the diagnosis was starved of exactly
        # the evidence it needed. Chance is still ~50% either way, so the 0.75 bar is unchanged.
        cheaper = [ref is not None and d[1] < ref for d, ref in drops]
        frac = sum(cheaper) / len(cheaper)
        if frac < self.pattern_bar:
            self.null_diagnoses += 1
            self.log.append({"kind": "diagnosis", "episode": len(rows), "drops": len(drops),
                             "cheaper_frac": frac, "verdict": "failures not cost-patterned; policy left alone"})
            return
        if self.rung + 1 >= len(LADDER) or LADDER[self.rung + 1] in self.refuted:
            return
        self.diagnoses_fired += 1
        rate = len(drops) / len(rows)
        self.trial = {"from": self.cost_exponent, "to": LADDER[self.rung + 1],
                      "baseline_rate": rate, "left": self.trial_episodes, "drops": 0}
        self.cost_exponent = self.trial["to"]
        self.log.append({"kind": "diagnosis", "episode": len(rows), "drops": len(drops), "cheaper_frac": frac,
                         "verdict": "selection policy over-weights cost",
                         "repair": f"cost_exponent {self.trial['from']} -> {self.trial['to']} (TRIAL)"})

    def _score_trial(self, row):
        t = self.trial
        t["drops"] += len(row["drops"])
        t["left"] -= 1
        if t["left"] > 0:
            return
        rate = t["drops"] / self.trial_episodes
        if rate < t["baseline_rate"]:
            self.rung += 1
            self.repairs_kept += 1
            self.log.append({"kind": "trial", "episode": len(self.ledger), "result": "KEEP",
                             "rate_before": t["baseline_rate"], "rate_trial": rate, "cost_exponent": self.cost_exponent})
            # the ledger before the repair described a different scientist; start the record over
            self.ledger = []
        else:
            self.cost_exponent = t["from"]
            self.refuted.add(t["to"])
            self.repairs_reverted += 1
            self.log.append({"kind": "trial", "episode": len(self.ledger), "result": "REVERT",
                             "rate_before": t["baseline_rate"], "rate_trial": rate, "cost_exponent": self.cost_exponent})
        self.trial = None

    def snapshot(self):
        return {"cost_exponent": self.cost_exponent, "diagnoses_fired": self.diagnoses_fired,
                "null_diagnoses": self.null_diagnoses, "repairs_kept": self.repairs_kept,
                "repairs_reverted": self.repairs_reverted, "log": list(self.log)}
