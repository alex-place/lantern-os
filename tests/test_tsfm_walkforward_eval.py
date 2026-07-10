"""
Tests for the TSFM walk-forward forecast gate (experiments/tsfm_walkforward_eval.py).

Deterministic — no data files or served endpoint needed. Verifies the metric that
the numeric/TSFM route is gated on: MASE (beats-naive) and directional accuracy
behave correctly on series with known answers.
"""

import sys
from pathlib import Path

import pytest

# The harness lives in experiments/, which is not on pytest's pythonpath (apps src).
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "experiments"))

import tsfm_walkforward_eval as wf  # noqa: E402


def test_naive_mase_is_one_on_a_linear_trend():
    # Naive lags a constant-slope series by exactly the slope every step, and the
    # MASE scale IS that slope -> MASE == 1.0 by construction.
    series = {"lin": [float(i) for i in range(60)]}
    res = wf.evaluate(series, {"naive": wf.f_naive})
    assert res["naive"]["mase"] == pytest.approx(1.0, abs=1e-6)


def test_drift_beats_naive_on_a_linear_trend():
    # Random-walk-with-drift predicts a linear trend perfectly -> MASE ~ 0, dir 1.0.
    series = {"lin": [float(i) for i in range(60)]}
    res = wf.evaluate(series, {"naive": wf.f_naive, "drift": wf.f_drift})
    assert res["drift"]["mase"] < 1e-6
    assert res["drift"]["directional_acc"] == pytest.approx(1.0)
    assert res["drift"]["mase"] < res["naive"]["mase"]


def test_verdict_requires_both_mase_and_direction():
    # A forecaster with MASE<1 but coin-flip direction must NOT pass.
    results = {
        "naive": {"mase": 1.0, "directional_acc": 0.5},
        "good": {"mase": 0.8, "directional_acc": 0.62},
        "sharp_but_blind": {"mase": 0.9, "directional_acc": 0.49},
        "_meta": {},
    }
    by_name = {v["forecaster"]: v for v in wf.verdict(results)}
    assert by_name["good"]["beats_naive"] is True
    assert by_name["sharp_but_blind"]["beats_naive"] is False
    assert "naive" not in by_name  # naive is the baseline, never judged


def test_dark_tsfm_endpoint_is_unavailable_without_env(monkeypatch):
    # No TSFM_ENDPOINT -> the forecaster reports dark and is skipped, not crashed.
    monkeypatch.delenv("TSFM_ENDPOINT", raising=False)
    f = wf.TsfmEndpointForecaster(endpoint=None)
    assert f.available is False
    assert "TSFM_ENDPOINT" in f.note


def test_selftest_entrypoint_passes():
    assert wf._selftest() == 0
