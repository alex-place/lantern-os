"""CSF solid-mode bench — measured through the real pack API on real file sets.

Compares whole-archive bytes: per-file zstd-19 vs +trained dict vs SOLID
(one stream), plus solid+omni for the max-ratio cold tier. Full unpack verified
per variant. Motivated by the archive-case open item on #904; the trained-dict
path is measured honestly INCLUDING its stored dictionary bytes.

Run:  python experiments/csf_solid_bench.py
"""

from __future__ import annotations

import glob
import json
import os
import sys
import tempfile

sys.path.insert(0, "src")
from csf import csf_pack  # noqa: E402

OUT = os.path.join("experiments", "results", "csf_solid_bench.json")
SETS = {
    "docs/research (*.md)": "docs/research/*.md",
    "src/csf (*.py)": "src/csf/*.py",
    "changelog.d (*.md)": "changelog.d/*.md",
}


def archive_size(blobs, **kw):
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "a.csf")
        csf_pack.pack_blobs(blobs, out, **kw)
        assert csf_pack.unpack_blobs(out) == blobs, "lossless round-trip failed"
        return os.path.getsize(out)


def main():
    rows = []
    for name, pat in SETS.items():
        files = [f for f in sorted(glob.glob(pat)) if os.path.getsize(f) > 0]
        blobs = {os.path.basename(f): open(f, "rb").read() for f in files}
        raw = sum(len(b) for b in blobs.values())
        per_file = archive_size(blobs, codec="zstd")
        with_dict = archive_size(blobs, codec="zstd", use_dict=True)
        solid = archive_size(blobs, codec="zstd", solid=True)
        solid_framed = archive_size(blobs, codec="zstd", solid=True, solid_frame_mb=1.0)
        solid_omni = archive_size(blobs, codec="omni", solid=True)
        rows.append({
            "set": name, "n_files": len(blobs), "raw": raw,
            "per_file_zstd19": per_file,
            "per_file_plus_dict": with_dict,
            "solid_zstd19": solid,
            "solid_framed_1mb": solid_framed,
            "solid_omni": solid_omni,
            "solid_gain_vs_per_file_pct": round((per_file / solid - 1) * 100, 1),
            "framed_gain_vs_per_file_pct": round((per_file / solid_framed - 1) * 100, 1),
            "framed_cost_vs_full_solid_pct": round((solid_framed / solid - 1) * 100, 1),
            "solid_gain_vs_dict_pct": round((with_dict / solid - 1) * 100, 1),
            "solid_omni_gain_vs_solid_pct": round((solid / solid_omni - 1) * 100, 1),
        })
    report = {
        "note": ("Whole-archive bytes via the real pack API, unpack-verified. The dict "
                 "variant includes its stored dictionary — on small sets it is net-"
                 "negative, which is why solid (not dict) is the cold-archive answer."),
        "rows": rows,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
