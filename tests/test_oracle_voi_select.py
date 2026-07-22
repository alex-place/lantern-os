"""
Unit tests for VoI steering — the active loop's directed-exploration leg.

Pins the selection properties that make it *directed* (not blind): pins are never worth
spending on, corpus-absent (only-knowable-by-acting) questions rank highest, confident priors
rank low, and the budget is respected greedily by VoI-per-cost.
"""
from __future__ import annotations

from experiments.oracle_active_loop import Question
from experiments.oracle_voi_select import prior_entropy, cost_of, score, select


def _q(id, **kw):
    kw.setdefault("text", id)
    kw.setdefault("act", lambda: id)
    return Question(id=id, **kw)


def test_pin_has_zero_voi():
    assert prior_entropy(_q("p", actionable=False)) == 0.0


def test_corpus_absent_is_max_voi():
    # Only acting can resolve it → highest value.
    assert prior_entropy(_q("a", inference_reachable=False)) == 1.0


def test_confident_prior_is_low_voi_uncertain_prior_is_higher():
    confident = _q("c", inference_reachable=True, passive=1, passive_conf=0.9)
    unsure = _q("u", inference_reachable=True, passive=1, passive_conf=0.2)
    assert prior_entropy(confident) == 0.1
    assert prior_entropy(unsure) == 0.8
    assert prior_entropy(unsure) > prior_entropy(confident)


def test_cost_hook_defaults_to_one():
    assert cost_of(_q("x")) == 1.0
    q = _q("y"); q.cost = 5.0
    assert cost_of(q) == 5.0


def test_ranking_is_by_voi_per_cost():
    cheap_absent = _q("cheap", inference_reachable=False)              # voi 1.0 / cost 1 = 1.0
    dear_absent = _q("dear", inference_reachable=False); dear_absent.cost = 4.0  # 1.0/4 = 0.25
    unsure = _q("unsure", inference_reachable=True, passive_conf=0.5)  # voi 0.5 / 1 = 0.5
    ranked = [s.q.id for s in score([dear_absent, unsure, cheap_absent])]
    assert ranked == ["cheap", "unsure", "dear"]   # 1.0 > 0.5 > 0.25


def test_select_excludes_pins_and_respects_budget():
    qs = [
        _q("absent1", inference_reachable=False),          # voi 1, cost 1
        _q("absent2", inference_reachable=False),          # voi 1, cost 1
        _q("pin", actionable=False),                       # voi 0 — never chosen
        _q("confident", inference_reachable=True, passive_conf=0.95),  # voi 0.05 — low
    ]
    plan = select(qs, budget=2.0)
    chosen = {s.q.id for s in plan["chosen"]}
    assert "pin" not in chosen                             # pins excluded (VoI 0)
    assert chosen == {"absent1", "absent2"}                # the two max-VoI fit the budget
    assert plan["spent"] == 2.0
    assert any(s.q.id == "pin" for s in plan["skipped_pin"])
    # the low-VoI confident question was budget-skipped, not chosen
    assert "confident" not in chosen


def test_directed_beats_blind_on_captured_voi():
    # With a tight budget, VoI steering captures more value than taking the first-listed.
    qs = [
        _q("low", inference_reachable=True, passive_conf=0.9),   # voi 0.1
        _q("high", inference_reachable=False),                   # voi 1.0
    ]
    plan = select(qs, budget=1.0)          # room for exactly one
    assert [s.q.id for s in plan["chosen"]] == ["high"]         # picks the high-VoI one
    assert plan["total_voi_captured"] == 1.0
