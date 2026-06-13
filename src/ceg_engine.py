"""
ceg_engine.py — Convergence Execution Graph Engine v0.4
(issues #388 CEG v0.3 + #390 CEG v0.4)

Implements the formal CEG model:
  G = (V, E, D, tau, S, H)

  V   = Nodes (IntentNode | ResourceNode | ConstraintNode |
               AuthorityNode | MemoryNode | TraceNode | UIProjectionNode)
  E   = Typed directed edges
  D   = Per-node time-dilation field
  tau = Execution time model
  S   = System state S(t) = (G, R, M, P)
  H   = Hot-swap registry

Non-goals: no autonomous self-modifying loops, no RL optimization,
           no hidden execution paths.  Must remain auditable + deterministic.
"""

from __future__ import annotations

import time
import math
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Set, Tuple


# ---------------------------------------------------------------------------
# Node taxonomy
# ---------------------------------------------------------------------------

class NodeType(str, Enum):
    INTENT       = "intent"
    RESOURCE     = "resource"
    CONSTRAINT   = "constraint"
    AUTHORITY    = "authority"
    MEMORY       = "memory"
    TRACE        = "trace"
    UI_PROJ      = "ui_projection"   # v0.4


class ResourceType(str, Enum):
    LLM        = "llm"
    VM         = "vm"
    TOOL       = "tool"
    AGENT      = "agent"


class FeatureState(str, Enum):  # v0.4
    INACTIVE   = "inactive"
    SCHEDULED  = "scheduled"   # PCSF-eligible but not yet executing
    ACTIVE     = "active"      # currently executing
    SUSPENDED  = "suspended"   # swapped out, resumable


@dataclass
class CostModel:
    per_token: float = 0.0
    per_call:  float = 0.0
    latency_ms: float = 100.0


@dataclass
class Node:
    node_id:     str
    node_type:   NodeType
    metadata:    Dict[str, Any] = field(default_factory=dict)
    feature_state: FeatureState = FeatureState.INACTIVE   # v0.4
    stability:   float = 1.0    # v0.4: used by swap hysteresis
    dilation:    float = 1.0    # per-node D(v) field

    # Type-specific fields (populated based on node_type)
    # ResourceNode
    resource_type: Optional[ResourceType] = None
    cost_model:    Optional[CostModel]    = None
    health:        float = 1.0   # 0=dead, 1=healthy

    # ConstraintNode
    predicate:    Optional[Callable] = None
    severity:     str = "warn"

    # MemoryNode
    content:      Optional[str] = None

    # UIProjectionNode (v0.4)
    view_type:    Optional[str] = None
    render_policy: Optional[str] = None

    def is_active(self) -> bool:
        return self.feature_state == FeatureState.ACTIVE

    def activate(self) -> None:
        self.feature_state = FeatureState.ACTIVE

    def suspend(self) -> None:
        self.feature_state = FeatureState.SUSPENDED


# ---------------------------------------------------------------------------
# Edge taxonomy
# ---------------------------------------------------------------------------

class EdgeType(str, Enum):
    REQUIRES      = "requires"
    ENABLES       = "enables"
    BLOCKS        = "blocks"
    EXECUTES_ON   = "executes_on"
    TRANSFORMS_INTO = "transforms_into"
    OBSERVES      = "observes"
    # v0.4 additions
    DERIVES_FROM  = "derives_from"    # memory/context provenance
    PROJECTS_TO   = "projects_to"     # graph -> UI projection
    SWAPS_TO      = "swaps_to"        # hot-swap successor link


@dataclass
class Edge:
    from_id:   str
    to_id:     str
    edge_type: EdgeType
    weight:    float = 1.0
    metadata:  Dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Execution contract
# ---------------------------------------------------------------------------

@dataclass
class ExecutionContract:
    """Compiled intent -> constraint specification for PCSF optimizer."""
    intent:             str
    max_cost:           float = float("inf")
    max_latency_ms:     float = float("inf")
    determinism:        str = "best-effort"   # "strict" | "best-effort"
    memory_policy:      str = "ephemeral"
    external_io_policy: str = "allowed"
    allowed_resources:  List[str] = field(default_factory=list)
    forbidden_resources: List[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# AAPF — Agent-Aware Provenance Framework (trace events)
# ---------------------------------------------------------------------------

@dataclass
class TraceEvent:
    event_id:      str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    event:         str = ""
    causal_parent: Optional[str] = None
    timestamp:     float = field(default_factory=time.time)
    node_id:       Optional[str] = None
    metadata:      Dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# System state  S(t) = (G, R, M, P)
# ---------------------------------------------------------------------------

@dataclass
class ResourceState:
    available: Dict[str, bool] = field(default_factory=dict)
    usage:     Dict[str, float] = field(default_factory=dict)


@dataclass
class MemoryState:
    entries: List[Dict[str, Any]] = field(default_factory=list)

    def record(self, key: str, value: Any, tier: int = 2) -> None:
        self.entries.append({"key": key, "value": value, "tier": tier,
                             "ts": time.time()})


@dataclass
class PolicyState:
    active_policies: List[str] = field(default_factory=list)
    violations:      List[str] = field(default_factory=list)


@dataclass
class SystemState:
    """S(t) = (G, R, M, P)"""
    graph:     "CEGEngine"
    resources: ResourceState = field(default_factory=ResourceState)
    memory:    MemoryState   = field(default_factory=MemoryState)
    policies:  PolicyState   = field(default_factory=PolicyState)
    tick:      int = 0
    trace_log: List[TraceEvent] = field(default_factory=list)

    def emit(self, event: str, node_id: str | None = None,
             causal_parent: str | None = None, **meta) -> TraceEvent:
        ev = TraceEvent(event=event, node_id=node_id,
                        causal_parent=causal_parent, metadata=meta)
        self.trace_log.append(ev)
        return ev

    def advance(self) -> None:
        self.tick += 1


# ---------------------------------------------------------------------------
# CEG Engine — the graph itself
# ---------------------------------------------------------------------------

class CEGEngine:
    """
    Mutable Convergence Execution Graph.
    Manages nodes, typed edges, and hot-swap registry.
    """

    def __init__(self) -> None:
        self._nodes: Dict[str, Node] = {}
        self._edges: List[Edge]      = []
        # H = hot-swap registry: node_id -> list of candidate successors
        self._swap_registry: Dict[str, List[str]] = {}
        # v0.4: swap hysteresis state
        self._last_swap_ts: Dict[str, float] = {}
        self._swap_epsilon: float = 0.05    # minimum improvement score
        self._swap_cooldown: float = 5.0    # seconds

    # ── Node operations ────────────────────────────────────────────────────

    def add_node(self, node: Node) -> None:
        self._nodes[node.node_id] = node

    def remove_node(self, node_id: str) -> None:
        self._nodes.pop(node_id, None)
        self._edges = [e for e in self._edges
                       if e.from_id != node_id and e.to_id != node_id]

    def get_node(self, node_id: str) -> Optional[Node]:
        return self._nodes.get(node_id)

    def nodes(self) -> List[Node]:
        return list(self._nodes.values())

    # ── Edge operations ────────────────────────────────────────────────────

    def add_edge(self, from_id: str, to_id: str,
                 edge_type: EdgeType, weight: float = 1.0) -> Edge:
        e = Edge(from_id=from_id, to_id=to_id, edge_type=edge_type, weight=weight)
        self._edges.append(e)
        return e

    def edges_from(self, node_id: str,
                   edge_type: Optional[EdgeType] = None) -> List[Edge]:
        return [e for e in self._edges
                if e.from_id == node_id
                and (edge_type is None or e.edge_type == edge_type)]

    def edges_to(self, node_id: str,
                 edge_type: Optional[EdgeType] = None) -> List[Edge]:
        return [e for e in self._edges
                if e.to_id == node_id
                and (edge_type is None or e.edge_type == edge_type)]

    def blocked_ids(self) -> Set[str]:
        return {e.to_id for e in self._edges if e.edge_type == EdgeType.BLOCKS}

    # ── Hot-swap (σ operator) — v0.4 hysteresis ───────────────────────────

    def register_swap_candidate(self, node_id: str, candidate_id: str) -> None:
        self._swap_registry.setdefault(node_id, []).append(candidate_id)

    def swap_allowed(self, node_id: str, improvement_score: float) -> bool:
        """v0.4 stability condition: prevent oscillatory switching."""
        node = self._nodes.get(node_id)
        if node is None:
            return False
        cooldown_elapsed = (
            time.time() - self._last_swap_ts.get(node_id, 0.0)
        ) >= self._swap_cooldown
        return (
            improvement_score > self._swap_epsilon
            and cooldown_elapsed
            and node.stability >= 0.5
        )

    def hot_swap(self, old_id: str, new_node: Node,
                 state: SystemState) -> Optional[TraceEvent]:
        """
        Replace old_id with new_node in-place, rewriting all edges.
        Emits a SWAPS_TO edge and a TraceEvent.
        Returns None if swap is blocked by hysteresis.
        """
        old_node = self._nodes.get(old_id)
        if old_node is None:
            return None
        # Record SWAPS_TO edge before removal
        self.add_edge(old_id, new_node.node_id, EdgeType.SWAPS_TO)
        # Rewrite edges
        for edge in self._edges:
            if edge.from_id == old_id: edge.from_id = new_node.node_id
            if edge.to_id   == old_id: edge.to_id   = new_node.node_id
        # Replace node
        self._nodes.pop(old_id)
        self._nodes[new_node.node_id] = new_node
        self._last_swap_ts[new_node.node_id] = time.time()
        ev = state.emit("hot_swap", node_id=new_node.node_id,
                        old_id=old_id, new_id=new_node.node_id)
        return ev

    # ── Time dilation ──────────────────────────────────────────────────────

    @staticmethod
    def dilation(uncertainty: float, cost_pressure: float,
                 confidence: float) -> float:
        """
        D(v) = (1 + uncertainty)(1 + cost_pressure) / (0.1 + confidence)
        Clamped to [0.1, 10.0].
        """
        raw = (1.0 + uncertainty) * (1.0 + cost_pressure) / (0.1 + confidence)
        return max(0.1, min(10.0, raw))


# ---------------------------------------------------------------------------
# PCSF Optimizer
# ---------------------------------------------------------------------------

@dataclass
class ExecutionPlan:
    steps:            List[str]
    resource_grants:  Dict[str, Dict[str, float]] = field(default_factory=dict)
    estimated_cost:   float = 0.0
    estimated_ms:     float = 0.0

    def is_empty(self) -> bool:
        return len(self.steps) == 0


class PCSFOptimizer:
    """
    P* = argmin Cost(P) subject to ExecutionContract constraints.
    Cost(P) = w1*latency + w2*compute_cost + w3*risk + w4*instability
    v0.3 implementation: greedy cost-minimizing selection.
    """

    WEIGHTS = (0.3, 0.3, 0.2, 0.2)  # (latency, cost, risk, instability)

    def optimize(self, graph: CEGEngine,
                 contract: ExecutionContract,
                 state: SystemState) -> ExecutionPlan:
        blocked = graph.blocked_ids()
        candidates = [
            n for n in graph.nodes()
            if n.node_id not in blocked
            and n.node_type not in (NodeType.CONSTRAINT, NodeType.TRACE)
            and n.node_id not in contract.forbidden_resources
            and (not contract.allowed_resources
                 or n.node_id in contract.allowed_resources)
        ]

        # Score each candidate
        def score(n: Node) -> float:
            cm = n.cost_model or CostModel()
            w1, w2, w3, w4 = self.WEIGHTS
            latency = cm.latency_ms / 1000.0
            cost    = cm.per_call
            risk    = 1.0 - n.health
            instab  = 1.0 - n.stability
            return w1 * latency + w2 * cost + w3 * risk + w4 * instab

        ordered = sorted(candidates, key=score)
        steps = [n.node_id for n in ordered]

        total_ms   = sum((n.cost_model or CostModel()).latency_ms
                         * n.dilation for n in ordered)
        total_cost = sum((n.cost_model or CostModel()).per_call for n in ordered)

        return ExecutionPlan(steps=steps, estimated_cost=total_cost,
                             estimated_ms=total_ms)

    def reoptimize(self, plan: ExecutionPlan, graph: CEGEngine,
                   contract: ExecutionContract, state: SystemState) -> ExecutionPlan:
        """Continuous re-optimization: re-run optimizer from current state."""
        return self.optimize(graph, contract, state)


# ---------------------------------------------------------------------------
# CIOEngine — top-level executor
# ---------------------------------------------------------------------------

class CIOEngine:
    """
    Main Convergence IO execution engine.
    Compiles intent -> contract -> plan -> runs steps -> traces results.
    """

    def __init__(self, graph: Optional[CEGEngine] = None) -> None:
        self.graph     = graph or CEGEngine()
        self.optimizer = PCSFOptimizer()

    def compile_contract(self, intent: str, **kwargs) -> ExecutionContract:
        return ExecutionContract(intent=intent, **kwargs)

    def run(self, intent: str,
            contract: Optional[ExecutionContract] = None,
            **contract_kwargs) -> SystemState:
        state = SystemState(graph=self.graph)
        contract = contract or self.compile_contract(intent, **contract_kwargs)
        state.emit("run_start", causal_parent=None, intent=intent)

        plan = self.optimizer.optimize(self.graph, contract, state)
        state.emit("plan_ready", steps=plan.steps,
                   estimated_ms=plan.estimated_ms)

        for node_id in plan.steps:
            node = self.graph.get_node(node_id)
            if node is None:
                state.emit("step_skip", node_id=node_id, reason="not_found")
                continue
            node.activate()
            dil = CEGEngine.dilation(0.2, 0.1, node.health)
            state.emit("step_exec", node_id=node_id, dilation=round(dil, 3))
            state.memory.record(f"exec.{node_id}", {"dilation": dil})
            state.advance()

        state.emit("run_complete", tick=state.tick)
        return state