"""Scoring service shared by every arm: sandboxed runs, cached by (code, instance)."""
from __future__ import annotations

from typing import Dict, List, Sequence, Tuple

import numpy as np

from . import binpack, sandbox


class Evaluator:
    def __init__(self, pool: sandbox.SandboxPool):
        self.pool = pool
        self.cache: Dict[Tuple[str, str], int] = {}
        self.instance_evals = 0      # instances actually run (cache misses)
        self.program_runs = 0
        self.cpu_seconds = 0.0

    def bins(self, code: str, instances: Sequence[binpack.Instance]) -> Tuple[bool, Dict[str, int], str]:
        h = sandbox.code_hash(code)
        todo = [i for i in instances if (h, i.key) not in self.cache]
        if todo:
            timeout = 20.0 + 0.6 * len(todo)
            out = self.pool.run(code, todo, timeout)
            self.program_runs += 1
            self.cpu_seconds += out.cpu_seconds
            if not out.ok:
                return False, {}, out.error
            self.instance_evals += len(todo)
            for i in todo:
                self.cache[(h, i.key)] = out.bins[i.key]
        return True, {i.key: self.cache[(h, i.key)] for i in instances}, ""

    def scores(self, code: str, instances: Sequence[binpack.Instance]) -> Tuple[bool, np.ndarray, str]:
        ok, bins, err = self.bins(code, instances)
        if not ok:
            return False, np.array([]), err
        return True, np.array([binpack.instance_score(i, bins[i.key]) for i in instances]), ""

    def metrics(self, code: str, instances: Sequence[binpack.Instance]) -> Tuple[bool, dict, str]:
        ok, bins, err = self.bins(code, instances)
        if not ok:
            return False, {}, err
        return True, binpack.summarize(instances, [bins[i.key] for i in instances]), ""

    def stats(self) -> dict:
        return {"instance_evals": self.instance_evals, "program_runs": self.program_runs,
                "sandbox_cpu_seconds": round(self.cpu_seconds, 2)}


def family_metrics(instances: List[binpack.Instance], scores: np.ndarray) -> dict:
    out = {"combined_score": float(np.mean(scores)) if len(scores) else 0.0}
    for fam in binpack.FAMILIES:
        s = [x for x, i in zip(scores, instances) if i.family == fam]
        if s:
            out[f"{fam}_score"] = float(np.mean(s))
    return out
