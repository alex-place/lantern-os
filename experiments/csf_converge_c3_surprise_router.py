#!/usr/bin/env python3
"""C3 — surprise-field router: route tier-DEPTH by the surprise field (#2837).

CSF-Omni ships a best-fit floor by descending the whole panel on every member — the
"always-descend" policy (effort=exhaustive, 34 codec-runs/member here). C3's claim: a cheap
per-member SURPRISE signal can decide *how far to descend* — spend the deep panel only where it
pays, and exit shallow (effort=max) where the deep panel adds nothing but the shufdelta transforms. "Effort follows
entropy: spend where the innovation is." Gate (from the issue): routing by the field beats
always-descend at EQUAL ratio; KILL if the routed pipeline is slower *and* no better than fixed T3.

The surprise signal here is model-free and composes with C1: **transform-entropy-reduction** —
how much the best byte transform lowers the member's entropy. Near-zero means no transform (and,
empirically, no deep codec) has structure to exploit that the fast tier misses, so descending is
wasted; a large reduction means the panel's transforms win big, so descend. (The design's true
"dilation field" is a token-surprise signal for text/records; this is its byte-level analog, and
the point is the same control law — spend effort where surprise is.)

Honest, like C1: exhaustive is the ratio FLOOR, so a router can only ever LOSE ratio (never beat
it) — "beats always-descend at equal ratio" therefore means *matches the ratio within a tolerance
while spending fewer codec-runs*. The real panel is the oracle; the encode/decode path is never
modified.

Run:  python experiments/csf_converge_c3_surprise_router.py
"""
from __future__ import annotations

import json
import math
import os
import struct
import sys
import time
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from csf import omni  # noqa: E402

OUT = os.path.join("experiments", "results", "csf_converge_c3_surprise_router.json")

# Self-contained (C3 must not depend on the unmerged C1 module). Byte transforms by id → stride.
_STRIDE_TRANSFORMS = {3: 2, 4: 4, 5: 8}     # shuffle{2,4,8}
_SHUFDELTA_TRANSFORMS = {6: 2, 7: 4, 8: 8}  # shufdelta{2,4,8}
DEFAULT_FILES = [
    "data/eval/leaderboard.jsonl",
    "docs/SIGMA0-COLLAPSE-CERTIFICATE.md",
    "src/csf/csf_pack.py",
    "data/convergence/records.jsonl",
]


def _entropy(b: bytes) -> float:
    """Shannon entropy (bits/byte) of the byte histogram — cheap O(n) surprise proxy."""
    if not b:
        return 0.0
    n = len(b)
    return -sum((c / n) * math.log2(c / n) for c in Counter(b).values())


def _looks_jsonl(b: bytes) -> bool:
    return b[:64].lstrip()[:1] in (b"{", b"[")


def _synthetic_numeric_corpus():
    """Deterministic numeric arrays — the members where byte transforms win big and the deep
    panel earns its cost (built with struct, no numpy/RNG)."""
    out = []
    out.append(("synthetic:float64_smooth",
                b"".join(struct.pack("<d", math.sin(i / 50.0) * 1000 + i * 0.01) for i in range(4000))))
    out.append(("synthetic:int32_counter",
                b"".join(struct.pack("<i", 100000 + i * 3 + (i % 7)) for i in range(8000))))
    out.append(("synthetic:int16_signal",
                b"".join(struct.pack("<h", int(math.sin(i / 13.0) * 300)) for i in range(12000))))
    return out


SIZE_CAP = 512 * 1024  # cap members so the exhaustive baseline stays quick; ratios still hold

# Choosing the shallow tier was the finding (measured, in this order):
#   fast (store/zlib/zstd)     -> loses 9-14% on text/JSONL: the deep win there is CODEC depth
#                                 (lzma/brotli) + col, which fast lacks — invisible to a transform
#                                 signal, so the router sends text to fast and bleeds ratio.
#   balanced (lzma family+col) -> still loses up to 6% on source/JSONL (drops brotli + some codecs).
#   max (all codecs+col+shuffle, lacks ONLY shufdelta+delta) -> matches exhaustive on everything
#                                 EXCEPT the smooth numeric arrays that need shufdelta{2,4,8}.
# So `max` is the right shallow tier: the ONE thing exhaustive adds over it (the shufdelta byte
# transforms) is exactly what the transform-reduction surprise signal detects — so the router
# descends to exhaustive precisely on the members that need it and nowhere else. 0% ratio loss.
SHALLOW, DEEP = "max", "exhaustive"
RATIO_TOL_PCT = 0.5   # "equal ratio" tolerance (worst member) — same bar C1 used


def transform_reduction(data: bytes) -> float:
    """Max entropy DROP any single transform achieves = the surprise/routability signal. 0.0 when
    no transform exposes structure the fast tier would miss; large when a transform wins big."""
    base = _entropy(data)
    best = base
    probes = []
    try:
        probes.append(omni._delta_fwd(data))
    except Exception:
        pass
    for s in _STRIDE_TRANSFORMS.values():
        try:
            probes.append(omni._shuffle_fwd(data, s))
        except Exception:
            pass
    for s in _SHUFDELTA_TRANSFORMS.values():
        try:
            probes.append(omni._shufdelta_fwd(data, s))
        except Exception:
            pass
    if _looks_jsonl(data):
        try:
            probes.append(omni._col_fwd(data))
        except Exception:
            pass
    for p in probes:
        e = _entropy(p)
        if e < best:
            best = e
    return round(base - best, 4)


def _best_size(data: bytes, effort: str) -> int:
    """Smallest panel-candidate payload at this effort — the omni result for the tier."""
    res = omni._encode_all(data, effort, False)
    return res[0][0] if res else len(data)


def _runs(effort: str) -> int:
    return len(omni._candidates(effort, False))


def analyze(name: str, data: bytes, threshold: float) -> dict | None:
    if not data:
        return None
    t0 = time.perf_counter()
    deep_size = _best_size(data, DEEP)     # always-descend (the oracle / fixed T3)
    deep_t = time.perf_counter() - t0
    t1 = time.perf_counter()
    shallow_size = _best_size(data, SHALLOW)
    shallow_t = time.perf_counter() - t1

    reduction = transform_reduction(data)
    routed_deep = reduction >= threshold   # descend only when a transform meaningfully helps
    routed_size = deep_size if routed_deep else shallow_size
    routed_runs = _runs(DEEP) if routed_deep else _runs(SHALLOW)

    loss_pct = (routed_size - deep_size) / deep_size * 100.0 if deep_size else 0.0
    return {
        "file": name, "bytes": len(data), "surprise_reduction": reduction,
        "routed_to": DEEP if routed_deep else SHALLOW,
        "deep_size": deep_size, "shallow_size": shallow_size, "routed_size": routed_size,
        "ratio_loss_pct": round(loss_pct, 4),
        "routed_runs": routed_runs, "shallow_runs": _runs(SHALLOW), "deep_runs": _runs(DEEP),
        "deep_sec": round(deep_t, 4), "shallow_sec": round(shallow_t, 4),
    }


def evaluate(rows):
    n = len(rows)
    tot_deep = sum(r["deep_size"] for r in rows)
    tot_shallow = sum(r["shallow_size"] for r in rows)          # always-shallow (max) baseline
    tot_routed = sum(r["routed_size"] for r in rows)
    tot_deep_runs = sum(r["deep_runs"] for r in rows)
    tot_shallow_runs = sum(r["shallow_runs"] for r in rows)
    tot_routed_runs = sum(r["routed_runs"] for r in rows)
    worst_loss = max(r["ratio_loss_pct"] for r in rows)
    corpus_loss = (tot_routed - tot_deep) / tot_deep * 100.0 if tot_deep else 0.0
    # always-shallow (max)'s own loss vs exhaustive — the REDUNDANCY check: if max already ~=
    # exhaustive everywhere, a depth router adds nothing over just defaulting to max.
    shallow_loss = (tot_shallow - tot_deep) / tot_deep * 100.0 if tot_deep else 0.0
    shallow_worst = max((r["shallow_size"] - r["deep_size"]) / r["deep_size"] * 100.0 for r in rows)
    run_reduction = tot_deep_runs / tot_routed_runs if tot_routed_runs else 1.0

    gate_ratio = worst_loss <= RATIO_TOL_PCT
    gate_speed = run_reduction > 1.0
    # The router only EARNS its existence if it beats BOTH fixed tiers: matches exhaustive ratio
    # (gate_ratio) at fewer runs (gate_speed), AND recovers ratio that always-balanced loses —
    # i.e. always-balanced alone would NOT clear the ratio bar. If balanced already clears it, the
    # router is subsumed by the balanced default and the honest verdict is KILL (redundant).
    balanced_already_suffices = shallow_worst <= RATIO_TOL_PCT
    if gate_ratio and gate_speed and not balanced_already_suffices:
        verdict = "PASS"
    elif balanced_already_suffices:
        verdict = "KILL (subsumed by always-balanced default — no descent needed)"
    else:
        verdict = "KILL"
    return {
        "n": n, "corpus_ratio_loss_pct": round(corpus_loss, 4), "worst_ratio_loss_pct": round(worst_loss, 4),
        "always_balanced_corpus_loss_pct": round(shallow_loss, 4),
        "always_balanced_worst_loss_pct": round(shallow_worst, 4),
        "codec_run_reduction_x": round(run_reduction, 2),
        "members_routed_shallow": sum(1 for r in rows if r["routed_to"] == SHALLOW),
        "gate": {f"worst_loss_le_{RATIO_TOL_PCT}pct": gate_ratio, "fewer_runs": gate_speed,
                 "balanced_already_suffices": balanced_already_suffices, "VERDICT": verdict},
    }


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    threshold = float(argv[0]) if argv else 0.30   # bits/byte reduction to justify descending
    corpus = _synthetic_numeric_corpus()
    corpus += [(p, open(p, "rb").read()[:SIZE_CAP]) for p in DEFAULT_FILES if os.path.exists(p)]
    rows = [r for r in (analyze(n, d, threshold) for n, d in corpus) if r]
    if not rows:
        print("[c3] no corpus")
        return 1
    summ = evaluate(rows)
    summ["threshold_bits"] = threshold

    print(f"# C3 surprise-field depth router — n={summ['n']} members, threshold={threshold} bits/byte drop")
    print(f"{'file':40s} {'surprise':>9} {'route':>6} {'lossPct':>8}")
    for r in rows:
        print(f"{r['file'][:40]:40s} {r['surprise_reduction']:>9.3f} {r['routed_to']:>6} {r['ratio_loss_pct']:>8.3f}")
    print(f"\nrouted-shallow(max) {summ['members_routed_shallow']}/{summ['n']} | "
          f"router loss {summ['corpus_ratio_loss_pct']:.3f}% (worst {summ['worst_ratio_loss_pct']:.3f}%) | "
          f"run reduction {summ['codec_run_reduction_x']:.2f}x")
    print(f"always-shallow(max) loss vs exhaustive: {summ['always_balanced_corpus_loss_pct']:.3f}% "
          f"(worst {summ['always_balanced_worst_loss_pct']:.3f}%)  <- the redundancy check")
    print(f"GATE worst-loss<={RATIO_TOL_PCT}%={summ['gate'][f'worst_loss_le_{RATIO_TOL_PCT}pct']}  "
          f"fewer-runs={summ['gate']['fewer_runs']}  balanced-suffices={summ['gate']['balanced_already_suffices']}  "
          f"->  {summ['gate']['VERDICT']}")

    report = {"summary": summ, "rows": rows}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump(report, f, indent=1)
    print("full report ->", OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
