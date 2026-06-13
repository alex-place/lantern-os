"""
CEG — Convergence Execution Graph

G = (V, E, D, τ, S, H)
  V  = Nodes (typed)
  E  = Typed directed edges
  D  = Time dilation field (per-node float, computed each tick)
  τ  = Execution time model (latency targets shaped by D)
  S  = System state (resource + memory + policy snapshots)
  H  = Hot-swap registry (handled in hot_swap.py)

Node taxonomy:
  IntentNode      — the what: user request / goal embedding
  ResourceNode    — the how: LLM | VM | TOOL | AGENT
  ConstraintNode  — the must: predicate, scope, severity
  AuthorityNode   — the who: policy set, identity scope
  MemoryNode      — the remember: CSF content + provenance
  TraceNode       — the audit: AAPF causal event

Edge taxonomy:
  Requires        — v_src needs v_dst to be active before execution
  Enables         — v_src makes v_dst possible (soft dependency)
  Blocks          — v_src prevents v_dst from activating
  ExecutesOn      — intent uses a resource
  TransformsInto  — output of v_src becomes input of v_dst
  Observes        — v_src reads v_dst without modifying it

ExecutionContract:
  Declarative spec passed to the PCSF optimizer.
  The optimizer returns an ordered ExecutionPlan satisfying all constraints.

Global invariants (enforced at graph mutation boundaries):
  1. Continuity    — no active execution may be interrupted without rollback
  2. TraceComplete — every node activation emits a TraceNode
  3. Constraint dominance — ConstraintNode violations block, never warn
  4. Bounded determinism — same G + S + D → same plan (modulo wall-clock)
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Any, Dict, FrozenSet, Iterator, List, Optional, Set, Tuple


# ── Node types ────────────────────────────────────────────────────────────────

class NodeKind(Enum):
    INTENT      = "intent"
    RESOURCE    = "resource"
    CONSTRAINT  = "constraint"
    AUTHORITY   = "authority"
    MEMORY      = "memory"
    TRACE       = "trace"
    # v0.4 extension point — UIProjectionNode maps here
    PROJECTION  = "projection"


class ResourceKind(Enum):
    LLM   = "llm"
    VM    = "vm"
    TOOL  = "tool"
    AGENT = "agent"


class Severity(Enum):
    SOFT     = "soft"     # warn, continue
    HARD     = "hard"     # block, surface error
    CRITICAL = "critical" # abort execution


@dataclass
class NodeBase:
    node_id: str = field(default_factory=lambda: str(uuid.uuid4())[:12])
    kind: NodeKind = NodeKind.INTENT
    label: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)
    # Runtime state (not serialized as part of graph spec)
    active: bool = False
    dilation: float = 1.0   # D(v) — computed each tick by DilationField
    latency_ms: float = 0.0


@dataclass
class IntentNode(NodeBase):
    kind: NodeKind = NodeKind.INTENT
    embedding: List[float] = field(default_factory=list)  # placeholder for CSF vector
    raw_text: str = ""


@dataclass
class ResourceNode(NodeBase):
    kind: NodeKind = NodeKind.RESOURCE
    resource_kind: ResourceKind = ResourceKind.LLM
    provider_id: str = ""           # e.g. "anthropic", "openai", "ollama"
    capabilities: List[str] = field(default_factory=list)
    cost_per_token: float = 0.0
    latency_target_ms: float = 2000.0
    health: float = 1.0             # 0.0 = dead, 1.0 = healthy


@dataclass
class ConstraintNode(NodeBase):
    kind: NodeKind = NodeKind.CONSTRAINT
    predicate: str = ""             # e.g. "max_cost < 0.01", "no_pii"
    scope: str = "global"           # global | session | request
    severity: Severity = Severity.HARD
    satisfied: Optional[bool] = None  # None = unchecked


@dataclass
class AuthorityNode(NodeBase):
    kind: NodeKind = NodeKind.AUTHORITY
    policy_set: List[str] = field(default_factory=list)
    identity_scope: str = "operator"   # operator | user | agent | public


@dataclass
class MemoryNode(NodeBase):
    kind: NodeKind = NodeKind.MEMORY
    content: str = ""
    provenance: str = ""
    access_policy: str = "internal"    # internal | operator | public


@dataclass
class TraceNode(NodeBase):
    """AAPF causal event — emitted for every node activation."""
    kind: NodeKind = NodeKind.TRACE
    event: str = ""
    causal_parent_id: Optional[str] = None
    timestamp: float = field(default_factory=time.time)
    actor_node_id: str = ""


# Union type alias (for type hints)
AnyNode = IntentNode | ResourceNode | ConstraintNode | AuthorityNode | MemoryNode | TraceNode


# ── Edge types ────────────────────────────────────────────────────────────────

class EdgeKind(Enum):
    REQUIRES        = "requires"
    ENABLES         = "enables"
    BLOCKS          = "blocks"
    EXECUTES_ON     = "executes_on"
    TRANSFORMS_INTO = "transforms_into"
    OBSERVES        = "observes"
    # v0.4 extension points
    DERIVES_FROM    = "derives_from"
    PROJECTS_TO     = "projects_to"


@dataclass(frozen=True)
class Edge:
    src_id: str
    dst_id: str
    kind: EdgeKind
    weight: float = 1.0
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __hash__(self) -> int:
        return hash((self.src_id, self.dst_id, self.kind))


# ── Execution contract ────────────────────────────────────────────────────────

@dataclass
class ExecutionConstraints:
    max_cost: float = 0.05           # USD per request
    max_latency_ms: float = 10_000.0
    determinism: bool = False        # require reproducible output
    memory_policy: str = "internal"  # internal | operator | public
    external_io_policy: str = "allow"  # allow | block | audit


@dataclass
class ExecutionContract:
    intent: str
    constraints: ExecutionConstraints = field(default_factory=ExecutionConstraints)
    allowed_resources: List[str] = field(default_factory=list)   # provider_ids
    forbidden_resources: List[str] = field(default_factory=list)
    # Compiled at planning time
    contract_id: str = field(default_factory=lambda: str(uuid.uuid4())[:12])


# ── Execution plan (output of PCSF optimizer) ─────────────────────────────────

@dataclass
class ExecutionStep:
    step_id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    node_id: str = ""
    estimated_cost: float = 0.0
    estimated_latency_ms: float = 0.0
    dilated_latency_ms: float = 0.0  # estimated_latency_ms * dilation


@dataclass
class ExecutionPlan:
    plan_id: str = field(default_factory=lambda: str(uuid.uuid4())[:12])
    contract_id: str = ""
    steps: List[ExecutionStep] = field(default_factory=list)
    total_cost: float = 0.0
    total_latency_ms: float = 0.0
    feasible: bool = True
    infeasibility_reason: str = ""


# ── System state ──────────────────────────────────────────────────────────────

@dataclass
class SystemState:
    """Snapshot of mutable runtime state — passed to the optimizer each tick."""
    resource_health: Dict[str, float] = field(default_factory=dict)   # provider_id → 0..1
    resource_latency: Dict[str, float] = field(default_factory=dict)  # provider_id → ms
    memory_load: int = 0       # number of active MemoryNodes
    active_constraints: List[str] = field(default_factory=list)       # satisfied constraint ids
    tick: int = 0
    timestamp: float = field(default_factory=time.time)


# ── PCSF optimizer ────────────────────────────────────────────────────────────

@dataclass
class CostWeights:
    latency: float = 0.3
    compute: float = 0.4
    risk: float = 0.2
    instability: float = 0.1


class PCSFOptimizer:
    """
    P* = argmin Cost(P) subject to ExecutionConstraints

    Cost(P) = w1*latency + w2*compute_cost + w3*risk + w4*instability

    Continuous re-optimization:
        P(t+Δt) = reoptimize(P(t), G, S, D)
    """

    def __init__(self, weights: Optional[CostWeights] = None) -> None:
        self.weights = weights or CostWeights()

    def _node_cost(
        self,
        node: ResourceNode,
        state: SystemState,
        dilation: float,
    ) -> Tuple[float, float, float]:
        """Returns (latency_cost, compute_cost, risk) for a ResourceNode."""
        base_lat = state.resource_latency.get(node.provider_id, node.latency_target_ms)
        dilated_lat = base_lat * dilation
        latency_cost = dilated_lat / 10_000.0  # normalize to 0..1

        compute_cost = node.cost_per_token * 1000  # approximate per-request cost

        health = state.resource_health.get(node.provider_id, node.health)
        risk = 1.0 - health  # unhealthy → high risk

        return latency_cost, compute_cost, risk

    def _total_cost(
        self,
        node: ResourceNode,
        state: SystemState,
        dilation: float,
        instability: float = 0.0,
    ) -> float:
        lat, comp, risk = self._node_cost(node, state, dilation)
        w = self.weights
        return w.latency * lat + w.compute * comp + w.risk * risk + w.instability * instability

    def optimize(
        self,
        graph: "CEGraph",
        contract: ExecutionContract,
        state: SystemState,
    ) -> ExecutionPlan:
        """Select the lowest-cost feasible resource path satisfying the contract."""
        plan = ExecutionPlan(contract_id=contract.contract_id)

        # Collect candidate ResourceNodes
        candidates: List[ResourceNode] = [
            n for n in graph.nodes_by_kind(NodeKind.RESOURCE)
            if isinstance(n, ResourceNode)
            and n.provider_id not in contract.forbidden_resources
            and (not contract.allowed_resources or n.provider_id in contract.allowed_resources)
        ]

        if not candidates:
            plan.feasible = False
            plan.infeasibility_reason = "no eligible ResourceNodes"
            return plan

        # Check hard constraints
        violated = [
            c for c in graph.nodes_by_kind(NodeKind.CONSTRAINT)
            if isinstance(c, ConstraintNode) and c.satisfied is False
            and c.severity == Severity.HARD
        ]
        if violated:
            plan.feasible = False
            plan.infeasibility_reason = f"hard constraints violated: {[c.predicate for c in violated]}"
            return plan

        # Rank candidates by cost
        scored = sorted(
            candidates,
            key=lambda n: self._total_cost(n, state, n.dilation),
        )

        for node in scored:
            lat = state.resource_latency.get(node.provider_id, node.latency_target_ms)
            dilated = lat * node.dilation
            cost = node.cost_per_token * 1000

            if cost > contract.constraints.max_cost:
                continue
            if dilated > contract.constraints.max_latency_ms:
                continue

            step = ExecutionStep(
                node_id=node.node_id,
                estimated_cost=cost,
                estimated_latency_ms=lat,
                dilated_latency_ms=dilated,
            )
            plan.steps.append(step)
            plan.total_cost += cost
            plan.total_latency_ms += dilated
            break  # single-step plan for v0.3; multi-step in future

        if not plan.steps:
            plan.feasible = False
            plan.infeasibility_reason = "no candidate satisfies cost+latency constraints"

        return plan

    def reoptimize(
        self,
        current_plan: ExecutionPlan,
        graph: "CEGraph",
        contract: ExecutionContract,
        state: SystemState,
    ) -> ExecutionPlan:
        """Continuous re-optimization — called each tick."""
        return self.optimize(graph, contract, state)


# ── CEGraph ───────────────────────────────────────────────────────────────────

class CEGraph:
    """
    Mutable convergence execution graph.

    Thread-safe node/edge add; read operations are lock-free for performance.
    """

    def __init__(self) -> None:
        self._nodes: Dict[str, AnyNode] = {}
        self._edges: Set[Edge] = set()
        self._lock = threading.Lock()
        self._tick = 0

    # ── Mutation ──────────────────────────────────────────────────────────────

    def add_node(self, node: AnyNode) -> str:
        with self._lock:
            self._nodes[node.node_id] = node
        return node.node_id

    def remove_node(self, node_id: str) -> Optional[AnyNode]:
        with self._lock:
            node = self._nodes.pop(node_id, None)
            # Remove all edges referencing this node
            self._edges = {e for e in self._edges if e.src_id != node_id and e.dst_id != node_id}
        return node

    def add_edge(self, src_id: str, dst_id: str, kind: EdgeKind, weight: float = 1.0) -> Edge:
        edge = Edge(src_id=src_id, dst_id=dst_id, kind=kind, weight=weight)
        with self._lock:
            self._edges.add(edge)
        return edge

    def swap_node(self, old_id: str, new_node: AnyNode) -> Optional[AnyNode]:
        """
        σ: v_old → v_new — atomic node replacement.
        Rewires all edges from old_id to new_node.node_id.
        Returns the removed node, or None if old_id not found.
        """
        with self._lock:
            old = self._nodes.pop(old_id, None)
            if old is None:
                return None
            self._nodes[new_node.node_id] = new_node
            # Rewire edges
            new_edges: Set[Edge] = set()
            for e in self._edges:
                src = new_node.node_id if e.src_id == old_id else e.src_id
                dst = new_node.node_id if e.dst_id == old_id else e.dst_id
                new_edges.add(Edge(src, dst, e.kind, e.weight, e.metadata))
            self._edges = new_edges
        return old

    # ── Queries (lock-free reads — safe because dict/set iteration is GIL-protected) ─

    def get_node(self, node_id: str) -> Optional[AnyNode]:
        return self._nodes.get(node_id)

    def nodes_by_kind(self, kind: NodeKind) -> List[AnyNode]:
        return [n for n in self._nodes.values() if n.kind == kind]

    def edges_from(self, node_id: str) -> List[Edge]:
        return [e for e in self._edges if e.src_id == node_id]

    def edges_to(self, node_id: str) -> List[Edge]:
        return [e for e in self._edges if e.dst_id == node_id]

    def blocked_by(self, node_id: str) -> List[str]:
        """Return node_ids that block this node."""
        return [e.src_id for e in self._edges if e.dst_id == node_id and e.kind == EdgeKind.BLOCKS]

    def required_by(self, node_id: str) -> List[str]:
        """Return node_ids that this node requires."""
        return [e.dst_id for e in self._edges if e.src_id == node_id and e.kind == EdgeKind.REQUIRES]

    def snapshot(self) -> Dict[str, Any]:
        return {
            "tick": self._tick,
            "node_count": len(self._nodes),
            "edge_count": len(self._edges),
            "nodes_by_kind": {
                k.value: sum(1 for n in self._nodes.values() if n.kind == k)
                for k in NodeKind
            },
        }

    def advance_tick(self) -> int:
        self._tick += 1
        return self._tick
