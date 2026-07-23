"""Cross-domain transform probe v2 — fast, threaded, INCREMENTAL (prints per file).

Baseline = the per-file omni-max winner already measured in omni_panel_probe.json
(NOT recomputed). Per file we test domain-specific reversible pre-passes and print a
result line immediately, so progress is visible:

  * BCJ branch filters (executable-compression domain): LZMA FILTER_X86 / ARM before
    LZMA2 — for binaries/executables (Silesia mozilla, AITDCC H=ELF).
  * Byte-shuffle / SoA planes (scientific-array domain, HDF5/Blosc): split fixed-width
    records (stride 2/4/8) into byte planes, then zstd/lzma — for numeric arrays
    (Silesia sao=floats, x-ray; AITDCC G=2-byte records, F).
  * Stride-predictor residual (the lossless cousin of "RNN into wavelengths"): subtract
    the value `stride` bytes back, then code the residual — for smooth numeric streams.

lzma candidates use preset 9 (plain) for sweep speed; a transform that beats the 9e
baseline even at preset 9 is a strong, honest win. Every candidate round-trips or is
dropped. Pure-prose files (no transform can help) are skipped.

Run:  python experiments/omni_crossdomain_probe.py --silesia <dir> --aitdcc <dir>
"""

from __future__ import annotations

import argparse
import json
import lzma
import os
import sys
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, "src")
import numpy as np  # noqa: E402
import zstandard as zstd  # noqa: E402

OUT = os.path.join("experiments", "results", "omni_crossdomain_probe.json")
BASELINE_JSON = os.path.join("experiments", "results", "omni_panel_probe.json")
BCJ = {"x86": lzma.FILTER_X86, "arm": lzma.FILTER_ARM}
SKIP_PROSE = {"silesia/dickens", "silesia/reymont", "silesia/webster",
              "aitdcc/A", "aitdcc/B", "silesia/xml"}   # text/dictionary wins, not transform


def _zc(level=19):
    return zstd.ZstdCompressor(level=level)


def lzma_bcj(data, fid):
    f = [{"id": fid}, {"id": lzma.FILTER_LZMA2, "preset": 9}]
    c = lzma.compress(data, format=lzma.FORMAT_RAW, filters=f)
    if lzma.decompress(c, format=lzma.FORMAT_RAW, filters=f) != data:
        raise ValueError("bcj rt")
    return len(c)


def shuffle(data, s):
    n = len(data); full = n - (n % s); per = full // s
    return b"".join(data[p:full:s] for p in range(s)) + data[full:], (s, n)


def unshuffle(buf, meta):
    s, n = meta; full = n - (n % s); per = full // s
    out = bytearray(full)
    for p in range(s):
        out[p:full:s] = buf[p * per:(p + 1) * per]
    return bytes(out) + buf[full:]


def shuf(data, s, codec):
    sh, meta = shuffle(data, s)
    if codec == "zstd":
        c = _zc().compress(sh); d = lambda b: zstd.ZstdDecompressor().decompress(b)
    else:
        c = lzma.compress(sh, preset=9); d = lzma.decompress
    if unshuffle(d(c), meta) != data:
        raise ValueError("shuf rt")
    return len(c)


def stride_delta(data, s):
    a = np.frombuffer(data, dtype=np.uint8)
    out = a.copy()
    out[s:] = a[s:] - a[:-s]          # uint8 wraps mod 256
    return out.tobytes()


def stride_delta_inv(buf, s):
    a = np.frombuffer(buf, dtype=np.uint8)
    out = np.empty_like(a)
    for p in range(s):
        out[p::s] = np.cumsum(a[p::s], dtype=np.uint8)   # uint8 cumsum wraps mod 256
    return out.tobytes()


def pred(data, s):
    r = stride_delta(data, s)
    c = lzma.compress(r, preset=9)
    if stride_delta_inv(lzma.decompress(c), s) != data:
        raise ValueError("pred rt")
    return len(c)


def load_silesia(d):
    out = {}
    for zp in sorted(os.listdir(d)):
        if zp.endswith(".zip"):
            with zipfile.ZipFile(os.path.join(d, zp)) as z:
                for n in z.namelist():
                    out["silesia/" + n] = z.read(n)
    return out


def load_dir(d, pfx):
    return {pfx + "/" + n: open(os.path.join(d, n), "rb").read()
            for n in sorted(os.listdir(d)) if os.path.isfile(os.path.join(d, n))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--silesia", required=True)
    ap.add_argument("--aitdcc", required=True)
    args = ap.parse_args()
    files = load_silesia(args.silesia)
    files.update(load_dir(args.aitdcc, "aitdcc"))

    base_j = json.load(open(BASELINE_JSON))["files"]
    baseline = {f: (d["full_winner"]["bytes"], d["full_winner"]["cand"])
                for f, d in base_j.items()}

    CANDS = ({f"bcj-{k}+lzma9": (lambda data, fid=v: lzma_bcj(data, fid)) for k, v in BCJ.items()}
             | {f"shuf{s}+{c}": (lambda data, s=s, c=c: shuf(data, s, c))
                for s in (2, 4, 8) for c in ("zstd", "lzma")}
             | {f"pred{s}+lzma": (lambda data, s=s: pred(data, s)) for s in (1, 2, 4)})

    rows = {}
    for fname, data in files.items():
        if fname in SKIP_PROSE or fname not in baseline:
            continue
        base, base_m = baseline[fname]
        if base_m == "store":     # incompressible (random) — nothing to gain
            print(f"{fname:20s} raw={len(data):>10,} base={base_m}  [skip: incompressible]", flush=True)
            continue
        t0 = time.perf_counter()
        with ThreadPoolExecutor(max_workers=6) as ex:
            def run(item):
                name, fn = item
                try:
                    return name, fn(data)
                except Exception:
                    return name, None
            res = dict(ex.map(run, CANDS.items()))
        res = {k: v for k, v in res.items() if v is not None}
        best = min(res.items(), key=lambda kv: kv[1]) if res else (None, None)
        win = best[1] is not None and best[1] < base
        rows[fname] = {"raw": len(data), "current_best": base, "current_method": base_m,
                       "best_xd": best[0], "best_xd_bytes": best[1],
                       "improves": win, "gain_pct": round((base / best[1] - 1) * 100, 2) if win else 0.0,
                       "all": dict(sorted(res.items(), key=lambda kv: kv[1])[:3])}
        tag = f"WIN +{rows[fname]['gain_pct']}% via {best[0]}" if win else f"no-win (best {best[0]} {best[1]:,})"
        print(f"{fname:20s} raw={len(data):>10,} base={base:>10,}({base_m})  {tag}  [{time.perf_counter()-t0:.0f}s]", flush=True)

    wins = {f: r for f, r in rows.items() if r["improves"]}
    tb = sum(r["current_best"] for r in rows.values())
    tn = sum(min(r["current_best"], r["best_xd_bytes"] or r["current_best"]) for r in rows.values())
    report = {"files_tested": len(rows), "files_improved": len(wins),
              "tested_total_current": tb, "tested_total_with_xd": tn,
              "tested_gain_pct": round((tb / tn - 1) * 100, 3) if tn else 0,
              "winners": {f: {"method": r["best_xd"], "gain_pct": r["gain_pct"], "vs": r["current_method"]}
                          for f, r in wins.items()},
              "per_file": rows}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(report, open(OUT, "w"), indent=2)
    print("\n=== SUMMARY ===", flush=True)
    print(json.dumps({k: report[k] for k in ("files_tested", "files_improved", "tested_gain_pct", "winners")}, indent=2))


if __name__ == "__main__":
    main()
