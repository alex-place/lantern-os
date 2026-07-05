"""Tolerant reader for the honesty eval ledgers (#2110).

The honesty runs write per-item JSONL under `data/eval/epistemic/` and
`data/eval/halueval-local/`, but each family uses a *different* correctness field —
and neither is the `correct` a naive reader reaches for:

- `data/eval/halueval-local/*.jsonl`  →  ``{"q", "gold", "answer", "ok": bool}``
- `data/eval/epistemic/*.jsonl`        →  ``{"gold_class", "pred_class",
                                            "class_ok": bool, "verified_ok": bool}``

Because the correctness key differs (`ok` vs `class_ok`/`verified_ok`), a consumer
that assumes one schema silently misreads the other — exactly what happened when the
`/benchmarks` skill tried to quote an adapter honesty number this session and got
degenerate values, so it (correctly) refused to cite one. The writers live in an
external/training harness we don't control here, so the robust fix is a tolerant
*reader*: normalize any known schema (and a plain ``correct``/``passed`` future one)
to a single per-item correctness bool, and refuse to guess when a row has none.

Usage:
    from honesty_ledger import read_accuracy
    acc = read_accuracy("data/eval/halueval-local/honesty-balanced-1783226833.jsonl")
    # -> {"n": 41, "correct": 16, "accuracy": 0.39, "field": "ok"}
"""
from __future__ import annotations

import json
import os
from typing import Optional

# Correctness fields we know how to read, in priority order. For epistemic rows the
# "both class and verified right" reading (class_ok AND verified_ok) is the honest
# whole-item pass; `class_ok` alone is a partial credit we don't award by default.
_BOOL_FIELDS = ("correct", "passed", "ok")


def item_correct(row: dict) -> Optional[bool]:
    """Return whether one ledger item was correct, or None if the row has no known field.

    None (not False) for an unlabelable row is deliberate — a reader must be able to
    tell "wrong" apart from "can't tell", so an unscored file doesn't masquerade as 0%.
    """
    for f in _BOOL_FIELDS:
        if f in row and isinstance(row[f], bool):
            return row[f]
    # epistemic schema: whole-item pass = class right AND verified right.
    if "class_ok" in row or "verified_ok" in row:
        c = row.get("class_ok")
        v = row.get("verified_ok")
        if c is None and v is None:
            return None
        return bool(c if c is not None else True) and bool(v if v is not None else True)
    return None


def detected_field(row: dict) -> Optional[str]:
    for f in _BOOL_FIELDS:
        if f in row and isinstance(row[f], bool):
            return f
    if "class_ok" in row or "verified_ok" in row:
        return "class_ok+verified_ok"
    return None


def read_accuracy(path: str) -> dict:
    """Read one honesty-ledger file → ``{n, correct, accuracy, field, unscored}``.

    ``n`` counts only rows we could score; ``unscored`` counts rows with no known
    correctness field (surfaced, not silently dropped, so a half-labeled file is
    visible rather than confidently misread). ``accuracy`` is None when n == 0.
    """
    n = 0
    correct = 0
    unscored = 0
    field = None
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                unscored += 1
                continue
            c = item_correct(row)
            if c is None:
                unscored += 1
                continue
            field = field or detected_field(row)
            n += 1
            if c:
                correct += 1
    return {
        "n": n,
        "correct": correct,
        "accuracy": round(correct / n, 4) if n else None,
        "field": field,
        "unscored": unscored,
        "source": os.path.basename(path),
    }


if __name__ == "__main__":
    import sys

    for p in sys.argv[1:]:
        print(p, "->", read_accuracy(p))
