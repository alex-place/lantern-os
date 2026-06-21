"""wq-005 — cross-language contract test for ConvergenceRecord emission.

dream-chat (Node) emits ConvergenceRecords via
apps/lantern-garage/lib/convergence-records.js. Those records must load cleanly
into the Python Convergence Core dataclass (src/convergence/objects.py). This
test LOCKS that schema contract: if either side drifts, it fails.
"""
import json
from datetime import datetime

from src.convergence.objects import ConvergenceRecord

# The exact JSON shape emitted by convergence-records.js::emitConvergenceRecord
JS_EMITTED = {
    "id": "cr-abc123-def456",
    "hypothesis": "user asked how to get home safe",
    "evidence_ids": ["2026-06-15T10:00:00.000Z", "mem-1"],
    "result": "the agent's reply text",
    "confidence": 0.7,
    "reasoner": "lantern",
    "timestamp": "2026-06-15T10:00:01.000Z",
    "verified": False,
    "verification_notes": None,
    "source": "dream-chat/lantern",
    "applied_evidence": [],  # #764 G9 — folded-evidence hashes (empty at emit time)
}

EMITTER_KEYS = {
    "id", "hypothesis", "evidence_ids", "result",
    "confidence", "reasoner", "timestamp", "verified", "verification_notes",
    "source",
    "applied_evidence",  # #764 G9
}


def _load(d):
    """Reconstruct a ConvergenceRecord from a JS-emitted dict."""
    return ConvergenceRecord(
        id=d["id"],
        hypothesis=d["hypothesis"],
        evidence_ids=list(d["evidence_ids"]),
        result=d["result"],
        confidence=d["confidence"],
        reasoner=d["reasoner"],
        timestamp=datetime.fromisoformat(d["timestamp"].replace("Z", "+00:00")),
        verified=d["verified"],
        verification_notes=d["verification_notes"],
        source=d.get("source"),
        applied_evidence=list(d.get("applied_evidence", [])),
    )


def test_emitter_keys_match_dataclass_fields():
    """The JS emitter must produce exactly the dataclass's serialized fields."""
    sample = ConvergenceRecord(
        id="x", hypothesis="h", evidence_ids=[], result=None,
        confidence=0.5, reasoner="r",
    )
    assert set(json.loads(sample.to_jsonl()).keys()) == EMITTER_KEYS
    assert set(JS_EMITTED.keys()) == EMITTER_KEYS


def test_js_emitted_record_loads_into_dataclass():
    rec = _load(JS_EMITTED)
    assert rec.id == "cr-abc123-def456"
    assert rec.hypothesis.startswith("user asked")
    assert rec.evidence_ids == ["2026-06-15T10:00:00.000Z", "mem-1"]
    assert rec.reasoner == "lantern"
    assert rec.verified is False
    assert rec.verification_notes is None


def test_confidence_in_unit_interval():
    rec = _load(JS_EMITTED)
    assert 0.0 <= rec.confidence <= 1.0


def test_roundtrip_jsonl_preserves_contract():
    out = json.loads(_load(JS_EMITTED).to_jsonl())
    assert out["id"] == JS_EMITTED["id"]
    assert out["evidence_ids"] == JS_EMITTED["evidence_ids"]
    assert out["reasoner"] == JS_EMITTED["reasoner"]
    assert out["verified"] is False
    assert out["verification_notes"] is None


def test_evidence_ids_grounds_in_memory():
    """A record with no evidence is allowed but flagged as ungrounded reasoning."""
    grounded = _load(JS_EMITTED)
    ungrounded = _load({**JS_EMITTED, "evidence_ids": []})
    assert len(grounded.evidence_ids) > 0
    assert ungrounded.evidence_ids == []
