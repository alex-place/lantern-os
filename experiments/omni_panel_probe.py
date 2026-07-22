"""Omni panel probe — evidence for the speed fix and the single new codec.

Per file (Silesia + AITDCC public), measures SIZE + TIME for:
  * every current max-tier candidate, individually (store..brotli-tx, col x {zstd,brotli,lzma});
  * NEW-codec candidates: stdlib LZMA FORMAT_RAW with FILTER_DELTA dist in {2,3,4,8}
    (multi-byte record delta — the gap the current byte-delta transform can't cover),
    plain lzma-9 (non-extreme, the speed alternative), zstd-22-ultra+long,
    brotli-q10 (speed alternative), zopfli (only files < 4 MB — expected dominated).

Outputs (JSON): per-file candidate table; current-max winner vs new winners;
bytes lost if each candidate were dropped (never-winner analysis); a proposed
minimal "balanced" panel = smallest candidate set within 0.25% of the full-panel
optimum on BOTH corpora, with its estimated wall time vs the full panel.

No probing/sampling is used anywhere — every measurement is a full encode
(the prefix-probe door stays closed).

Run:  python experiments/omni_panel_probe.py --silesia <dir> --aitdcc <dir>
"""

from __future__ import annotations

import argparse
import bz2
import json
import lzma
import os
import sys
import time
import zipfile
import zlib
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, "src")
import brotli  # noqa: E402
import zstandard as zstd  # noqa: E402

try:
    import zopfli.zlib as zopfli_zlib
except Exception:
    zopfli_zlib = None

from csf import col_transform  # noqa: E402

OUT = os.path.join("experiments", "results", "omni_panel_probe.json")
_PB0 = [{"id": lzma.FILTER_LZMA2, "preset": 9 | lzma.PRESET_EXTREME, "pb": 0}]


def _lzma_delta(dist):
    filt = [{"id": lzma.FILTER_DELTA, "dist": dist},
            {"id": lzma.FILTER_LZMA2, "preset": 9}]
    return lambda b: lzma.compress(b, format=lzma.FORMAT_RAW, filters=filt)


def _zstd(level, long_mode=False):
    def c(b):
        if long_mode:
            p = zstd.ZstdCompressionParameters.from_level(level, enable_ldm=True)
            return zstd.ZstdCompressor(compression_params=p).compress(b)
        return zstd.ZstdCompressor(level=level).compress(b)
    return c


def _col_then(codec):
    def c(b):
        return codec(col_transform.forward(b))   # NotApplicable -> caller skips
    return c


CANDS: dict[str, tuple] = {
    # current max panel (individually)
    "store": (lambda b: b,),
    "zlib-9": (lambda b: zlib.compress(b, 9),),
    "bz2-9": (lambda b: bz2.compress(b, 9),),
    "lzma-9e": (lambda b: lzma.compress(b, preset=9 | lzma.PRESET_EXTREME),),
    "lzma-pb0": (lambda b: lzma.compress(b, format=lzma.FORMAT_RAW, filters=_PB0),),
    "zstd-19": (_zstd(19),),
    "brotli-11": (lambda b: brotli.compress(b, quality=11),),
    "brotli-11-tx": (lambda b: brotli.compress(b, quality=11, lgwin=24, mode=brotli.MODE_TEXT),),
    "col+zstd-19": (_col_then(_zstd(19)),),
    "col+brotli-11": (_col_then(lambda b: brotli.compress(b, quality=11)),),
    "col+lzma-9e": (_col_then(lambda b: lzma.compress(b, preset=9 | lzma.PRESET_EXTREME)),),
    # new-codec candidates
    "lzma-delta-d2": (_lzma_delta(2),),
    "lzma-delta-d3": (_lzma_delta(3),),
    "lzma-delta-d4": (_lzma_delta(4),),
    "lzma-delta-d8": (_lzma_delta(8),),
    "lzma-9 (plain)": (lambda b: lzma.compress(b, preset=9),),
    "zstd-22-ultra-long": (_zstd(22, long_mode=True),),
    "brotli-q10": (lambda b: brotli.compress(b, quality=10),),
}
if zopfli_zlib is not None:
    CANDS["zopfli (<4MB)"] = (lambda b: zopfli_zlib.compress(b) if len(b) < 4 << 20 else None,)

CURRENT_MAX = ["store", "zlib-9", "bz2-9", "lzma-9e", "lzma-pb0", "zstd-19",
               "brotli-11", "brotli-11-tx", "col+zstd-19", "col+brotli-11", "col+lzma-9e"]


def load_silesia(d):
    out = {}
    for zp in sorted(os.listdir(d)):
        if zp.endswith(".zip"):
            with zipfile.ZipFile(os.path.join(d, zp)) as z:
                for n in z.namelist():
                    out["silesia/" + n] = z.read(n)
    return out


def load_dir(d, prefix):
    out = {}
    for root, _dirs, names in os.walk(d):
        for n in sorted(names):
            p = os.path.join(root, n)
            if os.path.getsize(p):
                out[prefix + "/" + n] = open(p, "rb").read()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--silesia", required=True)
    ap.add_argument("--aitdcc", required=True)
    args = ap.parse_args()

    files = load_silesia(args.silesia)
    files.update(load_dir(args.aitdcc, "aitdcc"))

    jobs = [(fname, cname) for fname in files for cname in CANDS]

    def run(job):
        fname, cname = job
        fn = CANDS[cname][0]
        blob = files[fname]
        t0 = time.perf_counter()
        try:
            out = fn(blob)
        except Exception:
            out = None
        dt = time.perf_counter() - t0
        return fname, cname, (len(out) if out is not None else None), round(dt, 3)

    with ThreadPoolExecutor(max_workers=6) as ex:
        rows = list(ex.map(run, jobs))

    table: dict[str, dict] = {f: {} for f in files}
    for fname, cname, sz, dt in rows:
        table[fname][cname] = {"bytes": sz, "s": dt}

    # analysis
    report_files = {}
    drop_loss = {c: 0 for c in CANDS}
    new_wins = []
    for fname, cand in table.items():
        valid = {c: v for c, v in cand.items() if v["bytes"] is not None}
        cur = min((v["bytes"], c) for c, v in valid.items() if c in CURRENT_MAX)
        full = min((v["bytes"], c) for c, v in valid.items())
        report_files[fname] = {
            "raw": len(files[fname]),
            "current_max_winner": {"cand": cur[1], "bytes": cur[0]},
            "full_winner": {"cand": full[1], "bytes": full[0],
                            "gain_vs_current_pct": round((cur[0] / full[0] - 1) * 100, 2)},
            "times_s": {c: v["s"] for c, v in valid.items()},
            "sizes": {c: v["bytes"] for c, v in valid.items()},
        }
        if full[1] not in CURRENT_MAX and full[0] < cur[0]:
            new_wins.append((fname, full[1], cur[0], full[0]))
        for c in CANDS:
            others = [v["bytes"] for cc, v in valid.items() if cc != c]
            if others and valid.get(c, {}).get("bytes") is not None:
                drop_loss[c] += max(0, min(others) - full[0]) if full[1] == c else 0

    # minimal balanced panel: greedy set cover within 0.25% of full optimum
    target = {f: report_files[f]["full_winner"]["bytes"] for f in files}
    chosen: list[str] = ["store"]
    def total_with(panel):
        s = 0
        for f in files:
            sizes = [table[f][c]["bytes"] for c in panel
                     if c in table[f] and table[f][c]["bytes"] is not None]
            s += min(sizes) if sizes else len(files[f])
        return s
    full_total = sum(target.values())
    while True:
        cur_total = total_with(chosen)
        if cur_total <= full_total * 1.0025:
            break
        best = None
        for c in CANDS:
            if c in chosen:
                continue
            t = total_with(chosen + [c])
            if best is None or t < best[0]:
                best = (t, c)
        if best is None:
            break
        chosen.append(best[1])
    est_wall = {c: sum(table[f][c]["s"] for f in files if table[f].get(c, {}).get("bytes") is not None)
                for c in CANDS}
    report = {
        "n_files": len(files),
        "full_total_bytes": full_total,
        "current_max_total_bytes": sum(r["current_max_winner"]["bytes"] for r in report_files.values()),
        "new_codec_wins": [{"file": f, "cand": c, "current": a, "new": b,
                            "gain_pct": round((a / b - 1) * 100, 2)} for f, c, a, b in new_wins],
        "drop_loss_bytes (bytes lost if candidate removed)": drop_loss,
        "balanced_panel_proposal": {"members": chosen,
                                    "total_bytes": total_with(chosen),
                                    "vs_full_pct": round((total_with(chosen) / full_total - 1) * 100, 3),
                                    "est_serial_encode_s": round(sum(est_wall[c] for c in chosen if c in est_wall), 1)},
        "est_serial_encode_s_per_candidate": {c: round(s, 1) for c, s in est_wall.items()},
        "files": report_files,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(report, open(OUT, "w"), indent=2)
    print(json.dumps({k: report[k] for k in ("new_codec_wins", "balanced_panel_proposal")}, indent=2))


if __name__ == "__main__":
    main()
