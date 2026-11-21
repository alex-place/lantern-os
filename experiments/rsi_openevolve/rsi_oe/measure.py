"""Score programs on the final holdout, after the runs, outside every loop.

The holdout is 240 instances of stream "holdout", which no run process may generate
(binpack.FORBIDDEN_STREAMS). Nothing measured here is ever fed back to a run.

Measured per run: every generation's champion; every accepted child and its parent;
a fixed 15% sample of valid children that were not accepted (for the false-negative
rate); every successor-test parent and child. Results are cached by code hash in
<root>/holdout_cache.jsonl, so a program shared across runs is scored once.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import json
import sys
import threading
from pathlib import Path
from typing import Dict, Iterable, List, Set

import numpy as np

from . import binpack, sandbox

HOLDOUT_N = 240
REJECT_SAMPLE = 0.15


def holdout_instances() -> List[binpack.Instance]:
    return binpack.make_instances("holdout", range(HOLDOUT_N))


def _jsonl(path: Path) -> List[dict]:
    """Rows of a JSONL file; a half-written last line (a run still appending) is skipped."""
    if not path.exists():
        return []
    rows = []
    for ln in path.read_text(encoding="utf-8").splitlines():
        if ln.strip():
            try:
                rows.append(json.loads(ln))
            except json.JSONDecodeError:
                continue
    return rows


def _sampled(h: str) -> bool:
    return int(hashlib.sha256(f"reject-sample/{h}".encode()).hexdigest()[:8], 16) / 0xFFFFFFFF < REJECT_SAMPLE


def wanted_hashes(run_dir: Path) -> Set[str]:
    want: Set[str] = set()
    for snap in sorted((run_dir / "snapshots").glob("gen_*.json")):
        try:
            want.add(json.loads(snap.read_text(encoding="utf-8"))["champion"]["hash"])
        except (json.JSONDecodeError, KeyError):
            continue  # being written right now; the next pass picks it up
    for r in _jsonl(run_dir / "children.jsonl"):
        if r.get("valid") and r.get("child_hash"):
            if r.get("accepted") or _sampled(r["child_hash"]):
                want.add(r["child_hash"])
                want.add(r["parent_hash"])
    for r in _jsonl(run_dir / "successor.jsonl"):
        want.add(r["parent_hash"])
        if r.get("child_hash"):
            want.add(r["child_hash"])
    return want


class HoldoutCache:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.bins: Dict[str, List[int]] = {}
        self.errors: Dict[str, str] = {}
        for r in _jsonl(self.path):
            if r.get("bins") is not None:
                self.bins[r["hash"]] = r["bins"]
            else:
                self.errors[r["hash"]] = r.get("error", "")
        self._lock = threading.Lock()

    def put(self, h: str, bins=None, error: str = "") -> None:
        with self._lock:
            row = {"hash": h, "bins": bins} if bins is not None else {"hash": h, "bins": None,
                                                                      "error": error[:300]}
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")
            if bins is not None:
                self.bins[h] = bins
            else:
                self.errors[h] = error

    def has(self, h: str) -> bool:
        return h in self.bins or h in self.errors


def program_code(h: str, run_dirs: Iterable[Path]) -> str:
    for d in run_dirs:
        p = d / "programs" / f"{h}.py"
        if p.exists():
            return p.read_text(encoding="utf-8")
    raise FileNotFoundError(h)


def holdout_scores(cache: HoldoutCache, insts: List[binpack.Instance]) -> Dict[str, np.ndarray]:
    return {h: np.array([binpack.instance_score(i, b) for i, b in zip(insts, bins)])
            for h, bins in cache.bins.items()}


def measure(root: Path, workers: int = 4) -> dict:
    root = Path(root)
    run_dirs = sorted(p.parent for p in root.glob("*/config.json"))
    cache = HoldoutCache(root / "holdout_cache.jsonl")
    want: Set[str] = set()
    for d in run_dirs:
        want |= wanted_hashes(d)
    todo = sorted(h for h in want if not cache.has(h))
    insts = holdout_instances()
    pools = [sandbox.SandboxPool(1) for _ in range(workers)]
    free = list(range(workers))
    lock = threading.Lock()

    def work(h: str) -> None:
        with lock:
            k = free.pop()
        try:
            out = pools[k].run(program_code(h, run_dirs), insts, timeout=60 + 1.0 * len(insts))
        finally:
            with lock:
                free.append(k)
        if out.ok:
            cache.put(h, [out.bins[i.key] for i in insts])
        else:
            cache.put(h, error=out.error)

    try:
        with cf.ThreadPoolExecutor(workers) as ex:
            for n, _ in enumerate(ex.map(work, todo), 1):
                if n % 50 == 0:
                    print(f"measured {n}/{len(todo)}", flush=True)
    finally:
        for p in pools:
            p.close()
    return {"runs": len(run_dirs), "wanted": len(want), "measured_now": len(todo),
            "cached": len(cache.bins), "failed": len(cache.errors)}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Score programs on the final holdout")
    ap.add_argument("root")
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args(argv)
    print(json.dumps(measure(Path(a.root), a.workers)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
