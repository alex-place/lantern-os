#!/usr/bin/env python3
"""
#2085 — periodic Converge job: compile high-confidence ConvergenceRecords into pattern memories.

The Convergence Core had `extract_patterns()` but nothing scheduled it or fed the result back into
Reason (convergence-core-mapping.md Stage 6: learning ✗). This is that job. Point a scheduler
(cron / Task Scheduler / the fleet loop) at it; each run:

  1. loads the persisted record history (kernel.load_records_from_disk),
  2. compiles records with confidence ≥ --min-confidence (and verified=True) into pattern MEMORIES
     written to the same append-only memory store Reason reads (kernel.compile_patterns), and
  3. is idempotent — already-compiled patterns are skipped, so re-running is safe.

Reason retrieves the results via the normal kernel.query_memory("convergence_pattern", ...) path —
no new store, per the single-Convergence-Core rule.

Usage:
    python scripts/compile_convergence_patterns.py
    python scripts/compile_convergence_patterns.py --min-confidence 0.9 \
        --records data/convergence-records.jsonl --memory data/memory.jsonl
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from convergence.kernel import Kernel  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="Compile high-confidence records into pattern memories (#2085)")
    ap.add_argument("--min-confidence", type=float, default=0.85)
    ap.add_argument("--records", default="data/convergence-records.jsonl")
    ap.add_argument("--memory", default="data/memory.jsonl")
    a = ap.parse_args()

    kernel = Kernel(memory_path=a.memory)
    kernel._load_memory_from_disk()                        # so idempotency sees prior pattern memories
    n_records = kernel.load_records_from_disk(path=a.records)
    written = kernel.compile_patterns(min_confidence=a.min_confidence)

    total_patterns = len(kernel.query_memory("convergence_pattern", min_confidence=0.0, limit=10_000))
    summary = {
        "records_loaded": n_records,
        "patterns_compiled_this_run": len(written),
        "pattern_memories_total": total_patterns,
        "min_confidence": a.min_confidence,
        "memory_store": a.memory,
        "new_patterns": [m.content.get("hypothesis") for m in written],
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
