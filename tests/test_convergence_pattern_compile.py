"""
#2085 — compile high-confidence ConvergenceRecords into reusable pattern MEMORIES.

Verifies the Converge→Remember→Reason feedback loop the issue flags as missing:
`kernel.compile_patterns()` writes patterns from records ≥0.85 confidence into the SAME memory
store `reason()`/`query_memory()` read (no new store), idempotently, and a periodic job can load
persisted records first (`load_records_from_disk`, previously write-only).

Run:  python -m pytest tests/test_convergence_pattern_compile.py -q
"""
import tempfile
from pathlib import Path

from src.convergence.kernel import Kernel
from src.convergence.objects import ConvergenceRecord


def _rec(kernel, hypothesis, confidence, verified, evidence=("e1",)):
    r = ConvergenceRecord(id=f"rec-{hypothesis}", hypothesis=hypothesis, evidence_ids=list(evidence),
                          result=None, confidence=confidence, reasoner="unit-test")
    r.verified = verified
    kernel.convergence_records.append(r)
    return r


def _kernel(tmp):
    return Kernel(memory_path=str(Path(tmp) / "memory.jsonl"))


def test_compile_writes_only_high_confidence_verified_patterns():
    with tempfile.TemporaryDirectory() as tmp:
        k = _kernel(tmp)
        _rec(k, "grounding beats guessing", 0.95, True)     # ✓ eligible
        _rec(k, "retrieval helps recall", 0.88, True)       # ✓ eligible
        _rec(k, "low-conf idea", 0.50, True)                # ✗ below 0.85
        _rec(k, "unverified hunch", 0.99, False)            # ✗ not verified
        written = k.compile_patterns(min_confidence=0.85)
        assert len(written) == 2
        assert all(m.source == "convergence_pattern" for m in written)
        hyps = {m.content["hypothesis"] for m in written}
        assert hyps == {"grounding beats guessing", "retrieval helps recall"}
        assert all(m.content["kind"] == "pattern" for m in written)


def test_patterns_are_retrievable_by_reason():
    with tempfile.TemporaryDirectory() as tmp:
        k = _kernel(tmp)
        _rec(k, "exec-verify catches wrong patches", 0.9, True)
        k.compile_patterns()
        # Reason retrieves via query_memory — by source and by content keyword
        by_source = k.query_memory("convergence_pattern")
        assert len(by_source) == 1 and by_source[0].content["hypothesis"] == "exec-verify catches wrong patches"
        by_keyword = k.query_memory("exec-verify")
        assert any(m.source == "convergence_pattern" for m in by_keyword)


def test_compile_is_idempotent():
    with tempfile.TemporaryDirectory() as tmp:
        k = _kernel(tmp)
        _rec(k, "balance breaks the collapse", 0.92, True)
        first = k.compile_patterns()
        second = k.compile_patterns()          # same records → nothing new
        assert len(first) == 1 and second == []
        assert len(k.query_memory("convergence_pattern")) == 1   # not duplicated


def test_load_records_from_disk_round_trips():
    with tempfile.TemporaryDirectory() as tmp:
        recs_path = str(Path(tmp) / "records.jsonl")
        writer = _kernel(tmp)
        for h, c, v in [("a", 0.9, True), ("b", 0.6, False), ("c", 0.87, True)]:
            writer.save_convergence_record(_rec(writer, h, c, v), path=recs_path)
        fresh = _kernel(tmp)
        n = fresh.load_records_from_disk(path=recs_path)
        assert n == 3 and len(fresh.convergence_records) == 3
        assert {r.hypothesis for r in fresh.convergence_records} == {"a", "b", "c"}
        assert sum(1 for r in fresh.convergence_records if r.verified) == 2


def test_end_to_end_periodic_job():
    """save verified records → fresh kernel loads them → compile → Reason can query the patterns."""
    with tempfile.TemporaryDirectory() as tmp:
        recs_path = str(Path(tmp) / "records.jsonl")
        w = _kernel(tmp)
        w.save_convergence_record(_rec(w, "grounded answers reduce confabulation", 0.9, True), path=recs_path)
        w.save_convergence_record(_rec(w, "noise below threshold", 0.4, True), path=recs_path)

        job = _kernel(tmp)                       # a fresh process, as a scheduler would spawn
        assert job.load_records_from_disk(path=recs_path) == 2
        written = job.compile_patterns(min_confidence=0.85)
        assert len(written) == 1
        hit = job.query_memory("grounded answers")
        assert hit and hit[0].source == "convergence_pattern"


def test_load_missing_records_file_is_zero_not_error():
    with tempfile.TemporaryDirectory() as tmp:
        k = _kernel(tmp)
        assert k.load_records_from_disk(path=str(Path(tmp) / "nope.jsonl")) == 0


if __name__ == "__main__":
    import sys
    fns = [v for k_, v in sorted(globals().items()) if k_.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn(); print(f"  ok  - {fn.__name__}")
        except AssertionError as e:
            failed += 1; print(f"  FAIL- {fn.__name__}\n       {e}")
    print(f"\n{'all passed' if not failed else str(failed)+' FAILED'} ({len(fns)} tests)")
    sys.exit(1 if failed else 0)
