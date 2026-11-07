"""Online bin packing: instance generator, packer and exact scorer.

The problem family is FunSearch's online bin packing (Romera-Paredes et al., Nature 2024),
which is the same shape as AlphaEvolve's data-centre scheduling heuristic: a priority
function decides where each arriving item goes. Instances follow the OR-Library
"binpack1-4" recipe FunSearch evaluated on (capacity 150, integer item sizes drawn
uniformly), with the size range and item count drawn per instance. Every instance comes
from a (stream, index) pair, so fresh instances cost microseconds and every score is exact.

Score of a program on one instance: the bins it saves against best fit, in percent of
the L1 lower bound ceil(sum(items) / capacity). Pairing with best fit on the same
instance removes most of the instance-to-instance difficulty, so a score measured on any
instance set estimates the same quantity as the holdout score. Higher is better; best fit
scores exactly 0. Headroom exists: FunSearch's published OR heuristic saves 0.8-1.1 pp
over best fit on this recipe at 120-1000 items (checked 2026-11-06 with this packer,
which reproduces the paper's first-fit and best-fit numbers on OR4-sized instances).

Amended 2026-11-06 after the pilot (PREREGISTRATION.md §9): the first family (Weibull,
uniform and bimodal at capacity 100) left no headroom over best fit.
"""
from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from typing import Callable, Dict, Iterable, List, Sequence, Tuple

import numpy as np

CAPACITY = 150
FAMILIES = ("small", "medium", "large")  # by item count
SIZE_BANDS = {"small": (120, 240), "medium": (241, 360), "large": (361, 500)}
ITEM_LO = (15, 25)    # per-instance lower end of the item range (OR-Library: 20)
ITEM_HI = (90, 110)   # per-instance upper end (OR-Library: 100)

# Streams a process may not generate. The arm runner sets {"holdout"} so the loop
# cannot see the final holdout even by accident; the measurement script leaves it empty.
FORBIDDEN_STREAMS: set = set()


class ForbiddenStream(RuntimeError):
    pass


@dataclass(frozen=True)
class Instance:
    stream: str
    idx: int
    family: str
    items: np.ndarray  # int16, arrival order
    capacity: int
    lb: int  # L1 lower bound

    @property
    def key(self) -> str:
        return f"{self.stream}:{self.idx}"


def _rng(stream: str, idx: int) -> np.random.Generator:
    digest = hashlib.sha256(f"binpack/{stream}/{idx}".encode()).digest()
    return np.random.default_rng(int.from_bytes(digest[:8], "little"))


def make_instance(stream: str, idx: int) -> Instance:
    if stream in FORBIDDEN_STREAMS:
        raise ForbiddenStream(f"stream {stream!r} is forbidden in this process")
    rng = _rng(stream, idx)
    family = FAMILIES[int(rng.integers(len(FAMILIES)))]
    n_lo, n_hi = SIZE_BANDS[family]
    n = int(rng.integers(n_lo, n_hi + 1))
    lo = int(rng.integers(ITEM_LO[0], ITEM_LO[1] + 1))
    hi = int(rng.integers(ITEM_HI[0], ITEM_HI[1] + 1))
    items = rng.integers(lo, hi + 1, n).astype(np.int16)
    lb = int(math.ceil(int(items.sum()) / CAPACITY))
    return Instance(stream, idx, family, items, CAPACITY, lb)


def make_instances(stream: str, indices: Iterable[int]) -> List[Instance]:
    return [make_instance(stream, i) for i in indices]


from .binpack_core import BadPriority, pack  # noqa: E402,F401


def verify_assignment(inst: Instance, assign: np.ndarray) -> int:
    """Check an assignment is a feasible online packing; return bins used.

    Run in the trusted parent on whatever the sandboxed child returned, so a candidate
    cannot report a score it did not earn.
    """
    a = np.asarray(assign)
    if a.shape != inst.items.shape or a.dtype.kind not in "iu":
        raise ValueError("assignment has the wrong shape or dtype")
    if a.size == 0:
        return 0
    if a.min() < 0:
        raise ValueError("negative bin index")
    # Online: item i can only open bin (max bin so far + 1).
    running_max = np.maximum.accumulate(a)
    prev_max = np.concatenate(([-1], running_max[:-1]))
    if np.any(a > prev_max + 1):
        raise ValueError("assignment opens bins out of order")
    loads = np.bincount(a, weights=inst.items.astype(float))
    if np.any(loads > inst.capacity + 1e-9):
        raise ValueError("a bin is over capacity")
    return int(a.max()) + 1


def best_fit_priority(item: float, bins: np.ndarray) -> np.ndarray:
    return -(bins - item)


_BF_CACHE: Dict[str, int] = {}


def best_fit_bins(inst: Instance) -> int:
    k = inst.key
    if k not in _BF_CACHE:
        _BF_CACHE[k] = pack(inst.items, inst.capacity, best_fit_priority)[1]
    return _BF_CACHE[k]


def instance_score(inst: Instance, bins: int) -> float:
    """Bins saved against best fit, in percent of the L1 bound. Higher is better."""
    return 100.0 * (best_fit_bins(inst) - bins) / inst.lb


def summarize(instances: Sequence[Instance], bins: Sequence[int]) -> Dict[str, float]:
    """Metrics dict as the loop sees it: combined_score plus one score per family."""
    scores = np.array([instance_score(i, b) for i, b in zip(instances, bins)])
    out = {"combined_score": float(scores.mean()) if len(scores) else 0.0}
    for fam in FAMILIES:
        m = [s for s, inst in zip(scores, instances) if inst.family == fam]
        if m:
            out[f"{fam}_score"] = float(np.mean(m))
    return out


SEED_PROGRAM = '''import numpy as np


def priority(item: float, bins: np.ndarray) -> np.ndarray:
    """Return a priority for placing `item` in each candidate bin.

    `item` is the size of the arriving item (an integer, roughly 15 to 110).
    `bins` holds the remaining capacity of every bin that can still fit the item.
    Bin capacity is 150; the last entry is always an empty bin (remaining == 150),
    so choosing it opens a new bin. The item goes to the bin with the highest
    priority. Return an array with the same shape as `bins`.
    """
    # Best fit: prefer the bin that would be left with the least free space.
    return -(bins - item)
'''
