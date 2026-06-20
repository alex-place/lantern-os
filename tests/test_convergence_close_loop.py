"""Tests for the Converge close-loop batch pass (scripts/convergence_close_loop.py).

Asserts the Verify → Converge wire actually fires:
- a passing outcome raises confidence and flips verified -> True
- a failing outcome collapses confidence (and verified -> True)
- a surprise (high NIS) reading collapses confidence
- a high-confidence verified record lands in the patterns output; a low-confidence
  one does not.
"""
import json
import sys
from pathlib import Path

import pytest

# scripts/ is not on pytest's pythonpath (apps src); add it so we can import the module.
_SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import convergence_close_loop as ccl  # noqa: E402


def _write_jsonl(path: Path, rows):
    with open(path, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")


@pytest.fixture
def fixture_paths(tmp_path):
    """A records.jsonl + outcomes.jsonl pair with one record per outcome kind."""
    records_path = tmp_path / "records.jsonl"
    outcomes_path = tmp_path / "outcomes.jsonl"
    patterns_path = tmp_path / "patterns.jsonl"

    records = [
        # Will pass -> high confidence -> should become a pattern.
        {"id": "rec-pass", "hypothesis": "passing claim", "evidence_ids": ["m1", "m2"],
         "result": "ok", "confidence": 0.8, "reasoner": "Keystone",
         "timestamp": "2026-06-16T04:59:31.053Z", "verified": False,
         "verification_notes": None},
        # Will fail -> collapsed confidence -> excluded from patterns.
        {"id": "rec-fail", "hypothesis": "failing claim", "evidence_ids": ["m3"],
         "result": "bad", "confidence": 0.8, "reasoner": "Keystone",
         "timestamp": "2026-06-16T04:59:32.602Z", "verified": False,
         "verification_notes": None},
        # High NIS surprise -> collapsed confidence.
        {"id": "rec-spook", "hypothesis": "spooked claim", "evidence_ids": [],
         "result": "x", "confidence": 0.9, "reasoner": "Lantern",
         "timestamp": "2026-06-16T04:59:33.000Z", "verified": False,
         "verification_notes": None},
        # No matching outcome -> stays unverified, never a pattern.
        {"id": "rec-orphan", "hypothesis": "ungraded claim", "evidence_ids": [],
         "result": "y", "confidence": 0.95, "reasoner": "Lantern",
         "timestamp": "2026-06-16T04:59:34.000Z", "verified": False,
         "verification_notes": None},
    ]
    outcomes = [
        {"record_id": "rec-pass", "passed": True, "notes": "benchmark green"},
        {"record_id": "rec-fail", "passed": False},
        {"record_id": "rec-spook", "nis": 500.0, "dof": 3},
    ]
    _write_jsonl(records_path, records)
    _write_jsonl(outcomes_path, outcomes)
    return records_path, outcomes_path, patterns_path


def test_passing_outcome_raises_confidence_and_verifies(fixture_paths):
    records_path, outcomes_path, _ = fixture_paths
    records = ccl.load_records(records_path)
    outcomes = ccl.load_outcomes(outcomes_path)
    ccl.grade_records(records, outcomes)

    rec = next(r for r in records if r.id == "rec-pass")
    assert rec.verified is True
    # verify_with_test: min(1.0, 0.5 + 0.5*0.8) = 0.9 > prior 0.8
    assert rec.confidence > 0.8
    assert rec.confidence == pytest.approx(0.9)


def test_failing_outcome_collapses_confidence(fixture_paths):
    records_path, outcomes_path, _ = fixture_paths
    records = ccl.load_records(records_path)
    outcomes = ccl.load_outcomes(outcomes_path)
    ccl.grade_records(records, outcomes)

    rec = next(r for r in records if r.id == "rec-fail")
    assert rec.verified is True
    # verify_with_test fail: 0.8 * 0.2 = 0.16 << prior
    assert rec.confidence < 0.8
    assert rec.confidence == pytest.approx(0.16)


def test_surprise_outcome_collapses_confidence(fixture_paths):
    records_path, outcomes_path, _ = fixture_paths
    records = ccl.load_records(records_path)
    outcomes = ccl.load_outcomes(outcomes_path)
    ccl.grade_records(records, outcomes)

    rec = next(r for r in records if r.id == "rec-spook")
    assert rec.verified is True
    # high NIS -> 0.9 * 0.3 = 0.27
    assert rec.confidence == pytest.approx(0.27)


def test_orphan_record_stays_unverified(fixture_paths):
    records_path, outcomes_path, _ = fixture_paths
    records = ccl.load_records(records_path)
    outcomes = ccl.load_outcomes(outcomes_path)
    ccl.grade_records(records, outcomes)

    rec = next(r for r in records if r.id == "rec-orphan")
    assert rec.verified is False
    assert rec.confidence == pytest.approx(0.95)


def test_high_confidence_verified_record_appears_in_patterns(fixture_paths):
    records_path, outcomes_path, patterns_path = fixture_paths
    summary = ccl.close_loop(
        records_path=records_path,
        outcomes_path=outcomes_path,
        patterns_path=patterns_path,
        min_confidence=0.85,
    )

    assert summary["records_loaded"] == 4
    assert summary["records_graded"] == 3

    pattern_ids = {p["record_id"] for p in summary["patterns"]}
    # Only rec-pass (0.9, verified) clears the 0.85 bar.
    assert "rec-pass" in pattern_ids
    assert "rec-fail" not in pattern_ids      # collapsed to 0.16
    assert "rec-spook" not in pattern_ids     # collapsed to 0.27
    assert "rec-orphan" not in pattern_ids    # high conf but unverified

    # patterns.jsonl was actually written and matches the summary.
    on_disk = [json.loads(line) for line in patterns_path.read_text().splitlines() if line.strip()]
    assert {p["record_id"] for p in on_disk} == pattern_ids
    pat = next(p for p in on_disk if p["record_id"] == "rec-pass")
    assert pat["evidence_count"] == 2
    assert pat["reasoner"] == "Keystone"
    assert pat["success_rate"] == pytest.approx(0.9)
