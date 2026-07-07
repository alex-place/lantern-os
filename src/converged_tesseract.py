"""
Converged Tesseract — Lantern OS

Observer-collapsed 3^12 matrix model. Builds on csf.v07 QuantumDustField.
The full past/future map exists in the latent matrix. Only a minimal
active wavefront is rendered at any present moment.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

try:
    from csf.v07.quantum_dust import QuantumDustField
    from csf.v07.qutrit_delta import NUM_DIMENSIONS, QutritState

    _CSF_AVAILABLE = True
except Exception:
    _CSF_AVAILABLE = False


def _scalar_to_coords(scalar: int) -> Tuple[int, ...]:
    """Map a scalar position to 12 ternary coordinates."""
    coords = []
    for _ in range(NUM_DIMENSIONS):
        coords.append(scalar % 3)
        scalar //= 3
    return tuple(coords)


def _coords_to_scalar(coords: Tuple[int, ...]) -> int:
    """Map 12 ternary coordinates back to a scalar position."""
    scalar = 0
    mult = 1
    for c in coords:
        scalar += c * mult
        mult *= 3
    return scalar


def _ternary_distance(a: int, b: int) -> int:
    """Hamming-like distance in ternary coordinate space."""
    ac = _scalar_to_coords(a)
    bc = _scalar_to_coords(b)
    return sum(abs(ac[i] - bc[i]) for i in range(NUM_DIMENSIONS))


def _temporal_axis_position(external_time: float, cycle_seconds: float = 60.0) -> int:
    """Map wall-clock time to a cyclic scalar position on the temporal axis.

    The 3^12 space is far larger than any practical timeline, so we hash
    time into a walkable sub-region. The cycle_seconds parameter controls
    how much external time maps to one full traversal of the temporal axis.
    """
    tick = int(external_time / cycle_seconds)
    # Use a simple linear congruential walk to spread sequential times
    # across the space while keeping nearby times nearby in the matrix.
    pos = (tick * 7919) % (3 ** NUM_DIMENSIONS)
    return pos


@dataclass
class WavefrontSlice:
    """Active subset of the 3^12 matrix loaded into working memory."""

    center: int
    radius: int
    precision: float
    positions: Dict[int, Optional[List[QutritState]]] = field(default_factory=dict)
    metadata: Dict[str, float] = field(default_factory=dict)

    @property
    def slice_size(self) -> int:
        return len(self.positions)

    @property
    def active_count(self) -> int:
        """Positions that are not quantum dust (have resolved state)."""
        return sum(1 for v in self.positions.values() if v is not None)


@dataclass
class TimeDilationEngine:
    """Controls how quickly the wavefront moves through the matrix.

    Higher internal speed = more matrix ticks per external second.
    External dilation = the outside world appears slower from inside.
    """

    internal_ticks_per_second: float = 1.0
    base_cycle_seconds: float = 60.0

    def calculate_perceived_ratio(self) -> float:
        """Return internal_ticks / external_seconds."""
        return self.internal_ticks_per_second

    def map_time(self, external_time: float) -> int:
        """Map external time to a scalar position using current dilation."""
        # Adjust cycle_seconds inversely with internal speed
        # Faster internal speed = shorter cycle = more positions per external second
        effective_cycle = self.base_cycle_seconds / max(self.internal_ticks_per_second, 0.001)
        return _temporal_axis_position(external_time, effective_cycle)


class ConvergedTesseract:
    """Observer-collapsed tesseract.

    The full matrix is latent (CSF-compressed QuantumDustField).
    Only a minimal active wavefront is loaded into working memory.
    """

    def __init__(self, dust_field: Optional[QuantumDustField] = None) -> None:
        if not _CSF_AVAILABLE:
            raise RuntimeError("csf.v07 not available; ConvergedTesseract requires QuantumDustField")
        self.full_matrix = dust_field or QuantumDustField()
        self.active_wavefront: Optional[WavefrontSlice] = None
        self.observer_focus = 0.92
        self.dilation_engine = TimeDilationEngine()
        self._last_center: Optional[int] = None

    def get_minimal_slice(
        self,
        center: int,
        radius: int,
        precision: float,
    ) -> WavefrontSlice:
        """Select the minimally sufficient subset of the matrix for coherence.

        Algorithm:
          1. Gather candidate positions within ternary-radius of center.
          2. Rank candidates by information density (active deltas > baseline > dust).
          3. Select top N where N = max(1, int(radius * precision)).
          4. Resolve states for selected positions via QuantumDustField.
        """
        total_positions = self.full_matrix.total_positions
        radius = max(1, min(radius, total_positions))
        precision = max(0.01, min(precision, 1.0))

        # 1. Gather candidates within radius
        candidates: List[Tuple[int, int]] = []
        for offset in range(-radius, radius + 1):
            pos = (center + offset) % total_positions
            dist = _ternary_distance(center, pos)
            if dist <= radius:
                candidates.append((pos, dist))

        # 2. Rank by information density
        def _score(pos: int) -> float:
            # Higher score = more information = more important to include
            if pos in self.full_matrix.active_deltas:
                # Active deltas = highest density
                delta_count = len(self.full_matrix.active_deltas[pos])
                return 3.0 + delta_count
            if pos in self.full_matrix.baseline:
                # Baseline only = medium density
                return 2.0
            # Quantum dust = lowest density, but include some for context
            return 0.1

        scored = [(pos, _score(pos) / max(dist, 1)) for pos, dist in candidates]
        scored.sort(key=lambda x: x[1], reverse=True)

        # 3. Select top N
        n_select = max(1, int(len(scored) * precision))
        selected = [pos for pos, _ in scored[:n_select]]

        # 4. Resolve states
        positions: Dict[int, Optional[List[QutritState]]] = {}
        for pos in selected:
            positions[pos] = self.full_matrix.get_state(pos)

        return WavefrontSlice(
            center=center,
            radius=radius,
            precision=precision,
            positions=positions,
            metadata={
                "candidates": float(len(candidates)),
                "selected": float(n_select),
                "dust_included": float(sum(1 for v in positions.values() if v is None)),
            },
        )

    def update_present(self, external_time: float) -> WavefrontSlice:
        """Load and update only the minimal active slice needed for coherence."""
        center = self.dilation_engine.map_time(external_time)
        radius = int(self.observer_focus * 512)
        precision = self.observer_focus

        needed_slice = self.get_minimal_slice(
            center=center,
            radius=radius,
            precision=precision,
        )

        self.active_wavefront = needed_slice
        self._last_center = center

        # Optional: hysteresis — keep some overlap with previous slice
        if self._last_center is not None and self._last_center != center:
            # In a full implementation, merge previous overlapping positions
            pass

        return needed_slice

    def sensor_update(self) -> Dict[str, float]:
        """Return minimally sufficient data for sensors (user + digital)."""
        if self.active_wavefront is None:
            return {"status": "no_wavefront", "slice_size": 0.0}
        return {
            "status": "coherent",
            "slice_size": float(self.active_wavefront.slice_size),
            "active_states": float(self.active_wavefront.active_count),
            "center": float(self.active_wavefront.center),
            "dilation_ratio": self.dilation_engine.calculate_perceived_ratio(),
            **self.active_wavefront.metadata,
        }

    def set_focus(self, focus: float) -> None:
        """Adjust observer focus: 0.0 = diffuse, 1.0 = pinhole."""
        self.observer_focus = max(0.0, min(1.0, focus))

    def set_dilation(self, ticks_per_second: float) -> None:
        """Adjust time dilation: higher = faster internal traversal."""
        self.dilation_engine.internal_ticks_per_second = max(0.01, ticks_per_second)
