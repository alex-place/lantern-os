"""
tests/test_ceg_v04.py — unit tests for CEG v0.4 additions

Covers: UIProjectionNode, FeatureState, swaps_to edge, SystemState v0.4,
        CEGExecutor loop, SwapHysteresis.
"""

import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from convergence_io.ceg import (
    CEGraph, NodeKind, EdgeKind, Severity, ResourceKind, FeatureState,
    IntentNode, ResourceNode, ConstraintNode, UIProjectionNode, TraceNode,
    ExecutionContract, ExecutionConstraints, ExecutionPlan,
    PCSFOptimizer, SystemState, ResourceState, MemoryState, PolicyState,
    CEGExecutor, ExecutorStep,
)
from convergence_io.hot_swap import HotSwapRegistry, SwapHysteresis, SwapPolicy


# ── helpers ───────────────────────────────────────────────────────────────────

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


def _contract(max_cost=10.0, max_lat=5000.0):
    return ExecutionContract(
        intent="test",
        constraints=ExecutionConstraints(max_cost=max_cost, max_latency_ms=max_lat),
    )


def _state():
    return SystemState(
        resources=ResourceState(
            health={"anthropic": 1.0, "openai": 0.9},
            latency_ms={"anthropic": 500.0, "openai": 600.0},
        ),
    )


# ── UIProjectionNode ──────────────────────────────────────────────────────────

def test_ui_projection_node_defaults():
    n = UIProjectionNode()
    assert n.kind == NodeKind.PROJECTION
    assert n.view_type == "panel"
    assert n.feature_state == FeatureState.INACTIVE


def test_ui_projection_node_in_graph():
    g = CEGraph()
    n = UIProjectionNode(view_type="cockpit", filter="resource.*", render_policy="on_active")
    g.add_node(n)
    assert g.get_node(n.node_id) is n
    assert len(g.nodes_by_kind(NodeKind.PROJECTION)) == 1


def test_ui_projection_node_projects_to_edge():
    g = CEGraph()
    resource = _resource()
    proj = UIProjectionNode(source_node_ids=[])
    g.add_node(resource)
    g.add_node(proj)
    g.add_edge(resource.node_id, proj.node_id, EdgeKind.PROJECTS_TO)
    edges = g.edges_from(resource.node_id)
    assert any(e.kind == EdgeKind.PROJECTS_TO for e in edges)


# ── FeatureState ──────────────────────────────────────────────────────────────

def test_feature_state_values():
    assert FeatureState.INACTIVE.value == "inactive"
    assert FeatureState.SCHEDULED.value == "scheduled"
    assert FeatureState.ACTIVE.value == "active"
    assert FeatureState.SUSPENDED.value == "suspended"


def test_feature_state_transition():
    n = UIProjectionNode()
    assert n.feature_state == FeatureState.INACTIVE
    n.feature_state = FeatureState.SCHEDULED
    assert n.feature_state == FeatureState.SCHEDULED
    n.feature_state = FeatureState.ACTIVE
    assert n.feature_state == FeatureState.ACTIVE


# ── swaps_to edge ─────────────────────────────────────────────────────────────

def test_swaps_to_edge():
    g = CEGraph()
    old = _resource("anthropic")
    new = _resource("openai")
    g.add_node(old)
    g.add_node(new)
    g.add_edge(old.node_id, new.node_id, EdgeKind.SWAPS_TO)
    edges = g.edges_from(old.node_id)
    assert any(e.kind == EdgeKind.SWAPS_TO and e.dst_id == new.node_id for e in edges)


# ── SystemState v0.4 ──────────────────────────────────────────────────────────

def test_system_state_v04_structure():
    s = _state()
    assert isinstance(s.resources, ResourceState)
    assert isinstance(s.memory, MemoryState)
    assert isinstance(s.policy, PolicyState)


def test_system_state_backward_compat():
    """v0.3 callers using .resource_health, .resource_latency still work."""
    s = _state()
    assert s.resource_health == {"anthropic": 1.0, "openai": 0.9}
    assert s.resource_latency["anthropic"] == 500.0
    assert s.memory_load == 0
    assert s.active_constraints == []


def test_memory_state_update():
    s = SystemState()
    s.memory.active_nodes = 3
    assert s.memory_load == 3


def test_policy_state():
    s = SystemState(policy=PolicyState(
        active_constraints=["no_pii"],
        nap_profile_id="dreamer-v1",
        authority_scope="operator",
    ))
    assert "no_pii" in s.active_constraints


# ── CEGExecutor ───────────────────────────────────────────────────────────────

def _executor_graph():
    g = CEGraph()
    g.add_node(_resource("anthropic"))
    return g


def test_executor_runs_to_completion():
    g = _executor_graph()
    opt = PCSFOptimizer()
    executor = CEGExecutor(g, opt, max_ticks=5)
    steps = executor.run(_contract(), _state())
    assert len(steps) >= 1
    assert steps[-1].complete is True


def test_executor_emits_trace_nodes():
    g = _executor_graph()
    opt = PCSFOptimizer()
    executor = CEGExecutor(g, opt, max_ticks=3)
    executor.run(_contract(), _state())
    traces = g.nodes_by_kind(NodeKind.TRACE)
    assert len(traces) >= 1


def test_executor_updates_projection_state():
    g = _executor_graph()
    resource = list(g.nodes_by_kind(NodeKind.RESOURCE))[0]
    proj = UIProjectionNode(source_node_ids=[resource.node_id])
    g.add_node(proj)
    g.add_edge(resource.node_id, proj.node_id, EdgeKind.PROJECTS_TO)

    opt = PCSFOptimizer()
    executor = CEGExecutor(g, opt, max_ticks=2)
    executor.run(_contract(), _state())

    # Projection should be ACTIVE since its source is in the plan
    assert proj.feature_state == FeatureState.ACTIVE


def test_executor_stops_on_no_resources():
    g = CEGraph()
    g.add_node(IntentNode())  # no ResourceNodes
    opt = PCSFOptimizer()
    executor = CEGExecutor(g, opt, max_ticks=3)
    steps = executor.run(_contract(), SystemState())
    # Infeasible plan → loop runs max_ticks, last step not complete
    assert all(not s.complete for s in steps)


def test_executor_summary():
    g = _executor_graph()
    opt = PCSFOptimizer()
    executor = CEGExecutor(g, opt, max_ticks=2)
    executor.run(_contract(), _state())
    summary = executor.summary()
    assert "ticks" in summary
    assert "complete" in summary
    assert summary["ticks"] >= 1


def test_executor_nap_violation_recorded():
    g = _executor_graph()
    # Add a violated hard constraint
    c = ConstraintNode(predicate="no_pii", severity=Severity.HARD, satisfied=False)
    g.add_node(c)
    opt = PCSFOptimizer()
    executor = CEGExecutor(g, opt, max_ticks=5)
    steps = executor.run(_contract(), _state())
    # HARD constraint → optimizer returns infeasible, loop doesn't complete cleanly
    assert any(len(s.nap_violations) > 0 for s in steps)


def test_executor_with_dilation():
    from convergence_io.dilation import DilationField
    g = _executor_graph()
    opt = PCSFOptimizer()
    dil = DilationField()
    executor = CEGExecutor(g, opt, dilation=dil, max_ticks=2)
    steps = executor.run(_contract(), _state())
    assert steps[-1].complete is True


def test_executor_with_hot_swap():
    g = _executor_graph()
    old_resource = list(g.nodes_by_kind(NodeKind.RESOURCE))[0]
    backup = _resource("openai", health=0.95)
    registry = HotSwapRegistry(policy=SwapPolicy(health_threshold=0.5))
    registry.register_candidate(old_resource.node_id, backup)
    opt = PCSFOptimizer()
    executor = CEGExecutor(g, opt, hot_swap=registry, max_ticks=2)
    steps = executor.run(_contract(), _state())
    assert len(steps) >= 1


# ── SwapHysteresis ────────────────────────────────────────────────────────────

def test_hysteresis_allows_good_improvement():
    h = SwapHysteresis(epsilon=0.05, cooldown_s=0.0, stability_threshold=0.0)
    allowed, reason = h.swap_allowed("a", "b", improvement_score=0.3)
    assert allowed
    assert reason == "ok"


def test_hysteresis_blocks_small_improvement():
    h = SwapHysteresis(epsilon=0.1)
    allowed, reason = h.swap_allowed("a", "b", improvement_score=0.05)
    assert not allowed
    assert "epsilon" in reason


def test_hysteresis_blocks_during_cooldown():
    h = SwapHysteresis(epsilon=0.01, cooldown_s=60.0)
    h.record_swap("a")
    allowed, reason = h.swap_allowed("a", "b", improvement_score=0.5)
    assert not allowed
    assert "cooldown" in reason


def test_hysteresis_blocks_unstable_node():
    h = SwapHysteresis(epsilon=0.01, cooldown_s=0.0, stability_threshold=0.8, stability_alpha=1.0)
    h.observe_health("a", 0.1)  # very unhealthy → stability = 0.1
    allowed, reason = h.swap_allowed("a", "b", improvement_score=0.5)
    assert not allowed
    assert "stability" in reason


def test_hysteresis_stability_ema():
    h = SwapHysteresis(stability_alpha=0.5)
    s1 = h.observe_health("n", 1.0)
    s2 = h.observe_health("n", 0.0)
    # EMA: start 1.0, then alpha*0 + (1-alpha)*1 = 0.5
    assert abs(s2 - 0.5) < 1e-6


def test_hysteresis_summary():
    h = SwapHysteresis()
    h.observe_health("n1", 0.9)
    summary = h.summary()
    assert summary["tracked_nodes"] == 1
    assert "epsilon" in summary
