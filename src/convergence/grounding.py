"""
Σ₀-K1 component 9 — the grounding envelope + grounding-precision  (#849, Gate B).

The External Reality Rule: *nothing is accepted without evidence*. Every kernel
output must carry the 4-field envelope ``[claim, evidence, confidence, source]``.
``grounding_precision`` then measures the failure this guards against — a confident
claim that cites no evidence (the "calm while wrong" mode, Σ₀ collapse certificate
§4): of the high-confidence outputs, what fraction are actually grounded.

This module is the envelope structure + the metric (unit-testable on fixtures). The
issue's "grounded eval_keystone run beats the 34% Gate B baseline" acceptance needs a
live grounded serving run (GPU / served Ouro) and is out of scope for the unit tests.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List


@dataclass
class GroundingEnvelope:
    """The 4-field External-Reality envelope a kernel output carries."""

    claim: str
    evidence: List[str]
    confidence: float
    source: str

    def is_well_formed(self) -> bool:
        return (
            isinstance(self.claim, str) and self.claim.strip() != ""
            and isinstance(self.evidence, list) and len(self.evidence) > 0
            and isinstance(self.confidence, (int, float)) and 0.0 <= float(self.confidence) <= 1.0
            and isinstance(self.source, str) and self.source.strip() != ""
        )

    def is_grounded(self) -> bool:
        """Carries at least one evidence pointer."""
        return bool(self.evidence)

    def validate(self) -> "GroundingEnvelope":
        if not self.is_well_formed():
            raise ValueError(f"ill-formed grounding envelope: {self.to_dict()}")
        return self

    def to_dict(self) -> Dict[str, Any]:
        return {
            "claim": self.claim,
            "evidence": list(self.evidence),
            "confidence": float(self.confidence),
            "source": self.source,
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "GroundingEnvelope":
        return cls(
            claim=str(d.get("claim", "")),
            evidence=list(d.get("evidence") or []),
            confidence=float(d.get("confidence", 0.0)),
            source=str(d.get("source", "")),
        )

    @classmethod
    def from_record(cls, record: Any) -> "GroundingEnvelope":
        """Project a ConvergenceRecord (hypothesis/evidence_ids/result/confidence/reasoner)."""
        return cls(
            claim=str(getattr(record, "result", "") or getattr(record, "hypothesis", "")),
            evidence=list(getattr(record, "evidence_ids", None) or []),
            confidence=float(getattr(record, "confidence", 0.0)),
            source=str(getattr(record, "reasoner", "") or "convergence-record"),
        )


def grounding_coverage(envelopes: Iterable[GroundingEnvelope]) -> float:
    """Fraction of outputs that carry a well-formed 4-field envelope."""
    env = list(envelopes)
    if not env:
        return 0.0
    return sum(1 for e in env if e.is_well_formed()) / len(env)


def grounding_precision(envelopes: Iterable[GroundingEnvelope], *, threshold: float = 0.7) -> float:
    """Of the high-confidence (≥ threshold) outputs, the fraction that cite evidence.

    A confident-but-ungrounded claim is a precision miss — exactly the External
    Reality Rule violation the envelope exists to prevent. Returns 0.0 if nothing
    clears the threshold (no confident claims to be wrong about).
    """
    asserted = [e for e in envelopes if float(e.confidence) >= threshold]
    if not asserted:
        return 0.0
    return sum(1 for e in asserted if e.is_grounded()) / len(asserted)
