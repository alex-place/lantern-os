"""
tests/test_ceg.py — unit tests for convergence_io.ceg

Covers: node CRUD, edge CRUD, swap_node σ operator, optimizer,
        execution contract, invariants.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from convergence_io.ceg import (
    CEGraph, NodeKind, EdgeKind, Severity, ResourceKind,
    IntentNode, ResourceNode, ConstraintNode, AuthorityNode, MemoryNode, TraceNode,
    ExecutionContract, ExecutionConstraints, ExecutionPlan,
    PCSFOptimizer, SystemState, CostWeights,
)


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


def _graph_with_resources(*providers) -> CEGraph:
    g = CEGraph()
    for p in providers:
        g.add_node(_resource(provider_id=p))
    return g


def _default_state(**overrides) -> SystemState:
    from convergence_io.ceg import ResourceState
    s = SystemState(
        resources=ResourceState(
            health={"anthropic": 1.0, "openai": 0.9, "ollama": 0.8},
            latency_ms={"anthropic": 500.0, "openai": 600.0, "ollama": 200.0},
        ),
    )
    for k, v in overrides.items():
        setattr(s, k, v)
    return s


def _default_contract(**overrides) -> ExecutionContract:
    c = ExecutionConstraints(max_cost=10.0, max_latency_ms=5000.0)
    for k, v in overrides.items():
        setattr(c, k, v)
    return ExecutionContract(intent="test", constraints=c)


# ── CEGraph node operations ───────────────────────────────────────────────────

def test_add_and_get_node():
    g = CEGraph()
    n = IntentNode(raw_text="hello")
    g.add_node(n)
    assert g.get_node(n.node_id) is n


def test_remove_node():
    g = CEGraph()
    n = IntentNode()
    g.add_node(n)
    removed = g.remove_node(n.node_id)
    assert removed is n
    assert g.get_node(n.node_id) is None


def test_remove_node_removes_edges():
    g = CEGraph()
    a = IntentNode()
    b = _resource()
    g.add_node(a); g.add_node(b)
    g.add_edge(a.node_id, b.node_id, EdgeKind.EXECUTES_ON)
    g.remove_node(a.node_id)
    assert len(g.edges_from(a.node_id)) == 0
    assert len(g.edges_to(b.node_id)) == 0


def test_nodes_by_kind():
    g = CEGraph()
    g.add_node(IntentNode())
    g.add_node(_resource("a"))
    g.add_node(_resource("b"))
    assert len(g.nodes_by_kind(NodeKind.INTENT)) == 1
    assert len(g.nodes_by_kind(NodeKind.RESOURCE)) == 2


def test_advance_tick():
    g = CEGraph()
    assert g.advance_tick() == 1
    assert g.advance_tick() == 2


def test_snapshot():
    g = _graph_with_resources("anthropic", "openai")
    snap = g.snapshot()
    assert snap["node_count"] == 2
    assert snap["nodes_by_kind"]["resource"] == 2


# ── Edge operations ───────────────────────────────────────────────────────────

def test_add_edge():
    g = CEGraph()
    a = IntentNode(); b = _resource()
    g.add_node(a); g.add_node(b)
    e = g.add_edge(a.node_id, b.node_id, EdgeKind.EXECUTES_ON)
    assert e in g.edges_from(a.node_id)
    assert e in g.edges_to(b.node_id)


def test_edges_deduplication():
    g = CEGraph()
    a = IntentNode(); b = _resource()
    g.add_node(a); g.add_node(b)
    g.add_edge(a.node_id, b.node_id, EdgeKind.REQUIRES)
    g.add_edge(a.node_id, b.node_id, EdgeKind.REQUIRES)
    assert len(g.edges_from(a.node_id)) == 1


def test_blocked_by():
    g = CEGraph()
    a = ConstraintNode(predicate="no_pii")
    b = _resource()
    g.add_node(a); g.add_node(b)
    g.add_edge(a.node_id, b.node_id, EdgeKind.BLOCKS)
    assert a.node_id in g.blocked_by(b.node_id)


# ── swap_node σ operator ──────────────────────────────────────────────────────

def test_swap_node_replaces():
    g = CEGraph()
    old = _resource("anthropic")
    new = _resource("openai")
    g.add_node(old)
    removed = g.swap_node(old.node_id, new)
    assert removed is old
    assert g.get_node(old.node_id) is None
    assert g.get_node(new.node_id) is new


def test_swap_node_rewires_edges():
    g = CEGraph()
    intent = IntentNode()
    old = _resource("anthropic")
    new = _resource("openai")
    g.add_node(intent); g.add_node(old)
    g.add_edge(intent.node_id, old.node_id, EdgeKind.EXECUTES_ON)
    g.swap_node(old.node_id, new)
    edges = g.edges_from(intent.node_id)
    assert any(e.dst_id == new.node_id for e in edges)
    assert not any(e.dst_id == old.node_id for e in edges)


def test_swap_node_missing_returns_none():
    g = CEGraph()
    new = _resource("openai")
    assert g.swap_node("nonexistent", new) is None


# ── PCSFOptimizer ─────────────────────────────────────────────────────────────

def test_optimizer_selects_resource():
    g = _graph_with_resources("anthropic", "openai")
    opt = PCSFOptimizer()
    plan = opt.optimize(g, _default_contract(), _default_state())
    assert plan.feasible
    assert len(plan.steps) == 1


def test_optimizer_respects_forbidden():
    g = _graph_with_resources("anthropic")
    contract = ExecutionContract(
        intent="test",
        constraints=ExecutionConstraints(max_cost=10.0, max_latency_ms=5000.0),
        forbidden_resources=["anthropic"],
    )
    plan = PCSFOptimizer().optimize(g, contract, _default_state())
    assert not plan.feasible


def test_optimizer_respects_allowed():
    g = _graph_with_resources("anthropic", "openai")
    contract = ExecutionContract(
        intent="test",
        constraints=ExecutionConstraints(max_cost=10.0, max_latency_ms=5000.0),
        allowed_resources=["openai"],
    )
    plan = PCSFOptimizer().optimize(g, contract, _default_state())
    assert plan.feasible
    selected_node = g.get_node(plan.steps[0].node_id)
    assert isinstance(selected_node, ResourceNode)
    assert selected_node.provider_id == "openai"


def test_optimizer_no_resources_infeasible():
    g = CEGraph()
    g.add_node(IntentNode())  # no ResourceNodes
    plan = PCSFOptimizer().optimize(g, _default_contract(), _default_state())
    assert not plan.feasible
    assert "no eligible" in plan.infeasibility_reason


def test_optimizer_hard_constraint_blocks():
    g = _graph_with_resources("anthropic")
    # Add a violated hard constraint
    c = ConstraintNode(predicate="no_pii", severity=Severity.HARD, satisfied=False)
    g.add_node(c)
    plan = PCSFOptimizer().optimize(g, _default_contract(), _default_state())
    assert not plan.feasible
    assert "hard constraints" in plan.infeasibility_reason


def test_optimizer_cost_exceeded():
    g = _graph_with_resources("anthropic")
    # Very tight budget
    contract = ExecutionContract(
        intent="test",
        constraints=ExecutionConstraints(max_cost=0.00001, max_latency_ms=5000.0),
    )
    plan = PCSFOptimizer().optimize(g, contract, _default_state())
    assert not plan.feasible


def test_optimizer_reoptimize():
    g = _graph_with_resources("anthropic", "openai")
    opt = PCSFOptimizer()
    contract = _default_contract()
    state = _default_state()
    plan1 = opt.optimize(g, contract, state)
    plan2 = opt.reoptimize(plan1, g, contract, state)
    assert plan2.feasible
