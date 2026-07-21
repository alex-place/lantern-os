"""CSF-Col v2 bench (#1593 second build) — measured on the real ledgers.

Compares zstd-19 / brotli-11 alone vs col_transform.forward() (best-of-both
layout selection: v1 positional vs v2 passthrough+shape-keyed) + the same coder.
Round-trip verified on every corpus; caps corpora at 3 MB (line-aligned) so runs
stay comparable.

Run:  python experiments/csf_col_v2_bench.py
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, "src")
import brotli  # noqa: E402
import zstandard as zstd  # noqa: E402

from csf import col_transform  # noqa: E402

OUT = os.path.join("experiments", "results", "csf_col_v2_bench.json")
CORPORA = {
    "csf_memory/raw.jsonl": [r"C:\dev\lantern-os\data\csf_memory\raw.jsonl",
                             "data/csf_memory/raw.jsonl"],
    "convergence/records.jsonl": [r"C:\dev\lantern-os\data\convergence\records.jsonl",
                                  "data/convergence/records.jsonl"],
    "conversations/garage-conversations.jsonl": [
        r"C:\dev\lantern-os\data\conversations\garage-conversations.jsonl",
        "data/conversations/garage-conversations.jsonl"],
}
CAP = 3_000_000


def main():
    z = zstd.ZstdCompressor(level=19)
    rows = []
    for name, paths in CORPORA.items():
        path = next((p for p in paths if os.path.exists(p)), None)
        if not path:
            rows.append({"corpus": name, "error": "missing"})
            continue
        blob = open(path, "rb").read()
        if len(blob) > CAP:
            blob = blob[:CAP]
            blob = blob[:blob.rfind(b"\n") + 1]
        base_z = len(z.compress(blob))
        base_b = len(brotli.compress(blob, quality=11))
        try:
            t = col_transform.forward(blob)
        except col_transform.NotApplicable as e:
            rows.append({"corpus": name, "raw": len(blob), "zstd19": base_z,
                         "brotli11": base_b, "col": f"NotApplicable: {e}"})
            continue
        col_z = len(z.compress(t))
        col_b = len(brotli.compress(t, quality=11))
        ok = col_transform.inverse(t) == blob
        rows.append({
            "corpus": name, "raw": len(blob), "layout": f"v{t[0]}",
            "zstd19": base_z, "col_zstd19": col_z,
            "gain_vs_zstd19_pct": round((base_z / col_z - 1) * 100, 1),
            "brotli11": base_b, "col_brotli11": col_b,
            "gain_vs_brotli11_pct": round((base_b / col_b - 1) * 100, 1),
            "lossless_roundtrip": ok,
        })

    report = {
        "note": ("Honest bar: the #1593 prediction was 1.5-2.5x over zstd-19; measured "
                 "reality is single-digit percent. The transform still pays (omni "
                 "auto-selects it when it wins) and v2 extends coverage to corpora v1 "
                 "declined entirely."),
        "rows": rows,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
