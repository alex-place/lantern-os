#!/usr/bin/env python3
"""Fetch TACO-verified (Apache-lineage TACO with VERIFIED solutions) and normalize the
stdio-style problems to the spiral task schema for VTD corpus generation at scale.

Source: HF `likaixin/TACO-verified` — 12,898 problems, each with executable stdin/stdout
test cases and verified reference solutions. (Canonical BAAI/TACO uses a legacy loading
script modern `datasets` refuses; this parquet mirror is the working path.)

Writes data/eval/taco-<difficulty>.jsonl with, per problem:
  {id, prompt, tests:[{name, stdin, expected}], difficulty, reference}

- stdio problems only in v1 (the large majority); call-based (fn_name) ones are skipped.
- tests capped per problem (default 6 of the ~200) — enough Fix-Rate granularity without
  a 200-subprocess verify per turn.
- `reference` = the first verified solution (Apache lineage) — enables the direct-SFT
  comparison arm alongside our cascade-generated traces.

Run:  C:\\dev\\lantern-os\\.venv-train\\Scripts\\python.exe scripts/fetch_taco.py --difficulty EASY
"""
import argparse
import json
import os
import sys

if os.name == "nt":
    os.environ.setdefault("HF_HOME", "D:/hf-cache")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--difficulty", default="EASY", help="CSV of TACO difficulties (EASY,MEDIUM,...) or ALL")
    ap.add_argument("--max-tests", type=int, default=6)
    ap.add_argument("--max-question-chars", type=int, default=4000)
    ap.add_argument("--max-io-chars", type=int, default=2000, help="skip cases with huge stdin/stdout blobs")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    from datasets import load_dataset
    ds = load_dataset("likaixin/TACO-verified", split="train")
    want = None if a.difficulty.upper() == "ALL" else {d.strip().upper() for d in a.difficulty.split(",")}

    out_path = a.out or os.path.join("data", "eval", f"taco-{a.difficulty.replace(',', '-').lower()}.jsonl")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    kept = skipped_call = skipped_fmt = skipped_diff = 0
    with open(out_path, "w", encoding="utf-8") as f:
        for idx, r in enumerate(ds):
            if want and str(r.get("difficulty", "")).upper() not in want:
                skipped_diff += 1
                continue
            q = (r.get("question") or "").strip()
            if not q or len(q) > a.max_question_chars or (r.get("picture_num") or 0):
                skipped_fmt += 1
                continue
            io = r.get("input_output")
            try:
                io = json.loads(io) if isinstance(io, str) else (io or {})
            except Exception:
                skipped_fmt += 1
                continue
            if io.get("fn_name"):
                skipped_call += 1
                continue
            ins, outs = io.get("inputs") or [], io.get("outputs") or []
            pairs = []
            for i, (si, so) in enumerate(zip(ins, outs)):
                if not isinstance(si, str) or not isinstance(so, str):
                    continue
                if len(si) > a.max_io_chars or len(so) > a.max_io_chars:
                    continue
                pairs.append({"name": f"c{i}", "stdin": si, "expected": so})
                if len(pairs) >= a.max_tests:
                    break
            if len(pairs) < 2:
                skipped_fmt += 1
                continue
            sols = r.get("solutions")
            try:
                sols = json.loads(sols) if isinstance(sols, str) else (sols or [])
            except Exception:
                sols = []
            f.write(json.dumps({
                "id": f"taco-{r.get('id', idx)}",
                "prompt": q + "\n\nWrite a complete Python program that reads from standard input and prints the answer to standard output.",
                "tests": pairs,
                "difficulty": str(r.get("difficulty", "")),
                "reference": (sols[0] if sols else None),
            }) + "\n")
            kept += 1
    print(f"wrote {kept} problems -> {out_path}")
    print(f"skipped: {skipped_diff} other-difficulty, {skipped_call} call-based (v2), {skipped_fmt} format/size")
    return 0


if __name__ == "__main__":
    sys.exit(main())
