"""Σ₀-K1 grounding envelope + precision metric — issue #849.

Fixture-driven, no model call. The >34% grounded-eval bar (Gate B) needs a live
served run and is out of scope here.
"""
import pytest

from src.convergence.grounding import (
    GroundingEnvelope,
    grounding_coverage,
    grounding_precision,
)
from src.convergence.metrics import grounding_precision_over_records
from src.convergence.objects import ConvergenceRecord


def env(claim="c", evidence=("src/x.py:1",), confidence=0.8, source="kernel"):
    return GroundingEnvelope(claim=claim, evidence=list(evidence), confidence=confidence, source=source)


def test_envelope_well_formed_and_roundtrip():
    e = env()
    assert e.is_well_formed() and e.is_grounded()
    assert GroundingEnvelope.from_dict(e.to_dict()) == e
    assert set(e.to_dict()) == {"claim", "evidence", "confidence", "source"}


def test_envelope_validate_rejects_malformed():
    for bad in [
        env(claim=""),                       # empty claim
        env(evidence=()),                    # no evidence
        env(confidence=1.5),                 # out of range
        env(source=""),                      # empty source
    ]:
        assert not bad.is_well_formed()
        with pytest.raises(ValueError):
            bad.validate()


def test_grounding_precision_all_none_mixed():
    # all high-confidence outputs grounded → 1.0
    assert grounding_precision([env(confidence=0.9), env(confidence=0.8)]) == 1.0
    # high-confidence but ungrounded → 0.0 (the 'calm while wrong' miss)
    assert grounding_precision([env(confidence=0.9, evidence=[]), env(confidence=0.95, evidence=[])]) == 0.0
    # mixed: 1 of 2 high-confidence outputs grounded → 0.5 (low-confidence one ignored)
    mixed = [
        env(confidence=0.9, evidence=["a"]),   # asserted + grounded
        env(confidence=0.9, evidence=[]),       # asserted + ungrounded
        env(confidence=0.3, evidence=[]),       # below threshold → not counted
    ]
    assert grounding_precision(mixed) == 0.5
    # nothing clears the threshold → 0.0
    assert grounding_precision([env(confidence=0.1)]) == 0.0


def test_grounding_coverage():
    items = [env(), env(evidence=[]), env(claim="")]   # 1 well-formed of 3
    assert grounding_coverage(items) == pytest.approx(1 / 3)
    assert grounding_coverage([]) == 0.0


def test_grounding_precision_over_convergence_records():
    recs = [
        ConvergenceRecord(id="1", hypothesis="h1", evidence_ids=["m1"], result="grounded claim",
                          confidence=0.9, reasoner="kernel"),
        ConvergenceRecord(id="2", hypothesis="h2", evidence_ids=[], result="ungrounded claim",
                          confidence=0.9, reasoner="kernel"),
    ]
    # one of two high-confidence records cites evidence → 0.5
    assert grounding_precision_over_records(recs) == 0.5
    # the projection preserves the 4 fields
    e = GroundingEnvelope.from_record(recs[0])
    assert e.claim == "grounded claim" and e.evidence == ["m1"] and e.source == "kernel"
