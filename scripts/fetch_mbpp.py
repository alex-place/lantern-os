#!/usr/bin/env python3
"""Fetch MBPP and normalize to the spiral task schema for VTD corpus generation.

Writes data/eval/mbpp-full.jsonl with, per problem:
  {id, entry_point, prompt, tests:[{name, test}], reference}

- entry_point is parsed from the reference `code` (`def <name>(`), the reliable source.
- tests are MBPP's assert-based `test_list`, each prefixed with any `test_setup_code`
  (imports/helpers), so each is a self-contained Python check that raises on failure —
  exactly the exec-verifier contract.
- `reference` is MBPP's own solution (kept for provenance; NOT used as the training
  target — the training target is our cascade's verified solution).

Run:  C:\\dev\\lantern-os\\.venv-train\\Scripts\\python.exe scripts/fetch_mbpp.py
"""
import json
import os
import re
import sys

try:
    from datasets import load_dataset
except Exception as e:  # pragma: no cover
    print("datasets not available in this interpreter:", e, file=sys.stderr)
    sys.exit(2)

OUT = os.path.join("data", "eval", "mbpp-full.jsonl")


def main():
    # MBPP "full" — use the standard test split (500 problems) as the pool.
    ds = load_dataset("mbpp", "full", split="test")
    rows = []
    skipped = 0
    for r in ds:
        code = r.get("code", "") or ""
        m = re.search(r"def\s+([A-Za-z_]\w*)\s*\(", code)
        if not m:
            skipped += 1
            continue
        entry = m.group(1)
        setup = (r.get("test_setup_code", "") or "").strip()
        tests = []
        for i, t in enumerate(r.get("test_list", []) or []):
            body = (setup + "\n" if setup else "") + t
            tests.append({"name": f"t{i}", "test": body})
        if not tests:
            skipped += 1
            continue
        rows.append({
            "id": f"mbpp-{r['task_id']}",
            "entry_point": entry,
            "prompt": (r.get("text", "") or "").strip(),
            "tests": tests,
            "reference": code,
        })
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")
    print(f"wrote {len(rows)} problems to {OUT} (skipped {skipped} with no parseable def/tests)")


if __name__ == "__main__":
    main()
