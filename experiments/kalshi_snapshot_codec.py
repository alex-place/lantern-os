"""
Kalshi tight-band snapshot decoder (Python side of the v2 keyframe+delta codec).

The writer lives in apps/lantern-garage/lib/kalshi-snapshot-codec.js; see that
file for the format rationale. This module only reads.

Handles transparently:
  - v1 files (full snapshot per line, the pre-2026-08 format)
  - v2 files (keyframe + per-ticker field deltas)
  - .gz variants of either

iter_snapshots() yields rows in the ORIGINAL v1 shape, so existing analysis
code keeps working after swapping its line loop:

    for row in iter_snapshots(path):
        ts = row.get("ts", "")[:19]
        for m in row.get("snapshot", {}).get("markets", []):
            ...
"""

from __future__ import annotations

import glob
import gzip
import json
import os
from pathlib import Path
from typing import Any, Dict, Iterator, List


def _open_text(path: Path):
    if str(path).endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8")
    return open(path, encoding="utf-8")


def iter_snapshots(path: Path | str) -> Iterator[Dict[str, Any]]:
    """Yield v1-shaped snapshot rows from a v1 or v2, plain or gzipped, file."""
    path = Path(path)
    state: Dict[str, Dict[str, Any]] = {}

    with _open_text(path) as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            try:
                row = json.loads(raw)
            except json.JSONDecodeError:
                continue  # tolerate a torn final line from an unclean shutdown

            if row.get("v") != 2:
                if "snapshot" in row:
                    yield row
                continue

            if row.get("kf"):
                state = {}
                for m in row.get("markets") or []:
                    t = m.get("ticker")
                    if t:
                        state[t] = dict(m)
            else:
                for ticker, diff in (row.get("d") or {}).items():
                    cur = state.get(ticker, {})
                    for k, v in diff.items():
                        if v is None:
                            cur.pop(k, None)
                        else:
                            cur[k] = v
                    cur.setdefault("ticker", ticker)
                    state[ticker] = cur
                for ticker in row.get("r") or []:
                    state.pop(ticker, None)

            markets: List[Dict[str, Any]] = list(state.values())
            yield {
                "ts": row.get("ts"),
                "markets": row.get("c", len(markets)),
                "exitCount": row.get("x", 0),
                "snapshot": {
                    "count": len(markets),
                    "exitCount": row.get("x", 0),
                    "generatedAt": row.get("ts"),
                    "markets": markets,
                },
            }


def find_snapshot_files(directory: Path | str, prefix: str = "tight-band-") -> List[Path]:
    """All snapshot files for a prefix, plain and gzipped, sorted by name."""
    directory = Path(directory)
    hits = glob.glob(str(directory / f"{prefix}*.jsonl")) + glob.glob(
        str(directory / f"{prefix}*.jsonl.gz")
    )
    return sorted({Path(h) for h in hits}, key=lambda p: os.path.basename(str(p)))
