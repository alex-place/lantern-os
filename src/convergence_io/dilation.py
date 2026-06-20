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
    collapse_proximity: float = 0.0,
) -> float:
    """
    Compute scalar dilation for a single node.

    Args:
        uncertainty:        0.0 (certain) → 1.0 (completely unknown)
        cost_pressure:      0.0 (no pressure) → 1.0 (must minimize cost)
        confidence:         0.0 (no confidence) → 1.0 (fully confident)
        collapse_proximity: 0.0 (far from a 42-state) → 1.0 (frozen / confidently-wrong)

    Returns:
        float in [D_MIN, D_MAX]

    Formula:
        raw = (1 + uncertainty) / (1 + confidence) / (1 + cost_pressure)
        Uncertainty inflates dilation; confidence and cost_pressure deflate it.

    G12 SIGN-FIX (#764). Naively, uncertainty inflates D — but near a Σ₀ collapse
    uncertainty is high AND confidence is low, so D would pin at D_MAX exactly when
    the system most needs to act / re-ground: a "maximally-dilated, never-resolving"
    livelock (temporal observer-collapse). So `collapse_proximity` deflates D toward
    D_MIN: proximity=1 ⇒ D_MIN regardless of uncertainty. Dilate to *think* when
    productively uncertain; collapse dilation to *go look* (act / re-ground) when
    frozen or confidently wrong.
    """
    uncertainty = max(0.0, min(1.0, uncertainty))
    cost_pressure = max(0.0, min(1.0, cost_pressure))
    confidence = max(0.0, min(1.0, confidence))
    p = max(0.0, min(1.0, collapse_proximity))

    raw = (1.0 + uncertainty) / ((1.0 + confidence) * (1.0 + cost_pressure))
    d = max(D_MIN, min(D_MAX, raw))
    d = (1.0 - p) * d + p * D_MIN          # near collapse → deflate toward D_MIN
    return max(D_MIN, min(D_MAX, d))


@dataclass
class GroundingPolicy:
    """How much EXTERNAL grounding to buy at a given dilation — the within→without
    bridge. Higher dilation (productive uncertainty) ⇒ reach out harder; near the
    fast/confident floor ⇒ cheap / cached."""
    fetch_external: bool
    max_results: int
    min_sources: int
    deep_mode: bool


def grounding_policy(D: float, base_max_results: int = 5,
                     base_min_sources: int = 2) -> GroundingPolicy:
    """Map a dilation value D to an external-grounding budget (route-by-difficulty).

    D ≤ 1 (confident / fast): minimal fetch, base corroboration, no deep loop.
    D > 1 (uncertain / slow): scale web breadth with D, raise the corroboration floor
    and escalate to DEEP mode once D is high. Realizes "dilation affects grounding
    from without"; pairs with the G12-corrected `dilation()` so a *frozen* node (low D)
    does not over-fetch and a *productively uncertain* node (high D) grounds harder.
    """
    D = max(D_MIN, min(D_MAX, D))
    if D <= 1.0:
        return GroundingPolicy(
            fetch_external=D > 0.5,
            max_results=base_max_results,
            min_sources=base_min_sources,
            deep_mode=False,
        )
    return GroundingPolicy(
        fetch_external=True,
        max_results=int(round(base_max_results * D)),
        min_sources=base_min_sources + (1 if D >= 3.0 else 0),
        deep_mode=D >= 3.0,
    )


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

    def __init__(self, max_dwell_ticks: int = 8, dwell_threshold: float = 1.5) -> None:
        self._states: Dict[str, NodeDilationState] = {}
        self._dwell: Dict[str, int] = {}            # consecutive ticks stuck in the slow region
        self._max_dwell_ticks = max_dwell_ticks      # G12 livelock guard
        # NOTE: dilation()'s practical ceiling is ~2.0 (numerator ≤2, denominator ≥1),
        # so the D_MAX=5 clamp rarely binds; "stuck slow" is keyed on this elevated
        # threshold, not D_MAX.
        self._dwell_threshold = dwell_threshold
        self._lock = threading.Lock()

    def update_node(
        self,
        node_id: str,
        uncertainty: float = 0.5,
        cost_pressure: float = 0.0,
        confidence: float = 0.5,
        collapse_proximity: float = 0.0,
    ) -> float:
        """Recompute and store dilation for node_id. Returns new value.

        G12 livelock guard: a node pinned near D_MAX for more than max_dwell_ticks
        consecutive ticks is forced to D_MIN — break the no-progress deliberation loop
        and act / re-ground. (Belt-and-suspenders to `collapse_proximity` deflation.)
        """
        d = dilation(uncertainty, cost_pressure, confidence, collapse_proximity)
        with self._lock:
            if d >= self._dwell_threshold:
                self._dwell[node_id] = self._dwell.get(node_id, 0) + 1
            else:
                self._dwell[node_id] = 0
            if self._dwell.get(node_id, 0) > self._max_dwell_ticks:
                d = D_MIN
                self._dwell[node_id] = 0
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
