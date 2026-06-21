"""Converge stage — track convergence metrics over time (wq-013).

kernel.get_convergence_metrics() gives a single snapshot. This module tracks
snapshots over time so we can answer the real question: is the system actually
*converging*? — confidence growing, failures shrinking, patterns stabilizing.

A system that is converging gets steadily more confident and less wrong on its
verified reasoning. A system that is diverging or collapsing does not. This is the
Converge stage's observability layer.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List

from .objects import ConvergenceRecord


def snapshot_metrics(records: Iterable[ConvergenceRecord]) -> Dict[str, Any]:
    """One point-in-time snapshot over a set of ConvergenceRecords."""
    records = list(records)
    verified = [r for r in records if r.verified]
    n = len(verified)
    mean_conf = sum(r.confidence for r in verified) / n if n else 0.0
    successes = sum(1 for r in verified if r.confidence > 0.7)
    failures = sum(1 for r in verified if r.confidence < 0.5)
    return {
        "total_records": len(records),
        "verified_records": n,
        "mean_confidence": mean_conf,
        "success_rate": successes / n if n else 0.0,
        "failure_rate": failures / n if n else 0.0,
    }


class ConvergenceTracker:
    """Accumulate metric snapshots and report whether the system is converging."""

    def __init__(self) -> None:
        self.history: List[Dict[str, Any]] = []

    def record(self, records: Iterable[ConvergenceRecord]) -> Dict[str, Any]:
        """Take a snapshot over `records` and append it to the history."""
        snap = snapshot_metrics(records)
        self.history.append(snap)
        return snap

    def confidence_growth(self) -> float:
        """Change in mean confidence from the first snapshot to the latest."""
        if len(self.history) < 2:
            return 0.0
        return self.history[-1]["mean_confidence"] - self.history[0]["mean_confidence"]

    def failure_reduction(self) -> float:
        """Drop in failure rate from the first snapshot to the latest (positive = improving)."""
        if len(self.history) < 2:
            return 0.0
        return self.history[0]["failure_rate"] - self.history[-1]["failure_rate"]

    def is_converging(self) -> bool:
        """Converging = at least two snapshots, confidence not falling, failures not rising."""
        return (len(self.history) >= 2
                and self.confidence_growth() >= 0.0
                and self.failure_reduction() >= 0.0)


def grounding_precision_over_records(
    records: Iterable[ConvergenceRecord], *, threshold: float = 0.7
) -> float:
    """Gate B grounding-precision over ConvergenceRecords (#849).

    Projects each record to a GroundingEnvelope via ``GroundingEnvelope.from_record``
    and delegates to ``grounding.grounding_precision``.  Kept in ``metrics`` so callers
    that already import from here don't need a second import.
    """
    from .grounding import GroundingEnvelope, grounding_precision

    envelopes = [GroundingEnvelope.from_record(r) for r in records]
    return grounding_precision(envelopes, threshold=threshold)

    def trajectory(self) -> Dict[str, Any]:
        """Summary of the convergence trajectory across all snapshots."""
        return {
            "snapshots": len(self.history),
            "confidence_growth": self.confidence_growth(),
            "failure_reduction": self.failure_reduction(),
            "converging": self.is_converging(),
            "latest": self.history[-1] if self.history else None,
        }
