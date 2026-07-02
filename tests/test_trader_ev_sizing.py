"""
Tests for the Σ₀ trader EV/sizing improvements (convergence_ev):

  1. edge_risk_multiplier — bounded half-Kelly on the flat-$ risk.
  2. target_r consistency — a higher reward:risk raises EV monotonically, so the
     fix that feeds the *real* 3R (vs the old ~2R profile ratio) can only make a
     genuinely-3R setup more likely to clear the EV bar, never a junk one (P_MIN
     and the evidence floor still gate).

Pure module — no Alpaca / OpenAI / DB, so this runs in CI without keys.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "trading_agents"))

from convergence_ev import (
    edge_risk_multiplier, score_convergence, EV_MIN, P_MIN,
    per_signal_lift, adapt_weights, WEIGHTS,
)


# ── edge_risk_multiplier ───────────────────────────────────────────────────────

def test_multiplier_is_bounded():
    for p in (0.30, 0.46, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9):
        for r in (1.0, 2.0, 3.0):
            assert 0.5 <= edge_risk_multiplier(p, r) <= 1.5


def test_multiplier_is_risk_neutral_at_coinflip():
    # The whole point of the recalibration: a neutral 50% setup sizes at exactly
    # the flat risk (1.0×), so the scaler does not blanket-inflate risk.
    assert edge_risk_multiplier(0.50, 3.0) == pytest.approx(1.0, abs=1e-6)


def test_multiplier_scales_with_conviction():
    low = edge_risk_multiplier(0.48, 3.0)
    mid = edge_risk_multiplier(0.55, 3.0)
    high = edge_risk_multiplier(0.62, 3.0)
    assert low < mid < high
    assert edge_risk_multiplier(0.60, 3.0) == 1.5    # +0.10 conviction → cap
    assert edge_risk_multiplier(0.40, 3.0) == 0.5    # −0.10 conviction → floor


def test_multiplier_leans_out_on_weak_conviction():
    assert edge_risk_multiplier(0.45, 3.0) == pytest.approx(0.75, abs=1e-6)
    assert edge_risk_multiplier(0.30, 1.5) == 0.5    # far below neutral → floor


def test_multiplier_safe_on_bad_input():
    assert edge_risk_multiplier(None, 3.0) == 1.0
    assert edge_risk_multiplier("x", 3.0) == 1.0
    assert edge_risk_multiplier(0.6, 0) == 1.0       # invalid target_r guard
    assert edge_risk_multiplier(1.5, 3.0) == 1.0     # p out of (0,1)
    assert edge_risk_multiplier(0.6) == 1.5          # target_r optional


# ── target_r consistency in the EV gate ────────────────────────────────────────

def _base_candidate(target_r):
    # A modestly-graded real setup: at a zone, structure shifted, trend aligned.
    return {
        "direction": "BULLISH",
        "in_zone": True, "zone_strength": 60, "zone_touches": 2,
        "structure_shifted": True, "structure_conf": 65,
        "trend_aligned": True,
        "backtest_winrate": 0.5,
        "target_r": target_r,
    }


def test_higher_target_r_raises_ev_monotonically():
    ev2 = score_convergence(_base_candidate(2.0))
    ev3 = score_convergence(_base_candidate(3.0))
    assert ev3["ev_r"] > ev2["ev_r"]          # same p_win, bigger payoff → bigger EV
    assert ev3["p_win"] == ev2["p_win"]        # target_r must not move p_win


def test_evidence_floor_still_gates_regardless_of_target_r():
    # No grounding evidence at all → SKIP even with a huge target_r (can't be
    # carried by an optimistic reward:risk). This is the External-Reality guard.
    naked = {"direction": "BULLISH", "backtest_winrate": 0.8, "target_r": 10.0}
    out = score_convergence(naked)
    assert out["decision"] == "SKIP"


def test_enter_requires_both_ev_and_pwin_bars():
    out = score_convergence(_base_candidate(3.0))
    if out["decision"] == "ENTER":
        assert out["ev_r"] >= EV_MIN and out["p_win"] >= P_MIN


def test_custom_weights_override_base():
    cand = _base_candidate(3.0)
    base = score_convergence(cand)
    # Zero out every weight → p_win collapses to the base_rate (0.5 here).
    flat = score_convergence(cand, weights={k: 0.0 for k in WEIGHTS})
    assert flat["p_win"] == pytest.approx(0.5, abs=1e-9)
    assert base["p_win"] > flat["p_win"]        # real weights add edge


# ── per_signal_lift / adapt_weights (closed learning loop) ─────────────────────

def _row(zone_strong, win):
    # A graded outcome row: zone fired strong/weak, structure always neutral.
    return {"signals": {"zone": 0.9 if zone_strong else 0.3, "structure": 0.5},
            "outcome": bool(win)}


def test_per_signal_lift_detects_predictive_signal():
    # zone strong → win, zone weak → loss: a clean +1.0 lift.
    rows = [_row(True, True) for _ in range(10)] + [_row(False, False) for _ in range(10)]
    edge = per_signal_lift(rows)
    assert edge["zone"]["lift"] == pytest.approx(1.0)
    assert edge["zone"]["strong_wr"] == 1.0 and edge["zone"]["weak_wr"] == 0.0


def test_adapt_weights_noop_when_immature():
    # < ADAPT_MIN_ROWS rows → weights untouched.
    rows = [_row(True, True) for _ in range(10)]
    assert adapt_weights(rows) == dict(WEIGHTS)
    assert adapt_weights([]) == dict(WEIGHTS)


def test_adapt_weights_boosts_predictive_signal_bounded():
    rows = [_row(True, True) for _ in range(12)] + [_row(False, False) for _ in range(12)]
    adapted = adapt_weights(rows)
    # zone predicted perfectly → its weight goes UP, capped at +50% (bound 1.5).
    assert adapted["zone"] > WEIGHTS["zone"]
    assert adapted["zone"] == pytest.approx(WEIGHTS["zone"] * 1.5, abs=1e-4)
    # structure never varied (all 0.5 → all "weak") → one bucket empty → untouched.
    assert adapted["structure"] == WEIGHTS["structure"]


def test_adapt_weights_penalizes_anti_predictive_signal():
    # zone strong → LOSS, weak → WIN: negative lift → weight scaled DOWN to floor.
    rows = [_row(True, False) for _ in range(12)] + [_row(False, True) for _ in range(12)]
    adapted = adapt_weights(rows)
    assert adapted["zone"] == pytest.approx(WEIGHTS["zone"] * 0.5, abs=1e-4)


def test_adapt_weights_respects_min_bucket():
    # 20 rows but only 2 with zone strong → below ADAPT_MIN_BUCKET → zone untouched.
    rows = ([_row(True, True) for _ in range(2)]
            + [_row(False, False) for _ in range(18)])
    adapted = adapt_weights(rows)
    assert adapted["zone"] == WEIGHTS["zone"]
