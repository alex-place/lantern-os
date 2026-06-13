"""
dilation.py — Time Dilation Field D(v) for CEG nodes.

D(v) = f(uncertainty, cost_pressure, confidence)

Semantics:
  High uncertainty   → D > 1  (slow region — explore deeply, take more time)
  High confidence    → D < 1  (fast region — execute quickly)
  High cost_pressure → D < 1  (compressed — optimize for speed/cost)

Applied per-node per-tick by the execution loop:
  dilated_latency = base_latency * D(v)
  cost(edge) *= D(source_node)

Range: [D_MIN, D_MAX] — clamped to prevent runaway slowdowns.

Usage:
    from convergence_io.dilation import DilationField, dilation

    d = dilation(uncertainty=0.8, cost_pressure=0.2, confidence=0.5)  # → ~1.4
    field = DilationField()
    field.update_node("node-id", uncertainty=0.3, cost_pressure=0.7, confidence=0.9)
    d = field.get("node-id")
"""

from __future__ import annotations

import math
import threading
from dataclasses import dataclass, field
from typing import Dict, Optional

D_MIN = 0.1    # never compress below 10% of baseline
D_MAX = 5.0    # never dilate above 5× baseline
D_DEFAULT = 1.0


def dilation(
    uncertainty: float,
    cost_pressure: float,
    confidence: float,
) -> float:
    """
    Compute scalar dilation for a single node.

    Args:
        uncertainty:   0.0 (certain) → 1.0 (completely unknown)
        cost_pressure: 0.0 (no pressure) → 1.0 (must minimize cost)
        confidence:    0.0 (no confidence) → 1.0 (fully confident)

    Returns:
        float in [D_MIN, D_MAX]

    Formula:
        raw = (1 + uncertainty) / (1 + confidence) / (1 + cost_pressure)
        Uncertainty inflates dilation.
        Confidence and cost_pressure deflate it.
    """
    uncertainty = max(0.0, min(1.0, uncertainty))
    cost_pressure = max(0.0, min(1.0, cost_pressure))
    confidence = max(0.0, min(1.0, confidence))

    raw = (1.0 + uncertainty) / ((1.0 + confidence) * (1.0 + cost_pressure))
    return max(D_MIN, min(D_MAX, raw))


@dataclass
class NodeDilationState:
    uncertainty: float = 0.5
    cost_pressure: float = 0.0
    confidence: float = 0.5
    value: float = D_DEFAULT


class DilationField:
    """
    Maintains per-node dilation values.
    Updated each tick by the execution loop based on observed runtime signals.
    """

    def __init__(self) -> None:
        self._states: Dict[str, NodeDilationState] = {}
        self._lock = threading.Lock()

    def update_node(
        self,
        node_id: str,
        uncertainty: float = 0.5,
        cost_pressure: float = 0.0,
        confidence: float = 0.5,
    ) -> float:
        """Recompute and store dilation for node_id. Returns new value."""
        d = dilation(uncertainty, cost_pressure, confidence)
        with self._lock:
            self._states[node_id] = NodeDilationState(
                uncertainty=uncertainty,
                cost_pressure=cost_pressure,
                confidence=confidence,
                value=d,
            )
        return d

    def get(self, node_id: str) -> float:
        """Return current dilation for node_id (D_DEFAULT if unknown)."""
        state = self._states.get(node_id)
        return state.value if state else D_DEFAULT

    def update_from_health(self, node_id: str, health: float, latency_ratio: float) -> float:
        """
        Convenience updater: derive dilation from runtime health + latency signals.

        health:        0..1 (1 = fully healthy)
        latency_ratio: observed/target latency (1.0 = on target, >1 = slow)
        """
        uncertainty = 1.0 - health                          # unhealthy → uncertain
        cost_pressure = max(0.0, 1.0 - 1.0 / max(latency_ratio, 0.01))  # slow → pressure
        confidence = health * max(0.0, 1.0 - abs(latency_ratio - 1.0))
        return self.update_node(node_id, uncertainty, cost_pressure, confidence)

    def apply_to_graph(self, graph: Any) -> None:  # type: ignore[type-arg]
        """Write computed dilation values back into graph nodes."""
        for node_id, state in list(self._states.items()):
            node = graph.get_node(node_id)
            if node is not None:
                node.dilation = state.value

    def snapshot(self) -> Dict[str, float]:
        return {nid: s.value for nid, s in self._states.items()}


# ── Swap Convergence (anti-oscillation) ───────────────────────────────────────

class SwapConvergenceGuard:
    """
    Prevents oscillatory provider switching under PCSF + dilation dynamics.

    Tracks recent swap events per node. If the same swap (old→new) occurs
    more than `max_swaps` times within `window_ticks`, the swap is blocked
    and hysteresis is applied (D inflated for the worse candidate).
    """

    def __init__(self, max_swaps: int = 3, window_ticks: int = 10) -> None:
        self.max_swaps = max_swaps
        self.window_ticks = window_ticks
        self._history: Dict[str, list] = {}  # key → [tick, ...]
        self._lock = threading.Lock()

    def record_swap(self, old_id: str, new_id: str, tick: int) -> None:
        key = f"{old_id}→{new_id}"
        with self._lock:
            self._history.setdefault(key, [])
            self._history[key].append(tick)

    def is_oscillating(self, old_id: str, new_id: str, current_tick: int) -> bool:
        key = f"{old_id}→{new_id}"
        with self._lock:
            history = self._history.get(key, [])
            recent = [t for t in history if current_tick - t <= self.window_ticks]
            self._history[key] = recent
            return len(recent) >= self.max_swaps

    def reset(self, old_id: str, new_id: str) -> None:
        key = f"{old_id}→{new_id}"
        with self._lock:
            self._history.pop(key, None)
