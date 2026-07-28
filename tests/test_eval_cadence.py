"""Tests for the eval-cadence planner's prioritization (#2766).

The one rule that matters — and the thing the operator asked for — is that the next eval run
goes to the mark that is UNSATURATED and MOST STALE (highest information per hour), never to a
saturated tripwire just because it's easy to re-run. That rule lives in the pure `rank_marks`
function, which is ts-agnostic (takes `saturated` + `age_days`), so it is tested here without
touching the ledgers.
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))

from eval_cadence import rank_marks  # noqa: E402


def _keys(marks):
    return [m["key"] for m in rank_marks(marks)]


def test_unsaturated_marks_always_outrank_saturated_regardless_of_age():
    # A saturated mark that is ancient must still sort BELOW a fresh unsaturated one — being
    # saturated makes it a tripwire, not a priority.
    marks = [
        {"key": "humaneval", "saturated": True, "age_days": 400},   # ancient but saturated
        {"key": "swebench", "saturated": False, "age_days": 1},     # fresh but unsaturated
    ]
    assert _keys(marks) == ["swebench", "humaneval"]


def test_within_unsaturated_the_stalest_runs_first():
    marks = [
        {"key": "honesty", "saturated": False, "age_days": 3},
        {"key": "longmem", "saturated": False, "age_days": 30},
        {"key": "swebench", "saturated": False, "age_days": 10},
    ]
    assert _keys(marks) == ["longmem", "swebench", "honesty"]


def test_a_never_run_unsaturated_mark_is_the_single_highest_priority():
    # A missing number is maximally stale — the most action-guiding line on the board.
    marks = [
        {"key": "longmem", "saturated": False, "age_days": 99},
        {"key": "swebench", "saturated": False, "age_days": None},  # never run
        {"key": "honesty", "saturated": False, "age_days": 5},
    ]
    assert _keys(marks)[0] == "swebench"


def test_never_run_beats_any_finite_age_but_saturation_still_dominates():
    # never-run sorts to the top of its own class, not above the whole board: a never-run
    # SATURATED mark must not outrank a stale UNSATURATED one.
    marks = [
        {"key": "coding", "saturated": True, "age_days": None},     # never run, saturated
        {"key": "swebench", "saturated": False, "age_days": 20},    # stale, unsaturated
    ]
    assert _keys(marks) == ["swebench", "coding"]


def test_saturated_class_also_orders_by_staleness():
    marks = [
        {"key": "humaneval", "saturated": True, "age_days": 5},
        {"key": "coding", "saturated": True, "age_days": 50},
    ]
    assert _keys(marks) == ["coding", "humaneval"]


def test_rank_is_stable_and_total_over_the_real_registry():
    from eval_cadence import MARKS
    ranked = rank_marks([{**m, "age_days": 10} for m in MARKS])
    # every real mark appears exactly once, unsaturated block strictly before saturated block
    assert len(ranked) == len(MARKS)
    sat_flags = [m["saturated"] for m in ranked]
    assert sat_flags == sorted(sat_flags)  # False(s) then True(s), no interleaving
