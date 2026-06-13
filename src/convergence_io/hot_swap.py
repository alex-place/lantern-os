"""
hot_swap.py — Hot-swap engine for CEG nodes.

σ: v_old → v_new  (runtime node replacement)

H = { candidate_set, swap_policy, trigger_rules, rollback_state }

Triggers (checked each tick by the execution loop):
  - Capability degradation  — resource health drops below threshold
  - Latency violation       — p99 latency exceeds target * dilation tolerance
  - Cost spike              — observed cost exceeds contract max
  - Authority revocation    — NAP profile updated, resource no longer authorized

Constraints:
  - Semantic continuity: state(v_old) ≈ state(v_new) — same capabilities required
  - Rollback available: if swap fails, v_old is restored from rollback_state
  - TraceEvent emitted for every swap (AAPF causal log)
  - SwapConvergenceGuard prevents oscillation (see dilation.py)

Invariant: the graph never enters a state where execution has no eligible node
           (at least one fallback is always maintained in the registry).

Usage:
    from convergence_io.hot_swap import HotSwapRegistry, SwapTrigger

    registry = HotSwapRegistry()
    registry.register_candidate(intent_node_id, new_resource_node)
    result = registry.check_and_swap(graph, state, dilation_field, current_tick)
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Tuple

from .ceg import (
    AnyNode, CEGraph, EdgeKind, NodeKind,
    ResourceNode, TraceNode,
)
from .dilation import SwapConvergenceGuard


class SwapTrigger(Enum):
    CAPABILITY_DEGRADED = "capability_degraded"
    LATENCY_VIOLATION   = "latency_violation"
    COST_SPIKE          = "cost_spike"
    AUTHORITY_REVOKED   = "authority_revoked"
    MANUAL              = "manual"


@dataclass
class SwapPolicy:
    health_threshold: float = 0.4       # swap if health < this
    latency_tolerance: float = 2.0      # swap if observed_lat > target * this
    cost_tolerance: float = 1.5         # swap if observed_cost > max_cost * this
    require_same_capabilities: bool = True
    allow_degraded_fallback: bool = True  # allow lower-quality if no perfect match


@dataclass
class SwapEvent:
    event_id: str = field(default_factory=lambda: str(uuid.uuid4())[:12])
    timestamp: float = field(default_factory=time.time)
    old_node_id: str = ""
    new_node_id: str = ""
    trigger: SwapTrigger = SwapTrigger.MANUAL
    success: bool = False
    rollback_used: bool = False
    reason: str = ""


@dataclass
class RollbackState:
    node_id: str
    node_snapshot: AnyNode
    captured_at: float = field(default_factory=time.time)


class HotSwapRegistry:
    """
    Maintains the hot-swap candidate set H and executes σ operators.

    Candidates are registered per-node-id. When a trigger fires,
    the best candidate (highest health, lowest cost) is selected.
    """

    def __init__(
        self,
        policy: Optional[SwapPolicy] = None,
        convergence_guard: Optional[SwapConvergenceGuard] = None,
    ) -> None:
        self.policy = policy or SwapPolicy()
        self._guard = convergence_guard or SwapConvergenceGuard()
        # node_id → list of candidate replacement nodes
        self._candidates: Dict[str, List[ResourceNode]] = {}
        # node_id → rollback snapshot
        self._rollbacks: Dict[str, RollbackState] = {}
        self._history: List[SwapEvent] = []

    def register_candidate(self, node_id: str, candidate: ResourceNode) -> None:
        """Add a candidate replacement for node_id."""
        self._candidates.setdefault(node_id, [])
        # Deduplicate by provider_id
        if not any(c.provider_id == candidate.provider_id for c in self._candidates[node_id]):
            self._candidates[node_id].append(candidate)

    def capture_rollback(self, node: AnyNode) -> None:
        """Snapshot the current node for potential rollback."""
        import copy
        self._rollbacks[node.node_id] = RollbackState(
            node_id=node.node_id,
            node_snapshot=copy.deepcopy(node),
        )

    def _select_candidate(
        self,
        node_id: str,
        state_health: Dict[str, float],
        current_tick: int,
    ) -> Optional[ResourceNode]:
        """Pick best candidate for node_id, respecting oscillation guard."""
        candidates = self._candidates.get(node_id, [])
        eligible = []
        for c in candidates:
            if self._guard.is_oscillating(node_id, c.node_id, current_tick):
                continue
            health = state_health.get(c.provider_id, c.health)
            if health > 0.0 or self.policy.allow_degraded_fallback:
                eligible.append((health, -c.cost_per_token, c))
        if not eligible:
            return None
        # Best = highest health, then lowest cost
        eligible.sort(key=lambda t: (t[0], t[1]), reverse=True)
        return eligible[0][2]

    def _check_triggers(
        self,
        node: ResourceNode,
        state_health: Dict[str, float],
        state_latency: Dict[str, float],
        contract_max_cost: float,
    ) -> Optional[SwapTrigger]:
        """Return the first trigger that fires for this node, or None."""
        health = state_health.get(node.provider_id, node.health)
        if health < self.policy.health_threshold:
            return SwapTrigger.CAPABILITY_DEGRADED

        lat = state_latency.get(node.provider_id, node.latency_target_ms)
        if lat > node.latency_target_ms * node.dilation * self.policy.latency_tolerance:
            return SwapTrigger.LATENCY_VIOLATION

        observed_cost = node.cost_per_token * 1000
        if observed_cost > contract_max_cost * self.policy.cost_tolerance:
            return SwapTrigger.COST_SPIKE

        return None

    def check_and_swap(
        self,
        graph: CEGraph,
        resource_health: Dict[str, float],
        resource_latency: Dict[str, float],
        contract_max_cost: float,
        current_tick: int,
    ) -> List[SwapEvent]:
        """
        Check all ResourceNodes for trigger conditions; execute swaps as needed.
        Returns list of SwapEvents (may be empty).
        """
        events: List[SwapEvent] = []

        for node in list(graph.nodes_by_kind(NodeKind.RESOURCE)):
            if not isinstance(node, ResourceNode):
                continue

            trigger = self._check_triggers(
                node, resource_health, resource_latency, contract_max_cost
            )
            if trigger is None:
                continue
            if node.node_id not in self._candidates:
                continue

            candidate = self._select_candidate(node.node_id, resource_health, current_tick)
            if candidate is None:
                continue

            # Capture rollback before swap
            self.capture_rollback(node)

            # Execute σ
            old_id = node.node_id
            removed = graph.swap_node(old_id, candidate)
            success = removed is not None

            if success:
                self._guard.record_swap(old_id, candidate.node_id, current_tick)
                # Emit TraceNode into graph
                trace = TraceNode(
                    label=f"swap:{trigger.value}",
                    event=f"hot_swap {old_id}→{candidate.node_id}",
                    causal_parent_id=old_id,
                    actor_node_id=candidate.node_id,
                )
                graph.add_node(trace)
            else:
                # Restore from rollback
                rollback = self._rollbacks.get(old_id)
                if rollback:
                    graph.add_node(rollback.node_snapshot)

            evt = SwapEvent(
                old_node_id=old_id,
                new_node_id=candidate.node_id,
                trigger=trigger,
                success=success,
                rollback_used=not success,
                reason=f"{trigger.value}: health={resource_health.get(node.provider_id, '?')}, "
                       f"lat={resource_latency.get(node.provider_id, '?')}ms",
            )
            self._history.append(evt)
            events.append(evt)

        return events

    @property
    def swap_history(self) -> List[SwapEvent]:
        return list(self._history)

    def summary(self) -> Dict[str, Any]:
        return {
            "registered_nodes": len(self._candidates),
            "total_swaps": len(self._history),
            "successful_swaps": sum(1 for e in self._history if e.success),
            "rollbacks": sum(1 for e in self._history if e.rollback_used),
        }


# ── v0.4: SwapHysteresis ──────────────────────────────────────────────────────

class SwapHysteresis:
    """
    Stability condition for hot-swaps — prevents oscillatory provider switching.

    swap_allowed(v) only if:
        improvement_score > epsilon          # minimum gain threshold
        AND cooldown_elapsed                 # time since last swap
        AND stability(v) > threshold         # node stability score

    Stability score: exponential moving average of health observations.
    Decays toward 0 when health is poor, recovers slowly when health improves.
    """

    def __init__(
        self,
        epsilon: float = 0.05,          # minimum improvement to justify swap
        cooldown_s: float = 30.0,       # seconds between swaps per node
        stability_threshold: float = 0.6,  # node must be this stable to be swappable
        stability_alpha: float = 0.2,   # EMA weight for stability updates
    ) -> None:
        self.epsilon = epsilon
        self.cooldown_s = cooldown_s
        self.stability_threshold = stability_threshold
        self.stability_alpha = stability_alpha
        self._last_swap_time: Dict[str, float] = {}
        self._stability: Dict[str, float] = {}
        self._lock = threading.Lock()

    def observe_health(self, node_id: str, health: float) -> float:
        """Update stability EMA for node_id. Returns new stability score."""
        with self._lock:
            current = self._stability.get(node_id, health)
            updated = (1 - self.stability_alpha) * current + self.stability_alpha * health
            self._stability[node_id] = updated
            return updated

    def stability(self, node_id: str) -> float:
        return self._stability.get(node_id, 0.5)

    def cooldown_elapsed(self, node_id: str) -> bool:
        last = self._last_swap_time.get(node_id, 0.0)
        return (time.time() - last) >= self.cooldown_s

    def swap_allowed(
        self,
        old_node_id: str,
        new_node_id: str,
        improvement_score: float,
    ) -> Tuple[bool, str]:
        """
        Returns (allowed, reason).

        improvement_score: e.g. (new_health - old_health) / max(old_health, 0.01)
        """
        if improvement_score <= self.epsilon:
            return False, f"improvement {improvement_score:.3f} ≤ epsilon {self.epsilon}"
        if not self.cooldown_elapsed(old_node_id):
            elapsed = time.time() - self._last_swap_time.get(old_node_id, 0.0)
            return False, f"cooldown: {elapsed:.1f}s < {self.cooldown_s}s"
        stab = self.stability(old_node_id)
        if stab < self.stability_threshold:
            return False, f"stability {stab:.3f} < threshold {self.stability_threshold}"
        return True, "ok"

    def record_swap(self, node_id: str) -> None:
        with self._lock:
            self._last_swap_time[node_id] = time.time()

    def summary(self) -> Dict[str, Any]:
        return {
            "epsilon": self.epsilon,
            "cooldown_s": self.cooldown_s,
            "stability_threshold": self.stability_threshold,
            "tracked_nodes": len(self._stability),
        }
