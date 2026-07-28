"""Tests for the oracle-router ceiling analyzer (#2998 slice 3).

The live cascade logs are currently degenerate (the cheap tier solves every task, so there are
no escalations to optimize). These synthetic rows exercise the cases that matter — wasted
escalations, oracle savings, unsolvable tasks — so the ceiling math is pinned independently of
whatever the ledger happens to hold today.
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))

from spiral_oracle_ceiling import analyze, load_rows  # noqa: E402


def row(task, cheap_ok, frontier_ok, cl=1.0, fl=5.0):
    return {"task": task, "cheap_ok": cheap_ok, "frontier_ok": frontier_ok,
            "cheap_lat": cl, "frontier_lat": fl}


def test_wasted_escalation_is_counted_as_router_headroom():
    # cheap fails on both t2,t3; frontier saves t2 but NOT t3 -> the t3 escalation is pure waste
    # a perfect router would skip. cascade escalates twice; oracle escalates once.
    rows = [row("t1", True, True), row("t2", False, True), row("t3", False, False)]
    r = analyze(rows)
    assert r["cascade_actual"]["frontier_calls"] == 2      # both cheap-fails escalate
    assert r["oracle_router"]["frontier_calls"] == 1       # only the one that pays off
    assert r["ceiling"]["wasted_escalations_both_fail"] == 1
    assert r["ceiling"]["frontier_calls_saved_by_perfect_router"] == 1
    assert r["ceiling"]["frontier_call_reduction_pct"] == 50.0


def test_cheap_solves_everything_means_zero_headroom():
    rows = [row("t1", True, False), row("t2", True, True)]
    r = analyze(rows)
    assert r["cascade_actual"]["frontier_calls"] == 0
    assert r["ceiling"]["frontier_calls_saved_by_perfect_router"] == 0
    assert "no headroom" in r["ceiling"]["verdict"]


def test_cascade_already_optimal_when_every_escalation_pays_off():
    # cheap fails on t2, frontier rescues it — the one escalation is necessary, not waste.
    rows = [row("t1", True, True), row("t2", False, True)]
    r = analyze(rows)
    assert r["cascade_actual"]["frontier_calls"] == 1
    assert r["oracle_router"]["frontier_calls"] == 1
    assert r["ceiling"]["frontier_calls_saved_by_perfect_router"] == 0
    assert "already oracle-optimal" in r["ceiling"]["verdict"]


def test_router_never_raises_solve_rate_over_the_cascade():
    # cascade and oracle both solve every any-tier-solvable task, so the ONLY axis a router can
    # win on is rented calls — the solve-rate gain must be exactly 0, never positive.
    rows = [row("t1", False, True), row("t2", False, False), row("t3", True, False)]
    r = analyze(rows)
    assert r["cascade_actual"]["solve_rate"] == r["oracle_router"]["solve_rate"]
    assert r["ceiling"]["solve_rate_gain_over_cascade"] == 0.0
    # unsolvable task (both fail) drags both policies below 1.0 identically
    assert r["oracle_router"]["solve_rate"] < 1.0


def test_unsolvable_task_is_not_counted_as_an_oracle_escalation():
    # both tiers fail t1: an oracle does NOT spend a rented call on a task it can't solve anyway.
    rows = [row("t1", False, False)]
    r = analyze(rows)
    assert r["oracle_router"]["frontier_calls"] == 0
    assert r["oracle_router"]["solved"] == 0


def test_rows_without_verdicts_are_skipped_not_crashed():
    import io
    import json
    import tempfile
    good = row("t1", True, True)
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8") as f:
        f.write(json.dumps(good) + "\n")
        f.write(json.dumps({"task": "nostate"}) + "\n")   # missing cheap_ok/frontier_ok
        f.write("not json\n")
        path = f.name
    rows, skipped = load_rows([path])
    assert len(rows) == 1 and skipped == 2
