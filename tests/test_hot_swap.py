"""
tests/test_hot_swap.py — unit tests for convergence_io.hot_swap
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from convergence_io.ceg import CEGraph, NodeKind, ResourceNode, ResourceKind, IntentNode
from convergence_io.hot_swap import HotSwapRegistry, SwapPolicy, SwapTrigger
from convergence_io.dilation import SwapConvergenceGuard


def _resource(provider_id="anthropic", health=1.0, cost=0.001, latency=500.0):
    return ResourceNode(
        label=provider_id,
        provider_id=provider_id,
        resource_kind=ResourceKind.LLM,
        capabilities=["chat"],
        cost_per_token=cost,
        latency_target_ms=latency,
        health=health,
    )


def _graph_with(node: ResourceNode) -> CEGraph:
    g = CEGraph()
    g.add_node(node)
    return g


def _healthy_state():
    return {
        "resource_health": {"anthropic": 1.0, "openai": 0.95},
        "resource_latency": {"anthropic": 500.0, "openai": 550.0},
    }


# ── Registration and rollback capture ─────────────────────────────────────────

def test_register_candidate():
    reg = HotSwapRegistry()
    old = _resource("anthropic")
    new = _resource("openai")
    reg.register_candidate(old.node_id, new)
    assert old.node_id in reg._candidates
    assert len(reg._candidates[old.node_id]) == 1


def test_register_deduplicates_by_provider():
    reg = HotSwapRegistry()
    old = _resource("anthropic")
    new1 = _resource("openai")
    new2 = _resource("openai")  # same provider
    reg.register_candidate(old.node_id, new1)
    reg.register_candidate(old.node_id, new2)
    assert len(reg._candidates[old.node_id]) == 1


def test_capture_rollback():
    reg = HotSwapRegistry()
    node = _resource("anthropic")
    reg.capture_rollback(node)
    assert node.node_id in reg._rollbacks


# ── Trigger detection ─────────────────────────────────────────────────────────

def test_no_trigger_healthy():
    reg = HotSwapRegistry(policy=SwapPolicy(health_threshold=0.4))
    node = _resource("anthropic", health=1.0)
    trigger = reg._check_triggers(
        node,
        state_health={"anthropic": 1.0},
        state_latency={"anthropic": 500.0},
        contract_max_cost=10.0,
    )
    assert trigger is None


def test_trigger_capability_degraded():
    reg = HotSwapRegistry(policy=SwapPolicy(health_threshold=0.5))
    node = _resource("anthropic", health=0.1)
    trigger = reg._check_triggers(
        node,
        state_health={"anthropic": 0.1},
        state_latency={"anthropic": 500.0},
        contract_max_cost=10.0,
    )
    assert trigger == SwapTrigger.CAPABILITY_DEGRADED


def test_trigger_latency_violation():
    reg = HotSwapRegistry(policy=SwapPolicy(latency_tolerance=2.0))
    node = _resource("anthropic", latency=500.0)
    node.dilation = 1.0
    trigger = reg._check_triggers(
        node,
        state_health={"anthropic": 1.0},
        state_latency={"anthropic": 1500.0},  # 3× target
        contract_max_cost=10.0,
    )
    assert trigger == SwapTrigger.LATENCY_VIOLATION


def test_trigger_cost_spike():
    reg = HotSwapRegistry(policy=SwapPolicy(cost_tolerance=1.5))
    node = _resource("anthropic", cost=0.01)
    trigger = reg._check_triggers(
        node,
        state_health={"anthropic": 1.0},
        state_latency={"anthropic": 500.0},
        contract_max_cost=0.001,  # node cost (0.01*1000=10) >> max_cost*1.5 (0.0015)
    )
    assert trigger == SwapTrigger.COST_SPIKE


# ── check_and_swap integration ────────────────────────────────────────────────

def test_swap_executes_on_trigger():
    reg = HotSwapRegistry(policy=SwapPolicy(health_threshold=0.5))
    old = _resource("anthropic", health=0.1)
    new = _resource("openai",    health=0.95)
    g = _graph_with(old)
    reg.register_candidate(old.node_id, new)
    events = reg.check_and_swap(
        g,
        resource_health={"anthropic": 0.1, "openai": 0.95},
        resource_latency={"anthropic": 500.0, "openai": 550.0},
        contract_max_cost=10.0,
        current_tick=1,
    )
    assert len(events) == 1
    assert events[0].success
    assert events[0].trigger == SwapTrigger.CAPABILITY_DEGRADED
    # Old node gone, new node in graph
    assert g.get_node(old.node_id) is None
    assert g.get_node(new.node_id) is not None


def test_no_swap_when_healthy():
    reg = HotSwapRegistry(policy=SwapPolicy(health_threshold=0.3))
    node = _resource("anthropic", health=1.0)
    new = _resource("openai")
    g = _graph_with(node)
    reg.register_candidate(node.node_id, new)
    events = reg.check_and_swap(
        g,
        resource_health={"anthropic": 1.0},
        resource_latency={"anthropic": 500.0},
        contract_max_cost=10.0,
        current_tick=1,
    )
    assert events == []


def test_no_swap_without_candidates():
    reg = HotSwapRegistry(policy=SwapPolicy(health_threshold=0.5))
    old = _resource("anthropic", health=0.1)
    g = _graph_with(old)
    # No candidate registered
    events = reg.check_and_swap(
        g,
        resource_health={"anthropic": 0.1},
        resource_latency={"anthropic": 500.0},
        contract_max_cost=10.0,
        current_tick=1,
    )
    assert events == []


def test_swap_emits_trace_node():
    reg = HotSwapRegistry(policy=SwapPolicy(health_threshold=0.5))
    old = _resource("anthropic", health=0.1)
    new = _resource("openai", health=0.95)
    g = _graph_with(old)
    reg.register_candidate(old.node_id, new)
    reg.check_and_swap(
        g,
        resource_health={"anthropic": 0.1, "openai": 0.95},
        resource_latency={"anthropic": 500.0},
        contract_max_cost=10.0,
        current_tick=1,
    )
    trace_nodes = g.nodes_by_kind(NodeKind.TRACE)
    assert len(trace_nodes) == 1


def test_summary():
    reg = HotSwapRegistry()
    summary = reg.summary()
    assert "total_swaps" in summary
    assert summary["total_swaps"] == 0


def test_oscillation_guard_blocks_repeated_swap():
    guard = SwapConvergenceGuard(max_swaps=2, window_ticks=10)
    reg = HotSwapRegistry(
        policy=SwapPolicy(health_threshold=0.5),
        convergence_guard=guard,
    )
    old = _resource("anthropic", health=0.1)
    new = _resource("openai", health=0.95)
    g = _graph_with(old)
    reg.register_candidate(old.node_id, new)

    # First swap succeeds
    events = reg.check_and_swap(
        g,
        resource_health={"anthropic": 0.1, "openai": 0.95},
        resource_latency={},
        contract_max_cost=10.0,
        current_tick=1,
    )
    assert len(events) == 1

    # Simulate reverse degradation so old is back and triggers again
    g2 = _graph_with(old)
    reg.register_candidate(old.node_id, new)
    guard.record_swap(old.node_id, new.node_id, tick=2)

    events2 = reg.check_and_swap(
        g2,
        resource_health={"anthropic": 0.1, "openai": 0.95},
        resource_latency={},
        contract_max_cost=10.0,
        current_tick=3,
    )
    # Guard should block this swap (already recorded 2 times)
    assert all(not e.success for e in events2) or len(events2) == 0
