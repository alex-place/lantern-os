"""C2 re-test — RKD on VARIED real-world web files (Silesia), incl. the window-bounded
case that is RKD's actual niche.

The first RKD run used the project's small homogeneous JSONL ledgers and lost. This
re-runs on the standard varied corpus (Silesia: chemical DB, DB dump, XML, English
prose, source) at record/line level, and adds the comparison that tests RKD's real
premise: RKD uses a COMPACT global index (memory-light) to reach any prior record,
whereas an LZ coder needs the match inside its WINDOW. So the honest questions are:

  1. Does RKD beat a full-window coder (zstd-19+LDM / solid+omni)? (expected: no when
     the file fits the window — same reason as the ledgers)
  2. Does RKD beat a WINDOW-BOUNDED coder (zstd, 1 MB window = streaming / memory-
     constrained)? (RKD's niche: global reach without the window's RAM)

Line-level RKD (round-trip exact). Every path verifies or the row is dropped.

Run:  python experiments/csf_converge_rkd_varied.py --silesia <dir>
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import zipfile

sys.path.insert(0, "src")
import zstandard as zstd  # noqa: E402
import brotli  # noqa: E402

from csf import csf_pack  # noqa: E402
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from csf_converge_rkd_probe import rkd_forward, rkd_inverse  # reuse the transform  # noqa: E402

OUT = os.path.join("experiments", "results", "csf_converge_rkd_varied.json")
# record/line-structured Silesia members (RKD anchors records; binaries are N/A)
TARGETS = ["nci", "osdb", "xml", "dickens", "webster", "reymont", "samba"]


def zc(data, window_log=None):
    if window_log is None:
        p = zstd.ZstdCompressionParameters.from_level(19, enable_ldm=True)
    else:
        # bounded window = streaming / memory-constrained coder
        p = zstd.ZstdCompressionParameters.from_level(
            19, window_log=window_log, enable_ldm=True)
    return zstd.ZstdCompressor(compression_params=p).compress(data)


def load_silesia(d):
    out = {}
    for zp in sorted(os.listdir(d)):
        if zp.endswith(".zip"):
            with zipfile.ZipFile(os.path.join(d, zp)) as z:
                for n in z.namelist():
                    out[n] = z.read(n)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--silesia", required=True)
    ap.add_argument("--cap", type=int, default=8_000_000)
    args = ap.parse_args()
    files = load_silesia(args.silesia)

    rows = []
    for name in TARGETS:
        blob = files.get(name)
        if not blob:
            continue
        if len(blob) > args.cap:
            blob = blob[:args.cap]; blob = blob[:blob.rfind(b"\n") + 1]
        if not blob or b"\n" not in blob:
            continue
        nl = blob.endswith(b"\n")
        lines = (blob[:-1] if nl else blob).split(b"\n")

        t = rkd_forward(lines)
        ok = (b"\n".join(rkd_inverse(t)) + (b"\n" if nl else b"")) == blob
        if not ok:
            rows.append({"file": name, "roundtrip": False}); continue

        full = len(zc(blob))                       # zstd-19+LDM, full window
        w1mb = len(zc(blob, window_log=20))        # 1 MB window (streaming/constrained)
        bro = len(brotli.compress(blob, quality=11))
        rkd_full = len(zc(t))
        rkd_w1mb = len(zc(t, window_log=20))
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "a.csf")
            csf_pack.pack_blobs({"x": blob}, p, codec="omni", solid=True)
            omni_sz = os.path.getsize(p)

        rows.append({
            "file": name, "raw": len(blob), "n_lines": len(lines), "roundtrip": True,
            "zstd19_full": full, "brotli11": bro, "solid_omni": omni_sz,
            "rkd_full": rkd_full,
            "rkd_vs_solid_omni_pct": round((omni_sz / rkd_full - 1) * 100, 1),
            "zstd_1MBwin": w1mb, "rkd_1MBwin": rkd_w1mb,
            "rkd_vs_zstd_1MBwin_pct": round((w1mb / rkd_w1mb - 1) * 100, 1),
        })
        r = rows[-1]
        print(f"{name:9s} raw={len(blob):>9,} lines={len(lines):>7,}  "
              f"solid+omni={omni_sz:>8,}  RKD_full={rkd_full:>8,} ({r['rkd_vs_solid_omni_pct']:+.1f}%)  "
              f"| 1MBwin: zstd={w1mb:>8,} RKD={rkd_w1mb:>8,} ({r['rkd_vs_zstd_1MBwin_pct']:+.1f}%)",
              flush=True)

    report = {
        "note": ("RKD on varied Silesia files. rkd_vs_solid_omni = full-RAM case (RKD "
                 "expected to lose when the file fits the window). rkd_vs_zstd_1MBwin = "
                 "RKD's niche: global reach vs a memory-bounded coder."),
        "rows": rows,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(report, open(OUT, "w"), indent=2)
    wins_full = sum(1 for r in rows if r.get("rkd_vs_solid_omni_pct", -1) > 0)
    wins_bound = sum(1 for r in rows if r.get("rkd_vs_zstd_1MBwin_pct", -1) > 0)
    print(f"\nfull-RAM: RKD beats solid+omni on {wins_full}/{len(rows)} files")
    print(f"1MB-window (streaming): RKD beats bounded zstd on {wins_bound}/{len(rows)} files")


if __name__ == "__main__":
    main()
