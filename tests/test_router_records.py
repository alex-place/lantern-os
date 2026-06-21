"""wq-006 — routing decisions become ConvergenceRecords with source-based confidence."""
import json

from src.convergence.convergence_router import (
    RouteDecision, route_to_record, SOURCE_CONFIDENCE, DEFAULT_CONFIDENCE,
)
from src.convergence.objects import ConvergenceRecord

RECORD_KEYS = {
    "id", "hypothesis", "evidence_ids", "result",
    "confidence", "reasoner", "timestamp", "verified", "verification_notes",
    "source",
    "applied_evidence",  # #764 G9
}


def test_produces_convergence_record():
    rec = route_to_record(RouteDecision(query="status?", route="get_status", source="cache"))
    assert isinstance(rec, ConvergenceRecord)
    assert rec.reasoner == "convergence-router"


def test_cache_hit_is_high_confidence():
    rec = route_to_record(RouteDecision(query="q", route="get_status", source="cache", pattern_ids=["route-7"]))
    assert rec.confidence == SOURCE_CONFIDENCE["cache"] >= 0.9
    assert rec.evidence_ids == ["route-7"]


def test_compute_lower_than_cache():
    cache = route_to_record(RouteDecision(query="q", route="r", source="cache"))
    compute = route_to_record(RouteDecision(query="q", route="r", source="compute"))
    fallback = route_to_record(RouteDecision(query="q", route="r", source="fallback"))
    assert cache.confidence > compute.confidence > fallback.confidence


def test_unknown_source_defaults_midrange():
    rec = route_to_record(RouteDecision(query="q", route="r", source="weird"))
    assert rec.confidence == DEFAULT_CONFIDENCE
    assert 0.0 <= rec.confidence <= 1.0


def test_evidence_links_to_patterns():
    rec = route_to_record(RouteDecision(query="q", route="r", source="pattern",
                                        pattern_ids=["route-42", "route-7"]))
    assert rec.evidence_ids == ["route-42", "route-7"]


def test_record_serializes_to_contract():
    rec = route_to_record(RouteDecision(query="q", route="dispatch_work", source="pattern",
                                        latency_ms=12.5))
    out = json.loads(rec.to_jsonl())
    assert set(out.keys()) == RECORD_KEYS
    assert out["result"]["route"] == "dispatch_work"
    assert out["result"]["latency_ms"] == 12.5
    assert out["verified"] is False
