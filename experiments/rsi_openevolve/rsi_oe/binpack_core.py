"""The online packer, kept dependency-free so the sandboxed child can import it alone."""
import numpy as np


class BadPriority(ValueError):
    pass


def pack(items, capacity, priority):
    """Online packing. Each item goes to the valid bin with the highest priority.

    The heuristic sees the remaining capacity of every open bin that fits the item,
    plus one empty bin (remaining == capacity) at the end. Ties go to the earliest bin.
    Returns (assignment, n_bins).
    """
    n = len(items)
    remaining = np.empty(n + 1, dtype=float)
    nbins = 0
    assign = np.empty(n, dtype=np.int32)
    for i in range(n):
        item = float(items[i])
        remaining[nbins] = capacity
        caps = remaining[: nbins + 1]
        valid = np.flatnonzero(caps >= item)
        cand = caps[valid].copy()
        pr = np.asarray(priority(item, cand), dtype=float)
        if pr.shape != cand.shape:
            raise BadPriority(f"priority returned shape {pr.shape}, expected {cand.shape}")
        if not np.all(np.isfinite(pr)):
            raise BadPriority("priority returned a non-finite value")
        j = int(valid[int(np.argmax(pr))])
        remaining[j] -= item
        if j == nbins:
            nbins += 1
        assign[i] = j
    return assign, nbins
