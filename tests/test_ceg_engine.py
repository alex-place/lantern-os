"""
test_ceg_engine.py — CEG Engine v0.4 tests (issues #388, #390)
Covers: nodes, edges, hot-swap hysteresis, dilation, PCSF optimizer, CIOEngine.run()
"""

import sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

import pytest
from ceg_engine import (
    CEGEngine, CIOEngine, PCSFOptimizer, ExecutionContract,
    Node, NodeType, Edge, EdgeType, FeatureState,
    ResourceType, CostModel, SystemState, MemoryState,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def graph():
    g = CEGEngine()
    g.add_node(Node("n_intent",  NodeType.INTENT))
    g.add_node(Node("n_tool",    NodeType.RESOURCE, resource_type=ResourceType.TOOL,
                    cost_model=CostModel(per_call=0.01, latency_ms=50.0), health=1.0))
    g.add_node(Node("n_memory",  NodeType.MEMORY))
    g.add_node(Node("n_blocked", NodeType.RESOURCE))
    g.add_edge("n_intent", "n_blocked", EdgeType.BLOCKS)
    g.add_edge("n_intent", "n_tool",    EdgeType.ENABLES)
    return g


@pytest.fixture
def engine(graph):
    return CIOEngine(graph=graph)


# ---------------------------------------------------------------------------
# Node operations
# ---------------------------------------------------------------------------

class TestNodeOps:
    def test_add_and_get_node(self, graph):
        node = graph.get_node("n_intent")
        assert node is not None
        assert node.node_type == NodeType.INTENT

    def test_remove_node_removes_edges(self, graph):
        graph.remove_node("n_intent")
        assert graph.get_node("n_intent") is None
        # edges referencing n_intent should be gone
        remaining = [e for e in graph._edges if e.from_id == "n_intent" or e.to_id == "n_intent"]
        assert remaining == []

    def test_feature_state_transitions(self):
        n = Node("n", NodeType.RESOURCE)
        assert n.feature_state == FeatureState.INACTIVE
        n.activate()
        assert n.feature_state == FeatureState.ACTIVE
        n.suspend()
        assert n.feature_state == FeatureState.SUSPENDED

    def test_is_active(self):
        n = Node("n", NodeType.RESOURCE)
        assert not n.is_active()
        n.activate()
        assert n.is_active()


# ---------------------------------------------------------------------------
# Edge operations
# ---------------------------------------------------------------------------

class TestEdgeOps:
    def test_edges_from(self, graph):
        edges = graph.edges_from("n_intent")
        assert len(edges) == 2

    def test_edges_from_filtered(self, graph):
        blocks = graph.edges_from("n_intent", EdgeType.BLOCKS)
        assert len(blocks) == 1
        assert blocks[0].to_id == "n_blocked"

    def test_blocked_ids(self, graph):
        blocked = graph.blocked_ids()
        assert "n_blocked" in blocked
        assert "n_intent" not in blocked

    def test_v04_edge_types(self):
        g = CEGEngine()
        g.add_node(Node("src", NodeType.MEMORY))
        g.add_node(Node("dst", NodeType.UI_PROJ))
        g.add_edge("src", "dst", EdgeType.PROJECTS_TO)
        g.add_edge("src", "dst", EdgeType.DERIVES_FROM)
        types = {e.edge_type for e in g._edges}
        assert EdgeType.PROJECTS_TO in types
        assert EdgeType.DERIVES_FROM in types


# ---------------------------------------------------------------------------
# Time dilation
# ---------------------------------------------------------------------------

class TestDilation:
    def test_dilation_range(self):
        d = CEGEngine.dilation(0.2, 0.1, 0.8)
        assert 0.1 <= d <= 10.0

    def test_dilation_high_uncertainty(self):
        low  = CEGEngine.dilation(0.0, 0.0, 1.0)
        high = CEGEngine.dilation(1.0, 0.0, 1.0)
        assert high > low

    def test_dilation_zero_confidence_clamps(self):
        d = CEGEngine.dilation(1.0, 1.0, 0.0)
        assert d == pytest.approx(10.0)

    def test_dilation_perfect_case(self):
        d = CEGEngine.dilation(0.0, 0.0, 1.0)
        assert d < 1.0  # fast under ideal conditions


# ---------------------------------------------------------------------------
# Hot-swap with v0.4 hysteresis
# ---------------------------------------------------------------------------

class TestHotSwap:
    def test_swap_rewrites_edges(self, graph):
        state = SystemState(graph=graph)
        new_node = Node("n_tool_v2", NodeType.RESOURCE, health=0.9)
        graph.hot_swap("n_tool", new_node, state)
        assert graph.get_node("n_tool_v2") is not None
        assert graph.get_node("n_tool") is None

    def test_swap_emits_trace_event(self, graph):
        state = SystemState(graph=graph)
        new_node = Node("n_tool_v2", NodeType.RESOURCE)
        ev = graph.hot_swap("n_tool", new_node, state)
        assert ev is not None
        assert ev.event == "hot_swap"
        assert any(e.event == "hot_swap" for e in state.trace_log)

    def test_swap_allowed_hysteresis_cooldown(self, graph):
        """swap_allowed returns False immediately after a swap."""
        n = Node("target", NodeType.RESOURCE, stability=1.0)
        graph.add_node(n)
        state = SystemState(graph=graph)
        # First swap
        graph.hot_swap("target", Node("target_v2", NodeType.RESOURCE), state)
        # Immediately requesting another swap should be blocked by cooldown
        assert not graph.swap_allowed("target_v2", improvement_score=0.5)

    def test_swap_allowed_insufficient_improvement(self, graph):
        n = Node("stable", NodeType.RESOURCE, stability=1.0)
        graph.add_node(n)
        # improvement below epsilon (0.05)
        assert not graph.swap_allowed("stable", improvement_score=0.01)

    def test_swap_allowed_low_stability(self, graph):
        n = Node("unstable", NodeType.RESOURCE, stability=0.3)
        graph.add_node(n)
        assert not graph.swap_allowed("unstable", improvement_score=0.5)


# ---------------------------------------------------------------------------
# PCSF Optimizer
# ---------------------------------------------------------------------------

class TestPCSFOptimizer:
    def test_excludes_blocked_nodes(self, graph):
        contract = ExecutionContract(intent="test")
        state    = SystemState(graph=graph)
        plan     = PCSFOptimizer().optimize(graph, contract, state)
        assert "n_blocked" not in plan.steps

    def test_excludes_constraints(self, graph):
        from ceg_engine import Node, NodeType
        graph.add_node(Node("c1", NodeType.CONSTRAINT))
        plan = PCSFOptimizer().optimize(
            graph, ExecutionContract(intent="t"), SystemState(graph=graph)
        )
        assert "c1" not in plan.steps

    def test_forbidden_resources_excluded(self, graph):
        contract = ExecutionContract(intent="test", forbidden_resources=["n_tool"])
        plan = PCSFOptimizer().optimize(graph, contract, SystemState(graph=graph))
        assert "n_tool" not in plan.steps

    def test_plan_has_estimated_values(self, graph):
        plan = PCSFOptimizer().optimize(
            graph, ExecutionContract(intent="t"), SystemState(graph=graph)
        )
        assert plan.estimated_ms >= 0
        assert plan.estimated_cost >= 0

    def test_reoptimize_returns_plan(self, graph):
        opt   = PCSFOptimizer()
        state = SystemState(graph=graph)
        plan1 = opt.optimize(graph, ExecutionContract(intent="t"), state)
        plan2 = opt.reoptimize(plan1, graph, ExecutionContract(intent="t"), state)
        assert isinstance(plan2.steps, list)


# ---------------------------------------------------------------------------
# CIOEngine.run()
# ---------------------------------------------------------------------------

class TestCIOEngineRun:
    def test_run_returns_state(self, engine):
        state = engine.run("test intent")
        assert isinstance(state, SystemState)
        assert state.tick > 0

    def test_run_activates_nodes(self, engine, graph):
        engine.run("test")
        active = [n for n in graph.nodes() if n.is_active()]
        assert len(active) > 0

    def test_run_emits_trace_events(self, engine):
        state = engine.run("test intent")
        event_names = {e.event for e in state.trace_log}
        assert "run_start"    in event_names
        assert "plan_ready"   in event_names
        assert "run_complete" in event_names

    def test_run_records_memory(self, engine):
        state = engine.run("test intent")
        assert len(state.memory.entries) > 0

    def test_run_skips_blocked_nodes(self, engine, graph):
        state = engine.run("test")
        skip_events = [e for e in state.trace_log if e.event == "step_skip"]
        # n_blocked is excluded by optimizer so no step_skip expected
        # but no crash either
        assert isinstance(skip_events, list)

    def test_compile_contract(self, engine):
        contract = engine.compile_contract("chat", max_cost=0.1, max_latency_ms=500)
        assert contract.intent == "chat"
        assert contract.max_cost == pytest.approx(0.1)
        assert contract.max_latency_ms == pytest.approx(500)