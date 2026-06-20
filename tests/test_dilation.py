"""
tests/test_dilation.py — unit tests for convergence_io.dilation
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from convergence_io.dilation import (
    dilation, DilationField, SwapConvergenceGuard, D_MIN, D_MAX, D_DEFAULT,
    grounding_policy, GroundingPolicy,
)


# ── dilation() scalar ─────────────────────────────────────────────────────────

def test_dilation_high_uncertainty_inflates():
    d_high = dilation(uncertainty=0.9, cost_pressure=0.0, confidence=0.5)
    d_low  = dilation(uncertainty=0.1, cost_pressure=0.0, confidence=0.5)
    assert d_high > d_low


def test_dilation_high_confidence_deflates():
    d_high = dilation(uncertainty=0.5, cost_pressure=0.0, confidence=0.9)
    d_low  = dilation(uncertainty=0.5, cost_pressure=0.0, confidence=0.1)
    assert d_high < d_low


def test_dilation_high_cost_pressure_deflates():
    d_high = dilation(uncertainty=0.5, cost_pressure=0.9, confidence=0.5)
    d_low  = dilation(uncertainty=0.5, cost_pressure=0.1, confidence=0.5)
    assert d_high < d_low


def test_dilation_clamped_min():
    # All factors maximally deflationary
    d = dilation(uncertainty=0.0, cost_pressure=1.0, confidence=1.0)
    assert d >= D_MIN


def test_dilation_clamped_max():
    # All factors maximally inflationary
    d = dilation(uncertainty=1.0, cost_pressure=0.0, confidence=0.0)
    assert d <= D_MAX


def test_dilation_clamps_inputs():
    # Out-of-range inputs should not crash
    d = dilation(uncertainty=5.0, cost_pressure=-1.0, confidence=2.0)
    assert D_MIN <= d <= D_MAX


def test_dilation_neutral():
    # uncertainty=0.5, cost_pressure=0, confidence=0.5 → close to 1.0
    d = dilation(0.5, 0.0, 0.5)
    assert 0.8 < d < 1.5  # should be near 1.0


# ── DilationField ─────────────────────────────────────────────────────────────

def test_field_default_for_unknown():
    f = DilationField()
    assert f.get("unknown-node") == D_DEFAULT


def test_field_update_and_get():
    f = DilationField()
    d = f.update_node("n1", uncertainty=0.8, cost_pressure=0.0, confidence=0.2)
    assert f.get("n1") == d
    assert D_MIN <= d <= D_MAX


def test_field_update_from_health_healthy():
    f = DilationField()
    d = f.update_from_health("n1", health=1.0, latency_ratio=1.0)
    # Fully healthy, on target → low dilation (fast path)
    assert d <= 1.0


def test_field_update_from_health_degraded():
    f = DilationField()
    d_good = f.update_from_health("n1", health=1.0, latency_ratio=1.0)
    d_bad  = f.update_from_health("n2", health=0.2, latency_ratio=3.0)
    assert d_bad > d_good


def test_field_snapshot():
    f = DilationField()
    f.update_node("a", 0.5, 0.0, 0.5)
    f.update_node("b", 0.8, 0.2, 0.3)
    snap = f.snapshot()
    assert "a" in snap and "b" in snap
    assert all(D_MIN <= v <= D_MAX for v in snap.values())


def test_field_apply_to_graph():
    """DilationField.apply_to_graph() writes values into node.dilation."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
    from convergence_io.ceg import CEGraph, ResourceNode, ResourceKind
    g = CEGraph()
    node = ResourceNode(label="anthropic", provider_id="anthropic",
                        resource_kind=ResourceKind.LLM)
    g.add_node(node)
    f = DilationField()
    f.update_node(node.node_id, uncertainty=0.8, cost_pressure=0.0, confidence=0.2)
    f.apply_to_graph(g)
    assert g.get_node(node.node_id).dilation == f.get(node.node_id)


# ── SwapConvergenceGuard ──────────────────────────────────────────────────────

def test_guard_no_oscillation_initially():
    g = SwapConvergenceGuard(max_swaps=3, window_ticks=10)
    assert not g.is_oscillating("a", "b", current_tick=1)


def test_guard_detects_oscillation():
    g = SwapConvergenceGuard(max_swaps=3, window_ticks=10)
    g.record_swap("a", "b", 1)
    g.record_swap("a", "b", 2)
    g.record_swap("a", "b", 3)
    assert g.is_oscillating("a", "b", current_tick=4)


def test_guard_expires_old_events():
    g = SwapConvergenceGuard(max_swaps=3, window_ticks=5)
    g.record_swap("a", "b", 1)
    g.record_swap("a", "b", 2)
    g.record_swap("a", "b", 3)
    # Tick 10 → all prior records outside window of 5
    assert not g.is_oscillating("a", "b", current_tick=10)


def test_guard_reset():
    g = SwapConvergenceGuard(max_swaps=2, window_ticks=10)
    g.record_swap("x", "y", 1)
    g.record_swap("x", "y", 2)
    assert g.is_oscillating("x", "y", current_tick=3)
    g.reset("x", "y")
    assert not g.is_oscillating("x", "y", current_tick=3)


# ── G12: collapse-proximity sign-fix + livelock guard (#764) ───────────────────

def test_collapse_proximity_deflates_not_inflates():
    """Near collapse, dilation must DEFLATE toward D_MIN, not pin at D_MAX."""
    # high uncertainty, low confidence = the regime that pins D high...
    d_far = dilation(uncertainty=1.0, cost_pressure=0.0, confidence=0.0, collapse_proximity=0.0)
    d_near = dilation(uncertainty=1.0, cost_pressure=0.0, confidence=0.0, collapse_proximity=1.0)
    assert d_far > d_near                       # proximity collapses the dilation
    assert d_near == pytest.approx(D_MIN, abs=1e-9)  # proximity=1 ⇒ D_MIN (go look / act)


def test_collapse_proximity_zero_is_backward_compatible():
    base = dilation(0.7, 0.1, 0.3)
    assert dilation(0.7, 0.1, 0.3, collapse_proximity=0.0) == pytest.approx(base)


def test_collapse_proximity_monotone():
    vals = [dilation(0.9, 0.0, 0.1, collapse_proximity=p) for p in (0.0, 0.25, 0.5, 0.75, 1.0)]
    assert all(vals[i] >= vals[i + 1] for i in range(len(vals) - 1))  # monotone down


def test_field_livelock_guard_forces_dmin():
    """A node pinned near D_MAX longer than max_dwell_ticks is forced to D_MIN."""
    f = DilationField(max_dwell_ticks=3, dwell_threshold=1.5)
    d = D_DEFAULT
    for _ in range(3):                          # within budget: stays in the slow region
        d = f.update_node("stuck", uncertainty=1.0, cost_pressure=0.0, confidence=0.0)
    assert d == pytest.approx(2.0, abs=1e-9)    # elevated (formula's practical ceiling ~2.0)
    d = f.update_node("stuck", uncertainty=1.0, cost_pressure=0.0, confidence=0.0)  # exceeds dwell
    assert d == pytest.approx(D_MIN, abs=1e-9)  # livelock broken → forced to D_MIN


# ── grounding_policy: the within→without bridge (#764, #731) ───────────────────

def test_grounding_policy_low_dilation_is_cheap():
    pol = grounding_policy(0.4, base_max_results=5, base_min_sources=2)
    assert pol.fetch_external is False and pol.deep_mode is False and pol.max_results == 5


def test_grounding_policy_high_dilation_grounds_harder():
    lo = grounding_policy(1.0, base_max_results=5, base_min_sources=2)
    hi = grounding_policy(4.0, base_max_results=5, base_min_sources=2)
    assert hi.max_results > lo.max_results       # wider web breadth
    assert hi.min_sources >= lo.min_sources      # higher corroboration floor
    assert hi.deep_mode is True and lo.deep_mode is False
    assert hi.fetch_external is True


def test_grounding_policy_monotone_in_dilation():
    mrs = [grounding_policy(d).max_results for d in (D_MIN, 0.5, 1.0, 2.0, 3.0, D_MAX)]
    assert all(mrs[i] <= mrs[i + 1] for i in range(len(mrs) - 1))
