"""Convergence Router — emit ConvergenceRecords for routing decisions (wq-006).

The router decides how to handle a query: a deterministic local cache/pattern hit,
or an external compute fallback. Each decision is one reasoning cycle, recorded as a
ConvergenceRecord so routing becomes observable, learnable, and verifiable — the
Reason stage of the Convergence Loop.

Confidence reflects the decision's grounding:
- a cache hit is high-confidence  (a known route pattern matched deterministically)
- a pattern match is fairly high   (a learned pattern matched)
- a compute fallback is lower      (no cached pattern; a model/heuristic chose)
- a bare fallback is lowest        (default route, no evidence)

Reference: apps/lantern-garage/lib/convergence-router.js (120 unisona.ai routes,
>70% cache hit rate); src/convergence/objects.py::ConvergenceRecord.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import List, Optional

from .objects import ConvergenceRecord

# Confidence by routing source (heuristic v1; deterministic hits are trusted more).
SOURCE_CONFIDENCE = {
    "cache": 0.95,
    "pattern": 0.85,
    "compute": 0.60,
    "fallback": 0.40,
}
DEFAULT_CONFIDENCE = 0.50  # unknown source


@dataclass
class RouteDecision:
    """One routing decision the router made for a query."""
    query: str
    route: str                              # which handler/route was chosen
    source: str                             # cache | pattern | compute | fallback
    pattern_ids: List[str] = field(default_factory=list)  # routing patterns/memories matched
    latency_ms: Optional[float] = None


def route_to_record(decision: RouteDecision,
                    reasoner: str = "convergence-router") -> ConvergenceRecord:
    """Turn a RouteDecision into a ConvergenceRecord (route decision + confidence).

    Confidence comes from the routing source (cache hit vs. compute), and
    evidence_ids link to the routing patterns that justified the choice.
    """
    confidence = SOURCE_CONFIDENCE.get(decision.source, DEFAULT_CONFIDENCE)
    return ConvergenceRecord(
        id=f"cr-route-{uuid.uuid4().hex[:8]}",
        hypothesis=f"route query to '{decision.route}' via {decision.source}",
        evidence_ids=list(decision.pattern_ids),
        result={
            "route": decision.route,
            "source": decision.source,
            "latency_ms": decision.latency_ms,
        },
        confidence=confidence,
        reasoner=reasoner,
    )
