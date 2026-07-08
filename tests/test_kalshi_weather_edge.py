"""Tests for the Σ₀ weather-edge probe (experiments/kalshi_weather_edge.py).

These pin the MEASURED conclusions against the FITTED model (data/kalshi/
weather-oracle-params.json, loaded by the experiment as of #2219) so they can't
silently drift: the routine day carries the measured warm bias, the band gate stands
down against a self-consistent market, the extreme day has the ≥100 °F ceiling active,
and the ≥100 fade survives the whole band. The fitted correction inverted the raw
downshift (default coolBias +1.2 → fitted −1.43, a ~2.6 °F warm shift), moving the
routine-day modal 94-95 → 98-99 — so the old default-param assertions were dropped.
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "experiments"))
import kalshi_weather_edge as kwe  # noqa: E402


def test_routine_day_tail_is_thin():
    # Forecast 96 °F → ≥100 essentially off the table (fitted model: P ≈ 0.03).
    d = kwe.calibrated_distribution(96, 1, kwe.JUL1_LADDER)
    assert d[">=100"] < 0.05


def test_routine_day_carries_measured_warm_bias():
    # The fitted correction runs KNYC ~2.6 °F warmer than the naive forecast bucket, so a
    # 96 °F forecast concentrates in the upper buckets (modal 98-99), NOT the naive 94-95.
    d = kwe.calibrated_distribution(96, 1, kwe.JUL1_LADDER)
    assert max(d, key=d.get) in ("96-97", "98-99")
    assert d["96-97"] + d["98-99"] > 0.5


def test_band_gate_stands_down_vs_self_consistent_market():
    # The band gate must still DISCRIMINATE: quoted a market at the fitted fair value, no
    # edge survives the band. (The old test used a 2026-07-01 live snapshot the fitted model
    # now disagrees with — that phantom-edge question can't be settled without that day's
    # settled high, so efficiency is re-anchored to a self-consistent market. See #2219.)
    fair = kwe.calibrated_distribution(96, 1, kwe.JUL1_LADDER)
    rep = kwe.robust_edge_report(96, 1, kwe.JUL1_LADDER, fair)
    assert rep["actionable"] == []
    assert rep["verdict"] == "no certified edge"


def test_extreme_day_ceiling_caps_the_tail():
    # Forecast 102 °F: the ≥100 record ceiling keeps P(≥100) far below the naive
    # Gaussian ~0.5 — measured band is (0.05, 0.20).
    d = kwe.calibrated_distribution(102, 3, kwe.HOT_LADDER)
    p100 = d["100-101"] + d[">=102"]
    assert 0.05 < p100 < 0.20


def test_extreme_day_fade_is_band_robust():
    # ≥100 priced richly (40¢) on a 102 °F forecast → NO side clears the whole band.
    rep = kwe.robust_edge_report(102, 3, kwe.HOT_LADDER, kwe.HOTDAY_ASK_HYPO)
    fade = next((r for r in rep["actionable"] if r["bucket"] == "100-101"), None)
    assert fade is not None and fade["side"] == "no" and fade["worst_c"] > 15


def test_distribution_normalizes():
    d = kwe.calibrated_distribution(96, 1, kwe.JUL1_LADDER)
    assert abs(sum(d.values()) - 1.0) < 1e-9


def test_kalshi_fee_formula():
    assert kwe.kalshi_fee_cents(0.40) == 2
    assert kwe.kalshi_fee_cents(0.09) == 1
    assert kwe.kalshi_fee_cents(0.50) == 2


def test_selfcheck_passes():
    assert kwe.selfcheck() == 0


def test_convergence_record_is_grounded_and_modest():
    d = kwe.calibrated_distribution(96, 1, kwe.JUL1_LADDER)
    rep = kwe.robust_edge_report(96, 1, kwe.JUL1_LADDER, kwe.JUL1_ASK)
    rec = kwe.convergence_record("26JUL01", 96, d, rep, ["nws-forecast", "kalshi-live"])
    assert rec["confidence"] <= 0.6          # no confidence laundering
    assert rec["evidence_ids"]               # external grounding present
    assert "KNYC" in rec["grounding"]
