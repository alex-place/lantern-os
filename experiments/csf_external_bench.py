"""External benchmark — CSF vs competitor codecs on OUTSIDE corpora (real tests).

Corpora (never our own data):
  * Silesia corpus (the industry-standard 12-file benchmark), from the
    MiloszKrajewski/SilesiaCorpus mirror (files stored as per-file .zip).
  * AITDCC-2026 public training set (arXiv:2606.17712) when present — the
    neutral 2026 lossless-compression challenge (Q2 in the application map).

Competitors: the codecs everyone ships — zlib-9 (gzip-class), bz2-9, lzma-9e
(xz-class), zstd-19+LDM, brotli-11 — each called through its library API,
single stream, wall-clock timed. CSF entries: `csf.compress` (default zstd
path), CSF-Omni best-fit (effort=max; its panel runs threaded — noted), and
whole-corpus CSF-Pack archives (per-file zstd / solid / solid+omni).

Honesty rules: every codec round-trips (verified) or its row is marked FAIL;
times are medians of 1 run (cold-ish; this is a ratio benchmark, timing is
indicative); CSF-Omni is BY CONSTRUCTION the envelope of the panel + a 3-byte
header — beating raw brotli is impossible for it and is not claimed.

Run:  python experiments/csf_external_bench.py --silesia <dir> [--aitdcc <dir>]
"""

from __future__ import annotations

import argparse
import bz2
import io
import json
import lzma
import os
import sys
import time
import zipfile
import zlib

sys.path.insert(0, "src")
import brotli  # noqa: E402
import zstandard as zstd  # noqa: E402

from csf import csf_pack, omni  # noqa: E402

OUT = os.path.join("experiments", "results", "csf_external_bench.json")


def load_silesia(d: str) -> dict[str, bytes]:
    files = {}
    for zp in sorted(os.listdir(d)):
        if not zp.endswith(".zip"):
            continue
        with zipfile.ZipFile(os.path.join(d, zp)) as z:
            for name in z.namelist():
                files[name] = z.read(name)
    return files


def load_dir(d: str) -> dict[str, bytes]:
    files = {}
    for root, _dirs, names in os.walk(d):
        for n in sorted(names):
            p = os.path.join(root, n)
            if os.path.getsize(p) > 0:
                files[os.path.relpath(p, d).replace(os.sep, "/")] = open(p, "rb").read()
    return files


def _zstd_c(data):
    params = zstd.ZstdCompressionParameters.from_level(19, enable_ldm=True)
    return zstd.ZstdCompressor(compression_params=params).compress(data)


CODECS = {
    "zlib-9 (gzip-class)": (lambda b: zlib.compress(b, 9), zlib.decompress),
    "bzip2-9": (lambda b: bz2.compress(b, 9), bz2.decompress),
    "xz/lzma-9e": (lambda b: lzma.compress(b, preset=9 | lzma.PRESET_EXTREME), lzma.decompress),
    "zstd-19+LDM": (_zstd_c, lambda b: zstd.ZstdDecompressor().decompress(b)),
    "brotli-11": (lambda b: brotli.compress(b, quality=11), brotli.decompress),
    "CSF compress (default)": (lambda b: __import__("csf").compress(b),
                               lambda b: __import__("csf").decompress(b)),
    "CSF-Omni (best-fit, max)": (lambda b: omni.compress_best(b, effort="max"),
                                 lambda b: omni.decompress(b)),
}


def bench_corpus(name: str, files: dict[str, bytes]) -> dict:
    raw_total = sum(len(b) for b in files.values())
    rows = {}
    for cname, (c, d) in CODECS.items():
        csize = 0
        t_c = t_d = 0.0
        ok = True
        for _, blob in files.items():
            t0 = time.perf_counter()
            comp = c(blob)
            t1 = time.perf_counter()
            back = d(comp)
            t2 = time.perf_counter()
            csize += len(comp)
            t_c += t1 - t0
            t_d += t2 - t1
            if back != blob:
                ok = False
        rows[cname] = {
            "bytes": csize, "ratio": round(raw_total / csize, 3),
            "c_MBps": round(raw_total / 1e6 / t_c, 2) if t_c else None,
            "d_MBps": round(raw_total / 1e6 / t_d, 2) if t_d else None,
            "lossless": ok,
        }

    # whole-corpus archive modes (multi-file container story)
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        for label, kw in (
            ("CSF-Pack per-file zstd", {"codec": "zstd"}),
            ("CSF-Pack solid zstd", {"codec": "zstd", "solid": True}),
            ("CSF-Pack solid framed 4MB", {"codec": "zstd", "solid": True, "solid_frame_mb": 4.0}),
            ("CSF-Pack solid omni", {"codec": "omni", "solid": True}),
        ):
            p = os.path.join(td, "a.csf")
            t0 = time.perf_counter()
            csf_pack.pack_blobs(files, p, **kw)
            t1 = time.perf_counter()
            ok = csf_pack.unpack_blobs(p) == files
            sz = os.path.getsize(p)
            rows[label] = {"bytes": sz, "ratio": round(raw_total / sz, 3),
                           "c_MBps": round(raw_total / 1e6 / (t1 - t0), 2),
                           "d_MBps": None, "lossless": ok,
                           "note": "container incl. manifest + per-file sha256 + footer"}
    return {"corpus": name, "n_files": len(files), "raw_bytes": raw_total, "results": rows}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--silesia", default=None)
    ap.add_argument("--aitdcc", default=None)
    args = ap.parse_args()

    report = {"note": ("External corpora only. CSF-Omni is the panel envelope by construction "
                       "(= best panel codec + 3-byte header); container rows include full "
                       "integrity metadata. Omni encode uses its internal thread pool.")}
    corpora = []
    if args.silesia and os.path.isdir(args.silesia):
        corpora.append(bench_corpus("Silesia", load_silesia(args.silesia)))
    if args.aitdcc and os.path.isdir(args.aitdcc):
        corpora.append(bench_corpus("AITDCC-2026 public", load_dir(args.aitdcc)))
    report["corpora"] = corpora

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    for c in corpora:
        print(f"\n== {c['corpus']}  ({c['n_files']} files, {c['raw_bytes']:,} B)")
        for k, v in sorted(c["results"].items(), key=lambda kv: kv[1]["bytes"]):
            print(f"  {k:28s} {v['bytes']:>12,} B  {v['ratio']:>7.3f}x  "
                  f"c={v['c_MBps']} MB/s  lossless={v['lossless']}")


if __name__ == "__main__":
    main()
