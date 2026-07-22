"""Research-grounded numeric transforms vs the byte-shuffle we just shipped.

Borrows two documented lossless techniques and tests whether they beat the CURRENT
omni-max best (which already includes byte-shuffle) on the numeric/binary files:

  * BITSHUFFLE (Masui et al. 2015, arXiv:1503.00638 — CHIME radio-telescope data):
    transpose the BIT matrix (elements x bits) so every bit-plane is contiguous.
    The bit-level generalization of HDF5/Blosc byte-shuffle; the paper reports a
    strictly higher ratio than byte-shuffle on typed arrays. itemsize in {2,4,8}.
  * SPDP-lite (Claggett/Burtscher — SPDP, an auto-synthesized FP compressor):
    byte-regroup (shuffle) then a byte-granularity subtraction (delta) before LZ.
    Tested here as shuffle(stride) -> delta -> lzma.

Baseline = current omni.compress_best(effort="max"). A transform ships only if it
strictly beats that. Every candidate round-trips or is dropped.

Run:  python experiments/omni_bitshuffle_probe.py --silesia <dir> --aitdcc <dir>
"""

from __future__ import annotations

import argparse
import json
import lzma
import os
import sys
import time
import zipfile

import numpy as np

sys.path.insert(0, "src")
import zstandard as zstd  # noqa: E402

from csf import omni  # noqa: E402

OUT = os.path.join("experiments", "results", "omni_bitshuffle_probe.json")
# numeric/binary files only (byte-shuffle already helps some; text/hash never will)
TARGETS = {"silesia/sao", "silesia/x-ray", "silesia/mr", "silesia/osdb",
           "aitdcc/E", "aitdcc/F", "aitdcc/G", "aitdcc/H"}


def bitshuffle(data: bytes, itemsize: int) -> bytes:
    n = len(data); full = n - (n % itemsize); nelem = full // itemsize
    arr = np.frombuffer(data[:full], dtype=np.uint8).reshape(nelem, itemsize)
    bits = np.unpackbits(arr, axis=1)          # (nelem, itemsize*8)
    packed = np.packbits(bits.T.copy())        # transpose -> planes contiguous
    return packed.tobytes() + data[full:]


def bitunshuffle(buf: bytes, itemsize: int, n: int) -> bytes:
    full = n - (n % itemsize); nelem = full // itemsize
    body = np.frombuffer(buf[:full], dtype=np.uint8)
    bits = np.unpackbits(body).reshape(itemsize * 8, nelem)
    arr = np.packbits(bits.T.copy(), axis=1)   # (nelem, itemsize)
    return arr.tobytes() + buf[full:]


def byteshuffle(data, s):
    n = len(data); full = n - (n % s)
    return b"".join(data[p:full:s] for p in range(s)) + data[full:]


def byteunshuffle(buf, s):
    n = len(buf); full = n - (n % s); per = full // s
    out = bytearray(full)
    for p in range(s):
        out[p:full:s] = buf[p * per:(p + 1) * per]
    return bytes(out) + buf[full:]


def delta(data):
    a = np.frombuffer(data, dtype=np.uint8); o = a.copy(); o[1:] = a[1:] - a[:-1]
    return o.tobytes()


def undelta(buf):
    return np.cumsum(np.frombuffer(buf, dtype=np.uint8), dtype=np.uint8).tobytes()


def enc_zstd(b): return zstd.ZstdCompressor(level=19).compress(b)
def dec_zstd(b): return zstd.ZstdDecompressor().decompress(b)
def enc_lzma(b): return lzma.compress(b, preset=9)


def cand_bitshuffle(data, itemsize, codec):
    n = len(data)
    bs = bitshuffle(data, itemsize)
    if codec == "zstd":
        c = enc_zstd(bs); assert bitunshuffle(dec_zstd(c), itemsize, n) == data
    else:
        c = enc_lzma(bs); assert bitunshuffle(lzma.decompress(c), itemsize, n) == data
    return len(c)


def cand_spdp(data, s):
    n = len(data)
    t = delta(byteshuffle(data, s))
    c = enc_lzma(t)
    assert byteunshuffle(undelta(lzma.decompress(c)), s) == data
    return len(c)


def load_silesia(d):
    out = {}
    for zp in sorted(os.listdir(d)):
        if zp.endswith(".zip"):
            with zipfile.ZipFile(os.path.join(d, zp)) as z:
                for nm in z.namelist():
                    out["silesia/" + nm] = z.read(nm)
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

    rows = {}
    for fname in sorted(TARGETS):
        if fname not in files:
            continue
        data = files[fname]
        base = len(omni.compress_best(data, effort="max"))   # current best (incl byte-shuffle)
        cands = {}
        for isz in (2, 4, 8):
            for cn in ("zstd", "lzma"):
                try:
                    cands[f"bitshuf{isz}+{cn}"] = cand_bitshuffle(data, isz, cn)
                except Exception:
                    pass
        for s in (2, 4, 8):
            try:
                cands[f"spdp{s}"] = cand_spdp(data, s)
            except Exception:
                pass
        best = min(cands.items(), key=lambda kv: kv[1]) if cands else (None, None)
        win = best[1] is not None and best[1] < base
        rows[fname] = {"raw": len(data), "omni_max_now": base,
                       "best_research": best[0], "best_bytes": best[1],
                       "improves": win,
                       "gain_pct": round((base / best[1] - 1) * 100, 2) if win else 0.0,
                       "top3": dict(sorted(cands.items(), key=lambda kv: kv[1])[:3])}
        tag = f"WIN +{rows[fname]['gain_pct']}% via {best[0]}" if win else f"no-win (best {best[0]} {best[1]:,} vs {base:,})"
        print(f"{fname:16s} raw={len(data):>9,} omni_max={base:>9,}  {tag}", flush=True)

    wins = {f: r for f, r in rows.items() if r["improves"]}
    report = {"tested": len(rows), "improved": len(wins),
              "winners": {f: {"method": r["best_research"], "gain_pct": r["gain_pct"]} for f, r in wins.items()},
              "per_file": rows}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(report, open(OUT, "w"), indent=2)
    print("\n=== SUMMARY ===", json.dumps(report["winners"], indent=2))


if __name__ == "__main__":
    main()
