"""Converge stage — batch close-loop pass over emitted ConvergenceRecords.

JS (the Reason/Act stages) emits records to ``data/convergence/records.jsonl`` but
nothing folds real outcomes back into them — the Verify → Converge wire runs nowhere.
This script is that wire as a runnable batch pass:

1. Read ``records.jsonl`` (the emitted, mostly-unverified records).
2. Read an outcomes sidecar ``outcomes.jsonl`` mapping a record to what actually
   happened ({record_id, passed} for a test/benchmark, and/or {record_id, nis, dof}
   for a Kalman surprise reading). Apply src/convergence/verify.py to each matched
   record, mutating ``verified`` + ``confidence``.
3. Run extract_patterns(min_confidence) over the now-verified records and write the
   high-confidence summaries to ``data/convergence/patterns.jsonl``.

Importable (use the functions) and runnable (``python -m scripts.convergence_close_loop``
or ``python scripts/convergence_close_loop.py``).

Reference: convergence/kernel.py::extract_patterns, convergence/verify.py.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

# Make ``src`` importable when run as a plain script (mirrors pytest.ini pythonpath).
_SRC = Path(__file__).resolve().parent.parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from convergence.objects import ConvergenceRecord  # noqa: E402
from convergence.verify import verify_with_surprise, verify_with_test  # noqa: E402

DEFAULT_RECORDS_PATH = "data/convergence/records.jsonl"
DEFAULT_OUTCOMES_PATH = "data/convergence/outcomes.jsonl"
DEFAULT_PATTERNS_PATH = "data/convergence/patterns.jsonl"


def record_from_dict(data: Dict[str, Any]) -> ConvergenceRecord:
    """Construct a ConvergenceRecord from a parsed JSONL dict.

    objects.py has ``to_jsonl`` but no ``from_jsonl``; this is the inverse, lenient
    about missing optional fields so partially-formed emitted records still load.
    """
    ts = data.get("timestamp")
    if isinstance(ts, str):
        try:
            # tolerate trailing 'Z' (JS ISO output) which fromisoformat rejects pre-3.11
            timestamp = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            timestamp = datetime.now()
    else:
        timestamp = datetime.now()

    return ConvergenceRecord(
        id=data["id"],
        hypothesis=data.get("hypothesis", ""),
        evidence_ids=data.get("evidence_ids", []) or [],
        result=data.get("result"),
        confidence=float(data.get("confidence", 0.5)),
        reasoner=data.get("reasoner", "unknown"),
        timestamp=timestamp,
        verified=bool(data.get("verified", False)),
        verification_notes=data.get("verification_notes"),
    )


def load_records(path: str | Path) -> List[ConvergenceRecord]:
    """Load all ConvergenceRecords from a JSONL file (skips blank/corrupt lines)."""
    records: List[ConvergenceRecord] = []
    p = Path(path)
    if not p.exists():
        return records
    with open(p, "r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                records.append(record_from_dict(json.loads(line)))
            except (json.JSONDecodeError, KeyError):
                continue
    return records


def load_outcomes(path: str | Path) -> Dict[str, Dict[str, Any]]:
    """Load the outcomes sidecar into a {record_id: outcome_dict} map.

    Each outcome line carries ``record_id`` plus either a test result (``passed``)
    or a surprise reading (``nis`` + ``dof``). Later lines for the same id win.
    """
    outcomes: Dict[str, Dict[str, Any]] = {}
    p = Path(path)
    if not p.exists():
        return outcomes
    with open(p, "r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            rid = entry.get("record_id")
            if rid is None:
                continue
            outcomes[rid] = entry
    return outcomes


def grade_records(
    records: List[ConvergenceRecord],
    outcomes: Dict[str, Dict[str, Any]],
) -> List[ConvergenceRecord]:
    """Apply verify.py to every record that has a resolvable outcome (mutates in place).

    Returns the list of records that were actually graded. A ``passed`` key routes to
    verify_with_test; an ``nis``/``dof`` pair routes to verify_with_surprise. Records
    with no matching outcome are left untouched (still unverified at their prior).
    """
    graded: List[ConvergenceRecord] = []
    for record in records:
        outcome = outcomes.get(record.id)
        if outcome is None:
            continue
        if "passed" in outcome:
            verify_with_test(record, bool(outcome["passed"]), outcome.get("notes"))
            graded.append(record)
        elif "nis" in outcome and "dof" in outcome:
            verify_with_surprise(record, float(outcome["nis"]), int(outcome["dof"]))
            graded.append(record)
        # else: outcome line without a resolvable signal — skip
    return graded


def extract_patterns(
    records: List[ConvergenceRecord],
    min_confidence: float = 0.85,
) -> List[Dict[str, Any]]:
    """Extract high-confidence verified records as pattern summaries.

    Mirrors Kernel.extract_patterns (kernel.py) but operates on a passed-in list so
    the batch pass stays free-standing.
    """
    high_confidence = [
        rec for rec in records
        if rec.confidence >= min_confidence and rec.verified
    ]
    patterns: List[Dict[str, Any]] = []
    for record in high_confidence:
        patterns.append({
            "record_id": record.id,
            "hypothesis": record.hypothesis,
            "success_rate": record.confidence,
            "evidence_count": len(record.evidence_ids),
            "reasoner": record.reasoner,
        })
    return patterns


def write_patterns(patterns: List[Dict[str, Any]], path: str | Path) -> None:
    """Write pattern summaries as JSONL (one object per line), overwriting prior output."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        for pattern in patterns:
            f.write(json.dumps(pattern) + "\n")


def close_loop(
    records_path: str | Path = DEFAULT_RECORDS_PATH,
    outcomes_path: str | Path = DEFAULT_OUTCOMES_PATH,
    patterns_path: Optional[str | Path] = DEFAULT_PATTERNS_PATH,
    min_confidence: float = 0.85,
) -> Dict[str, Any]:
    """Run the full batch close-loop: load → grade → extract → write patterns.

    Returns a summary dict (counts + the extracted patterns). When ``patterns_path``
    is None the patterns are computed but not written (handy for tests/dry runs).
    """
    records = load_records(records_path)
    outcomes = load_outcomes(outcomes_path)
    graded = grade_records(records, outcomes)
    patterns = extract_patterns(records, min_confidence=min_confidence)
    if patterns_path is not None:
        write_patterns(patterns, patterns_path)
    return {
        "records_loaded": len(records),
        "outcomes_loaded": len(outcomes),
        "records_graded": len(graded),
        "patterns_extracted": len(patterns),
        "patterns": patterns,
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Batch Converge pass: grade emitted ConvergenceRecords against an "
                    "outcomes sidecar, then extract high-confidence patterns.")
    parser.add_argument("--records", default=DEFAULT_RECORDS_PATH,
                        help=f"emitted records JSONL (default: {DEFAULT_RECORDS_PATH})")
    parser.add_argument("--outcomes", default=DEFAULT_OUTCOMES_PATH,
                        help=f"outcomes sidecar JSONL (default: {DEFAULT_OUTCOMES_PATH})")
    parser.add_argument("--patterns", default=DEFAULT_PATTERNS_PATH,
                        help=f"patterns output JSONL (default: {DEFAULT_PATTERNS_PATH})")
    parser.add_argument("--min-confidence", type=float, default=0.85,
                        help="confidence threshold for pattern extraction (default: 0.85)")
    args = parser.parse_args(argv)

    summary = close_loop(
        records_path=args.records,
        outcomes_path=args.outcomes,
        patterns_path=args.patterns,
        min_confidence=args.min_confidence,
    )
    print(json.dumps({k: v for k, v in summary.items() if k != "patterns"}))
    print(f"wrote {summary['patterns_extracted']} pattern(s) -> {args.patterns}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
