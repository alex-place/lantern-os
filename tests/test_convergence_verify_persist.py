"""
#2084 — Verify outcomes are stored as ConvergenceRecords and update the originating confidence.

convergence-core-mapping.md Stage 5: "test results don't flow back to update memory confidence."
kernel.verify() updated confidence only in memory; now it persists the verified record to
records_path so a verifiable action (autowork test run, Kalshi resolution) leaves a durable
record whose confidence was raised/lowered by the outcome.

Run:  python -m pytest tests/test_convergence_verify_persist.py -q
"""
import json
import tempfile
from pathlib import Path

from src.convergence.kernel import Kernel
from src.convergence.objects import ConvergenceRecord


def _rec(hypothesis, confidence):
    return ConvergenceRecord(id=f"rec-{hypothesis[:6]}", hypothesis=hypothesis, evidence_ids=["e1"],
                             result="predicted-X", confidence=confidence, reasoner="unit-test")


def _records(kernel):
    p = Path(kernel.records_path)
    if not p.exists():
        return []
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]


def test_verify_success_raises_confidence_and_persists_outcome():
    with tempfile.TemporaryDirectory() as tmp:
        k = Kernel(memory_path=str(Path(tmp) / "memory.jsonl"))
        r = _rec("grounding lowers hallucination", 0.6)
        k.convergence_records.append(r)
        out = k.verify(r, actual_outcome={"tests": "green"}, success=True)
        assert out is r and r.verified and r.confidence > 0.6          # confidence raised in place
        rows = _records(k)
        assert len(rows) == 1                                          # outcome stored as a record
        assert rows[0]["verified"] is True and rows[0]["confidence"] > 0.6
        assert "Success: True" in rows[0]["verification_notes"]


def test_verify_failure_lowers_confidence_and_persists():
    with tempfile.TemporaryDirectory() as tmp:
        k = Kernel(memory_path=str(Path(tmp) / "memory.jsonl"))
        r = _rec("shaky claim", 0.7)
        k.convergence_records.append(r)
        k.verify(r, actual_outcome={"tests": "red"}, success=False)
        assert abs(r.confidence - 0.5) < 1e-9                          # 0.7 - 0.2
        rows = _records(k)
        assert abs(rows[0]["confidence"] - 0.5) < 1e-9 and "Success: False" in rows[0]["verification_notes"]


def test_verify_persist_false_updates_memory_but_writes_nothing():
    with tempfile.TemporaryDirectory() as tmp:
        k = Kernel(memory_path=str(Path(tmp) / "memory.jsonl"))
        r = _rec("no-persist", 0.6)
        k.convergence_records.append(r)
        k.verify(r, actual_outcome={}, success=True, persist=False)
        assert r.confidence > 0.6 and _records(k) == []               # in-memory only


def test_records_path_is_isolated_to_the_memory_dir():
    with tempfile.TemporaryDirectory() as tmp:
        k = Kernel(memory_path=str(Path(tmp) / "memory.jsonl"))
        assert Path(k.records_path) == Path(tmp) / "convergence-records.jsonl"


if __name__ == "__main__":
    import sys
    fns = [v for kk, v in sorted(globals().items()) if kk.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn(); print(f"  ok  - {fn.__name__}")
        except AssertionError as e:
            failed += 1; print(f"  FAIL- {fn.__name__}\n       {e}")
    print(f"\n{'all passed' if not failed else str(failed) + ' FAILED'} ({len(fns)} tests)")
    sys.exit(1 if failed else 0)
