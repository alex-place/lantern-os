"""Regression tests for the scheduled-vs-reactive grounding race
(SIGMA0-COLLAPSE-CERTIFICATE §3.1 design consequence; issue #2690 Phase 0;
experiments/sigma0_scheduled_grounding.py).

Fast: reduced seeds and a coarser budget grid — these pin the *ordering* facts the
certificate cites (a usable canary exists, it alarms after the cadence tick, waiting
for it costs a >=1.3x budget premium, and the sliver regime is timing-indifferent),
not the headline constants (which come from the committed 200-seed run report).
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "experiments"))
pytest.importorskip("scipy")  # scipy-free CI must skip, not fail collection (#862 convention)
import sigma0_scheduled_grounding as m  # noqa: E402

SEEDS = 60


def _well():
    return m.make_case(np.diag([0.9, 0.92, 0.95]), label="well_conditioned")


def _sliver():
    return m.make_case(np.array([[0.6, 9.0, 3.0], [0.0, 0.7, 9.0], [0.0, 0.0, 0.8]]),
                       label="nonnormal_sliver")


def _calibrated(case):
    healthy, collapse = m.gen_traces(case, SEEDS)
    chosen = m.pick_theta(m.threshold_sweep(healthy, collapse))
    return healthy, collapse, chosen


def test_deterministic():
    case = _well()
    h1, c1 = m.gen_traces(case, 8)
    h2, c2 = m.gen_traces(case, 8)
    assert h1 == h2
    assert all(np.array_equal(a, b) for xs1, xs2 in zip(c1, c2)
               for a, b in zip(xs1[0], xs2[0]))
    assert [s for _, s in c1] == [s for _, s in c2]


def test_canary_usable_and_late():
    case = _well()
    _, _, chosen = _calibrated(case)
    assert chosen is not None, "no canary threshold satisfies the FPR cap"
    assert chosen["fpr"] <= m.FPR_CAP
    # The alarm lands well after the scheduled tick — past the cheap window.
    assert chosen["median_alarm"] > case["cadence"] + case["half_life"], chosen


def test_scheduled_beats_reactive_at_mid_budget():
    case = _well()
    _, collapse, chosen = _calibrated(case)
    r = m.race(case, 0.4 * case["B_star_inf"], chosen["theta"], collapse)
    assert r["scheduled_success"] >= 0.8, r
    assert r["reactive_success"] <= 0.2, r


def test_alarm_premium_well_conditioned():
    case = _well()
    _, collapse, chosen = _calibrated(case)
    budgets = [round(r * case["B_star_inf"], 4) for r in (0.2, 0.3, 0.4, 0.5, 0.7, 0.9, 1.0)]
    rows = [m.race(case, B, chosen["theta"], collapse) for B in budgets]
    mb_s = m.min_budget_for(rows, "scheduled_success")
    mb_r = m.min_budget_for(rows, "reactive_success")
    assert mb_s is not None
    # Reactive either never reaches 90% on this grid or pays a >=1.3x budget premium.
    assert mb_r is None or mb_r / mb_s >= 1.3, (mb_s, mb_r)


def test_sliver_timing_indifferent():
    case = _sliver()
    _, collapse = m.gen_traces(case, SEEDS)
    grid = m.timing_sweep(case, (0.05, 0.4), (1, 20, 39), collapse)
    assert all(v >= 0.95 for row in grid.values() for v in row.values()), grid


def test_committed_report_matches_verdict():
    report_path = Path(__file__).resolve().parent.parent / "data" / "sigma0" / \
        "scheduled_grounding_report.json"
    if not report_path.exists():
        import pytest
        pytest.skip("run experiments/sigma0_scheduled_grounding.py to produce the report")
    import json
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["verdict_ok"] is True
    well = next(c for c in report["cases"] if c["label"] == "well_conditioned")
    assert well["alarm_premium_unbounded"] or well["alarm_premium"] >= 1.3
    sliver = next(c for c in report["cases"] if c["label"] == "nonnormal_sliver")
    assert sliver["timing_indifferent"] is True
