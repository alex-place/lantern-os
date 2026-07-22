"""
VoI steering for the Oracle active loop — directed exploration (the bandit's steering leg).

The active loop (`oracle_active_loop.py`) manufactures corpus-absent facts by acting, but it
runs *every* candidate blindly. That is undirected exploration. This module adds the missing
**steering**: given a set of candidate experiments and a budget, choose the ones that buy the
most knowledge per unit cost — the value-of-information selection the convergence loop's Converge
stage was missing.

Where this sits in the bandit picture (see SIGMA0-COLLAPSE-CERTIFICATE §10 / CONVERGENCE-ORACLE-DESIGN §7):
the anti-collapse discipline already gives the loop a **no-regret** floor (persistent excitation ⇒
never permanently lock out a good arm ⇒ never get stuck). What it lacks is **directed** exploration:
spend each token on the highest-value experiment, not just "don't get stuck." This is that layer.

Mechanism — established, no novelty claimed:
  - value of information (Howard 1966): the worth of an experiment is the expected reduction in
    your uncertainty (here: the prior entropy the experiment would resolve);
  - optimal experimental design (Lindley 1956): information = expected entropy reduction;
  - budgeted greedy by info-gain-per-cost (Krause & Guestrin 2005/2008): when the information
    gains are **submodular** (diminishing returns — true when experiments overlap in what they
    resolve), greedy selection is within a (1 - 1/e) ≈ 0.63 factor of the optimal set. We do NOT
    verify submodularity here, so that guarantee is claimed only as the standard condition, not
    as proven for this instance.

Honest scope: the per-question VoI is a **heuristic prior-entropy proxy**, not a computed Bayesian
expected posterior-entropy reduction — so this builds the *structure* of VoI steering (a real,
tested selector that provably prioritizes high-VoI-per-cost, excludes pins, and respects a budget),
not an optimality claim. The next rung is a real Bayesian VoI estimate. This is directed exploration
on top of the loop's existing no-regret floor — the staircase now climbs *with a direction*.

Run:  python experiments/oracle_voi_select.py
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List

try:  # importable both under pytest (package on path) and as a direct script
    from experiments.oracle_active_loop import Question, run_active_loop, seed_questions, summarize
except ModuleNotFoundError:  # pragma: no cover - direct `python experiments/oracle_voi_select.py`
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from experiments.oracle_active_loop import Question, run_active_loop, seed_questions, summarize


@dataclass
class Scored:
    q: Question
    voi: float           # expected information gain (prior entropy this experiment resolves)
    cost: float          # relative cost of running the action
    ratio: float         # voi / cost — the greedy key


def prior_entropy(q: "Question") -> float:
    """A heuristic proxy for how much uncertainty running this experiment would resolve.

    - A `pin` (no action resolves it) resolves nothing → 0 (never worth spending on).
    - A corpus-absent / live-state question (`inference_reachable=False`) is genuinely unknown
      until you act → high value (1.0): only acting resolves it, which is the ceiling-break.
    - An inference-reachable question is worth `1 - passive_conf`: if the prior is already
      confident, acting buys little; if the prior is unsure, acting buys more.
    """
    if not q.actionable:
        return 0.0
    if not q.inference_reachable:
        return 1.0
    # round to kill float noise so the greedy selection key is clean + reproducible
    return round(max(0.0, 1.0 - float(q.passive_conf)), 6)


def cost_of(q: "Question") -> float:
    """Relative action cost. Local-code execution is the cheap floor (1.0); a hook lets callers
    mark expensive/irreversible surfaces (a real run, a market bet) higher so VoI/cost — not raw
    VoI — drives selection. Kept simple + explicit so the ranking is auditable."""
    return float(getattr(q, "cost", 1.0) or 1.0)


def score(questions: List["Question"]) -> List["Scored"]:
    out = []
    for q in questions:
        v = prior_entropy(q)
        c = cost_of(q)
        out.append(Scored(q=q, voi=v, cost=c, ratio=(v / c if c > 0 else 0.0)))
    # Highest VoI-per-cost first; deterministic tie-break by id so runs are reproducible.
    out.sort(key=lambda s: (-s.ratio, -s.voi, s.q.id))
    return out


def select(questions: List["Question"], budget: float) -> dict:
    """Budgeted greedy VoI selection. Spend the budget on the highest VoI/cost experiments;
    skip pins (voi 0) and anything that doesn't fit the remaining budget. Returns the plan."""
    ranked = score(questions)
    chosen, skipped_budget, skipped_pin = [], [], []
    spent = 0.0
    for s in ranked:
        if s.voi <= 0.0:
            skipped_pin.append(s)
            continue
        if spent + s.cost <= budget:
            chosen.append(s)
            spent += s.cost
        else:
            skipped_budget.append(s)
    return {
        "budget": budget, "spent": spent,
        "chosen": chosen, "skipped_budget": skipped_budget, "skipped_pin": skipped_pin,
        "total_voi_captured": sum(s.voi for s in chosen),
        "total_voi_available": sum(s.voi for s in ranked if s.voi > 0),
    }


def demo_candidates() -> List["Question"]:
    """The active-loop seed (corpus-absent facts + a pin) PLUS a couple of low-VoI
    candidates — obvious facts inference already knows with high confidence, so acting
    to check them buys almost nothing. A good selector must rank these LAST, below the
    corpus-absent experiments, demonstrating value-discrimination, not just budgeting."""
    low_voi = [
        Question(id="two-plus-two", text="Is 2+2 == 4?", act=lambda: (2 + 2 == 4),
                 passive=True, passive_conf=0.99, inference_reachable=True,
                 note="Inference already knows this; acting buys ~nothing (VoI ~0.01)."),
        Question(id="sorted-known", text="Does sorted([3,1,2]) == [1,2,3]?",
                 act=lambda: (sorted([3, 1, 2]) == [1, 2, 3]),
                 passive=True, passive_conf=0.95, inference_reachable=True,
                 note="Obvious library behavior; low VoI (~0.05)."),
    ]
    return seed_questions() + low_voi


def main() -> int:
    from datetime import datetime, timezone
    qs = demo_candidates()
    budget = 3.0   # run at most ~3 cost-units of experiments this tick
    plan = select(qs, budget)

    print(f"VoI-steered experiment selection (budget={budget})")
    print("  ranked candidates (VoI/cost, high to low):")
    for s in score(qs):
        tag = "PIN" if s.voi <= 0 else ("chosen" if s in plan["chosen"] else
              ("over-budget" if s in plan["skipped_budget"] else "-"))
        print(f"    {s.ratio:4.2f}  voi={s.voi:.2f} cost={s.cost:.1f}  [{tag:11}] {s.q.id}")
    print(f"  chosen: {[s.q.id for s in plan['chosen']]}  "
          f"(spent {plan['spent']}/{budget}, captured "
          f"{plan['total_voi_captured']:.2f}/{plan['total_voi_available']:.2f} VoI)")
    print(f"  excluded as pins (no action resolves): {[s.q.id for s in plan['skipped_pin']]}")

    # Now ACT only on the selected experiments — directed exploration, not blind.
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    records = run_active_loop([s.q for s in plan["chosen"]], stamp=stamp)
    summary = summarize(records)
    print("  ran the selected experiments ->", summary["ceiling_breaks_corpus_absent_rigorous"],
          "corpus-absent facts manufactured (directed).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
