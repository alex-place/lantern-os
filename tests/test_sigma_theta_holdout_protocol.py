"""Regression tests for the E-B three-arm holdout protocol
(SIGMA0-COLLAPSE-CERTIFICATE §8.4 / issue #2691;
experiments/sigma_theta_abc/holdout_protocol.py).

Fast: reduced seeds/gates — these pin the *ordering* facts and the teeth semantics
(fixed arm has the worst validity gap and extraction; the E-P dither knob rescues the
fixed arm for free; fresh flow extracts most but consumes ~60x the tasks; Thresholdout
beats fresh per task consumed; planted hack/forgetting candidates are rejected by the
REAL 7-condition gate with arm-appropriate reasons), not the committed 16-seed report's
constants.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "experiments" / "sigma_theta_abc"))
pytest.importorskip("scipy")  # scipy-free CI must skip, not fail collection (#862 convention)
import holdout_protocol as m  # noqa: E402

SEEDS, GATES = 6, 25


def test_deterministic():
    a = m.run_seed(3, gates=10)
    b = m.run_seed(3, gates=10)
    assert a == b


def test_stuck_evaluation_is_reproducible():
    c = m.Candidate(0.4, 12345)
    ids = m.np.arange(500, 560, dtype=m.np.int64)
    assert m.eval_candidate(c, ids) == m.eval_candidate(c, ids)


def test_arm_orderings():
    agg = m.simulate(seeds=SEEDS, gates=GATES)
    # validity: naive fixed reuse has the worst reported-vs-true gap
    assert agg["fixed"]["gap"] > agg["fresh"]["gap"], agg
    assert agg["fixed"]["gap"] > agg["thresholdout"]["gap"], agg
    # extraction: fresh flow is best; the dither knob rescues the fixed arm for free
    assert agg["fresh"]["true"] >= agg["fixed"]["true"], agg
    assert agg["fixed+dither"]["true"] > agg["fixed"]["true"], agg
    assert agg["fixed+dither"]["fresh_consumed"] == agg["fixed"]["fresh_consumed"]
    # efficiency: thresholdout beats fresh per fresh task consumed
    assert agg["thresholdout"]["extraction_per_100_fresh"] > agg["fresh"]["extraction_per_100_fresh"], agg


def test_teeth_rejected_with_arm_appropriate_reasons():
    t = m.teeth()
    for name, r in t.items():
        assert r["hack_rejected"], (name, r)
        assert r["forget_rejected"], (name, r)
        assert "2_retention" in r["forget_failed"], (name, r)
    # the fixed arm can only catch the contaminated hack via the provenance ledger...
    assert "6_data_integrity" in t["fixed"]["hack_failed"], t["fixed"]
    # ...while the fresh arm catches it on measured merit (memorization useless on unseen tasks)
    assert any(k in t["fresh"]["hack_failed"] for k in ("1_fresh_gain", "3_reward_integrity")), t["fresh"]


def test_thresholdout_budget_accounting():
    arm = m.ThresholdoutArm(seed=0, arm_idx=9)
    arm.budget = 1
    # a candidate whose pool and sealed estimates disagree wildly forces a holdout spend
    weak = m.Candidate(-3.0, 999_001)
    weak.seen.update(int(i) for i in arm.pool_ids)   # contaminated on the pool only
    m.eval_candidate(weak, arm.pool_ids)             # sanity: callable
    # drive reads until the budget is spent; exhaustion must flip and stick
    for cid in range(999_002, 999_040):
        arm.read(m.Candidate(float(cid % 7) - 3.0, cid))
        if arm.exhausted:
            break
    assert arm.exhausted and arm.budget <= 0


def test_committed_report_all_ok():
    report_path = Path(__file__).resolve().parent.parent / "data" / "sigma0" / \
        "holdout_protocol_report.json"
    if not report_path.exists():
        import pytest
        pytest.skip("run experiments/sigma_theta_abc/holdout_protocol.py --simulate first")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["all_ok"] is True
    assert all(report["checks"].values()), report["checks"]
