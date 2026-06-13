"""
tests/test_dilation.py — unit tests for convergence_io.dilation
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from convergence_io.dilation import (
    dilation, DilationField, SwapConvergenceGuard, D_MIN, D_MAX, D_DEFAULT,
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
