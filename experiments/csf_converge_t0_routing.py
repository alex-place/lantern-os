#!/usr/bin/env python3
"""C1 — T0 predictive transform routing: predict the transform, don't brute-force it (#2837).

CSF-Omni's ratio comes from a best-fit panel: it runs every (transform, codec) candidate and
keeps the smallest. The transforms (delta, shuffle{2,4,8}, shufdelta, col) are cheap; the codecs
(lzma-9, brotli-11, bz2, zstd-19) are the expensive part, and the panel pays them once PER
TRANSFORM. C1's claim: the winning transform is PREDICTABLE from cheap features of the bytes, so
you can run the codecs on just the predicted transform(s) and skip the rest — matching the omni
ratio at >=2x encode speed.

This is the falsification, done the honest way: use the real panel as the ORACLE (never modifying
the encode/decode path, so there is zero round-trip risk), predict a small transform shortlist
from entropy probes, and measure (a) the ratio the shortlist actually achieves vs the oracle and
(b) how many expensive codec-runs it skips. Pre-registered C1 gate (from the issue):

    PASS  iff  ratio loss <= 0.5% vs full-panel omni  AND  >= 2x fewer codec-runs (encode-speed proxy)
    KILL  otherwise (ratio drops >0.5% OR no speed win)

Run:  python experiments/csf_converge_t0_routing.py            # curated repo corpus
      python experiments/csf_converge_t0_routing.py <file>...  # your own files
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from csf import omni  # noqa: E402

OUT = os.path.join("experiments", "results", "csf_converge_t0_routing.json")

# The transforms the panel can apply (id → stride). 0 = identity, 1 = delta, 2 = col.
_STRIDE_TRANSFORMS = {3: 2, 4: 4, 5: 8}    # shuffle{2,4,8}
_SHUFDELTA_TRANSFORMS = {6: 2, 7: 4, 8: 8}  # shuffle{2,4,8} then delta — the winner on smooth
                                            # fixed-width numeric arrays (grouped bytes + increments)


def _entropy(b: bytes) -> float:
    """Shannon entropy (bits/byte) of the byte histogram — a cheap, O(n) compressibility proxy:
    a transform that lowers it exposes structure the entropy coder can then exploit."""
    if not b:
        return 0.0
    counts = Counter(b)
    n = len(b)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


def _looks_jsonl(b: bytes) -> bool:
    head = b[:64].lstrip()
    return head[:1] in (b"{", b"[")


def predict_transforms(data: bytes, top_k: int = 2) -> list[int]:
    """Rank transforms by the entropy of the bytes AFTER applying them, ascending, and return the
    top-k. Lower post-transform entropy → more compressible → the codec that follows wins smaller.
    Each probe is one O(n) transform + histogram, far cheaper than running lzma/brotli per branch.
    Deterministic; always includes identity (0) as a floor so a transform can only be *chosen*
    over identity when it genuinely lowers entropy."""
    probes: dict[int, float] = {0: _entropy(data)}
    try:
        probes[1] = _entropy(omni._delta_fwd(data))
    except Exception:
        pass
    for tid, stride in _STRIDE_TRANSFORMS.items():
        try:
            probes[tid] = _entropy(omni._shuffle_fwd(data, stride))
        except Exception:
            pass
    for tid, stride in _SHUFDELTA_TRANSFORMS.items():
        try:
            probes[tid] = _entropy(omni._shufdelta_fwd(data, stride))
        except Exception:
            pass
    if _looks_jsonl(data):
        try:
            probes[2] = _entropy(omni._col_fwd(data))
        except Exception:
            pass  # NotApplicable — col only handles JSONL-shaped input
    ranked = sorted(probes, key=lambda t: (probes[t], t))
    # Always keep identity in the shortlist: transforms help some inputs and hurt others, and the
    # codec on raw bytes is the safety net that keeps routed ratio from ever falling far.
    short = ranked[:top_k]
    if 0 not in short:
        short = short[:-1] + [0]
    # col (2) REORDERS JSONL fields into columns for the codec without lowering byte-entropy, so an
    # entropy probe can't rank it — but it is JSONL-specific and cheap, and often the winner there.
    # Rule, not entropy: on JSONL-shaped input, always carry col in the shortlist.
    if _looks_jsonl(data) and 2 in probes and 2 not in short:
        short = short + [2]
    return short


def _codecs_for(effort: str, portable: bool) -> list[int]:
    """The codec ids the panel would pair with transforms at this effort (dedup, order kept)."""
    seen, out = set(), []
    for _t, c in omni._candidates(effort, portable):
        if c not in seen:
            seen.add(c)
            out.append(c)
    return out


def _best_over(data: bytes, cands: list[tuple[int, int]]) -> tuple[int, int, int]:
    """(size, tid, cid) of the smallest round-tripping candidate in `cands`. Reuses transforms."""
    tcache: dict[int, bytes] = {}
    best = None
    for tid, cid in cands:
        if tid not in tcache:
            try:
                tcache[tid] = omni.TRANSFORMS[tid][1](data)
            except Exception:
                tcache[tid] = None
        src = tcache[tid]
        if src is None:
            continue
        try:
            payload = omni.CODECS[cid][2](src)
        except Exception:
            continue
        if best is None or len(payload) < best[0]:
            best = (len(payload), tid, cid)
    return best


def analyze_data(name: str, data: bytes, effort: str = "exhaustive", portable: bool = False) -> dict | None:
    if not data:
        return None

    full = omni._candidates(effort, portable)

    # ORACLE: the full panel's best (what omni ships).
    t0 = time.perf_counter()
    oracle = _best_over(data, full)
    oracle_t = time.perf_counter() - t0

    # ROUTED: prune the panel to the candidates whose TRANSFORM the predictor chose — a strict
    # SUBSET of the panel, so routed can never beat the oracle and the codec-run reduction is real.
    pred = predict_transforms(data)
    routed_cands = [(t, c) for (t, c) in full if t in pred]
    t1 = time.perf_counter()
    routed = _best_over(data, routed_cands)
    routed_t = time.perf_counter() - t1

    if oracle is None or routed is None:
        return None
    # ratio LOSS = how much bigger routed is than the oracle, as a % of the oracle size.
    ratio_loss_pct = (routed[0] - oracle[0]) / oracle[0] * 100.0
    # codec-runs are the expensive unit (lzma/brotli per candidate); pruning drops the runs whose
    # transform wasn't predicted.
    full_transforms = len({t for t, _ in full})
    speed_factor_codecs = len(full) / max(len(routed_cands), 1)
    return {
        "file": name,
        "bytes": len(data),
        "oracle": {"size": oracle[0], "tid": oracle[1], "cid": oracle[2], "sec": round(oracle_t, 4)},
        "predicted_transforms": pred,
        "hit": oracle[1] in pred,                       # did the shortlist contain the true winner?
        "routed": {"size": routed[0], "tid": routed[1], "cid": routed[2], "sec": round(routed_t, 4)},
        "ratio_loss_pct": round(ratio_loss_pct, 4),
        "candidate_reduction_x": round(speed_factor_codecs, 2),
        "time_speedup_x": round(oracle_t / routed_t, 2) if routed_t > 0 else None,
        "full_transforms": full_transforms,
    }


DEFAULT_FILES = [
    "data/eval/leaderboard.jsonl",                 # JSONL → col territory
    "docs/SIGMA0-COLLAPSE-CERTIFICATE.md",         # English/markdown prose
    "src/csf/csf_pack.py",                         # source code
    "data/convergence/records.jsonl",              # JSONL logs
]


def _synthetic_numeric_corpus():
    """Deterministic numeric arrays — the case T0 routing exists for. Byte-shuffle{4,8} groups the
    same-significance bytes of fixed-width numbers so the entropy coder sees runs; on smooth
    arrays the shuffle transform is the panel winner, so this is where a predictor must earn its
    keep. Built with struct (no numpy dep), fixed content (no RNG — indices only)."""
    import struct
    out = []
    # float64 samples of a smooth curve → shuffle{8} territory
    f64 = b"".join(struct.pack("<d", math.sin(i / 50.0) * 1000 + i * 0.01) for i in range(4000))
    out.append(("synthetic:float64_smooth", f64))
    # int32 slowly-increasing counter → shuffle{4}(+delta) territory
    i32 = b"".join(struct.pack("<i", 100000 + i * 3 + (i % 7)) for i in range(8000))
    out.append(("synthetic:int32_counter", i32))
    # int16 low-amplitude signal → shuffle{2} territory
    i16 = b"".join(struct.pack("<h", int(math.sin(i / 13.0) * 300)) for i in range(12000))
    out.append(("synthetic:int16_signal", i16))
    return out


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    if argv:
        corpus = [(p, open(p, "rb").read()) for p in argv if os.path.exists(p)]
    else:
        corpus = _synthetic_numeric_corpus()
        corpus += [(p, open(p, "rb").read()) for p in DEFAULT_FILES if os.path.exists(p)]
    rows = [r for r in (analyze_data(name, data) for name, data in corpus) if r]
    if not rows:
        print("[t0-route] no readable corpus files")
        return 1

    hits = sum(1 for r in rows if r["hit"])
    mean_loss = sum(r["ratio_loss_pct"] for r in rows) / len(rows)
    worst_loss = max(r["ratio_loss_pct"] for r in rows)
    mean_reduction = sum(r["candidate_reduction_x"] for r in rows) / len(rows)
    mean_speedup = sum(r["time_speedup_x"] for r in rows if r["time_speedup_x"]) / max(
        sum(1 for r in rows if r["time_speedup_x"]), 1)

    # Gate on the WORST file, not the mean: a router that's great on average but loses 3% on one
    # file is not a safe drop-in for a best-fit floor.
    gate_ratio = worst_loss <= 0.5
    gate_speed = mean_reduction >= 2.0
    verdict = "PASS" if (gate_ratio and gate_speed) else "KILL"

    report = {
        "corpus": [r["file"] for r in rows], "n": len(rows),
        "winner_hit_rate": round(hits / len(rows), 3),
        "mean_ratio_loss_pct": round(mean_loss, 4),
        "worst_ratio_loss_pct": round(worst_loss, 4),
        "mean_candidate_reduction_x": round(mean_reduction, 2),
        "mean_time_speedup_x": round(mean_speedup, 2),
        "gate": {"ratio_loss_le_0.5pct(worst)": gate_ratio, "reduction_ge_2x": gate_speed, "VERDICT": verdict},
        "rows": rows,
    }

    print(f"# C1 T0 predictive transform routing — n={len(rows)} files")
    print(f"{'file':44s} {'winner':>7} {'hit':>4} {'lossPct':>8} {'redux':>6} {'spdup':>6}")
    for r in rows:
        print(f"{r['file'][:44]:44s} t{r['oracle']['tid']:<6d} {'Y' if r['hit'] else 'n':>4} "
              f"{r['ratio_loss_pct']:>8.3f} {r['candidate_reduction_x']:>6.2f} "
              f"{(r['time_speedup_x'] or 0):>6.2f}")
    print(f"\nwinner-hit rate {report['winner_hit_rate']} | mean loss {mean_loss:.3f}% | "
          f"worst {worst_loss:.3f}% | reduction {mean_reduction:.2f}x | time {mean_speedup:.2f}x")
    print(f"GATE ratio<=0.5%(worst)={gate_ratio}  reduction>=2x={gate_speed}  ->  {verdict}")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump(report, f, indent=1)
    print("full report ->", OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
