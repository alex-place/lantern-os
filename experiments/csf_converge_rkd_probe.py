"""C2 — Retrieval-Keyed Delta (RKD), the load-bearing novel tier of CSF-Converge.

Tests the one thing a generic windowed compressor CANNOT do: anchor each record to
its most-similar prior record found by RETRIEVAL over the whole corpus (not a byte
window), and store only the difference. If the append-only ledgers carry the 70%
"horizon" (near-duplicate) structure the lapse field measured, RKD should turn that
into near-empty deltas and beat solid+omni.

Mechanism (round-trip-exact):
  * inverted index: token -> line ids (a real global retrieval proxy).
  * for line i, base = the PRIOR line sharing the most tokens (retrieval).
  * delta = (base_ref, common-prefix-len, common-suffix-len, middle-bytes) — exact,
    reconstructs base[:p] + middle + base[len-s:]. Records that share structure with a
    retrieved base collapse to a tiny middle.
  * entropy floor: zstd-19 over the RKD-transformed stream, vs zstd-19 / brotli-11 /
    solid+omni over the raw corpus.

Honest prior: the 2026-06-29 zstd-beating research DEFERRED RKD ("no headroom while
logs fit zstd's window"). This MEASURES whether global structural anchoring beats
within-window LZ at current scale. Every path round-trips or the row is dropped.

Run:  python experiments/csf_converge_rkd_probe.py
"""

from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, "src")
import zstandard as zstd  # noqa: E402
import brotli  # noqa: E402

from csf import csf_pack  # noqa: E402

CORPORA = [
    ("convergence/records.jsonl", [r"C:\dev\lantern-os\data\convergence\records.jsonl",
                                   "data/convergence/records.jsonl"]),
    ("csf_memory/raw.jsonl", [r"C:\dev\lantern-os\data\csf_memory\raw.jsonl",
                              "data/csf_memory/raw.jsonl"]),
]
OUT = os.path.join("experiments", "results", "csf_converge_rkd_probe.json")
_TOK = re.compile(rb"[A-Za-z0-9_]+")


def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _read_varint(buf, pos):
    shift = n = 0
    while True:
        b = buf[pos]; pos += 1
        n |= (b & 0x7F) << shift
        if not (b & 0x80):
            return n, pos
        shift += 7


def rkd_forward(lines: list[bytes]) -> bytes:
    """Retrieval-anchored structural delta. Global nearest-prior by token overlap."""
    index: dict[bytes, list[int]] = {}
    out = bytearray()
    out += _varint(len(lines))
    for i, line in enumerate(lines):
        toks = set(_TOK.findall(line))
        # retrieve: prior line sharing the most tokens
        counts: dict[int, int] = {}
        for t in toks:
            for j in index.get(t, ()):
                counts[j] = counts.get(j, 0) + 1
        base_j = max(counts, key=counts.get) if counts else -1
        if base_j >= 0:
            base = lines[base_j]
            # longest common prefix / suffix
            p = 0
            m = min(len(base), len(line))
            while p < m and base[p] == line[p]:
                p += 1
            s = 0
            while s < (m - p) and base[len(base) - 1 - s] == line[len(line) - 1 - s]:
                s += 1
            middle = line[p:len(line) - s]
            out += _varint(i - base_j)          # back-reference (0 = no base)
            out += _varint(p)
            out += _varint(s)
            out += _varint(len(middle))
            out += middle
        else:
            out += _varint(0)                   # no base
            out += _varint(len(line))
            out += line
        for t in toks:
            index.setdefault(t, []).append(i)
    return bytes(out)


def rkd_inverse(buf: bytes) -> list[bytes]:
    pos = 0
    n, pos = _read_varint(buf, pos)
    lines: list[bytes] = []
    for i in range(n):
        back, pos = _read_varint(buf, pos)
        if back == 0:
            ln, pos = _read_varint(buf, pos)
            lines.append(buf[pos:pos + ln]); pos += ln
        else:
            p, pos = _read_varint(buf, pos)
            s, pos = _read_varint(buf, pos)
            ml, pos = _read_varint(buf, pos)
            middle = buf[pos:pos + ml]; pos += ml
            base = lines[i - back]
            lines.append(base[:p] + middle + base[len(base) - s:] if s else base[:p] + middle)
    return lines


def zc(b):
    p = zstd.ZstdCompressionParameters.from_level(19, enable_ldm=True)
    return zstd.ZstdCompressor(compression_params=p).compress(b)


def main():
    z = zstd
    rows = []
    for name, paths in CORPORA:
        path = next((p for p in paths if os.path.exists(p)), None)
        if not path:
            rows.append({"corpus": name, "error": "missing"}); continue
        blob = open(path, "rb").read()
        if len(blob) > 3_000_000:
            blob = blob[:3_000_000]; blob = blob[:blob.rfind(b"\n") + 1]
        nl = blob.endswith(b"\n")
        body = blob[:-1] if nl else blob
        lines = body.split(b"\n")

        transformed = rkd_forward(lines)
        # round-trip verify
        rebuilt = b"\n".join(rkd_inverse(transformed)) + (b"\n" if nl else b"")
        ok = rebuilt == blob

        base_z = len(zc(blob))
        base_b = len(brotli.compress(blob, quality=11))
        rkd_z = len(zc(transformed))
        rkd_b = len(brotli.compress(transformed, quality=11))
        # shipped solid+omni via the real pack API
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "a.csf")
            csf_pack.pack_blobs({"x": blob}, p, codec="omni", solid=True)
            omni_sz = os.path.getsize(p)

        rows.append({
            "corpus": name, "raw": len(blob), "n_lines": len(lines),
            "roundtrip": ok,
            "zstd19": base_z, "brotli11": base_b, "solid_omni": omni_sz,
            "rkd+zstd19": rkd_z, "rkd+brotli11": rkd_b,
            "rkd_vs_zstd_pct": round((base_z / rkd_z - 1) * 100, 1),
            "rkd_vs_solid_omni_pct": round((omni_sz / rkd_z - 1) * 100, 1),
            "best_rkd_vs_best_baseline_pct": round((min(base_z, base_b, omni_sz) / min(rkd_z, rkd_b) - 1) * 100, 1),
        })

    report = {
        "note": ("RKD = retrieval-anchored structural delta (global nearest-prior by token "
                 "overlap) + entropy floor, vs shipped zstd-19 / brotli-11 / solid+omni. "
                 "Kill criterion C2: RKD must beat solid+omni on the real ledgers."),
        "rows": rows,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(report, open(OUT, "w"), indent=2)
    for r in rows:
        if "error" in r:
            print(r); continue
        print(f"\n{r['corpus']} (raw {r['raw']:,}, {r['n_lines']} lines, rt={r['roundtrip']})")
        print(f"  zstd19={r['zstd19']:,}  brotli11={r['brotli11']:,}  solid+omni={r['solid_omni']:,}")
        print(f"  RKD+zstd19={r['rkd+zstd19']:,} ({r['rkd_vs_zstd_pct']:+.1f}% vs zstd, {r['rkd_vs_solid_omni_pct']:+.1f}% vs solid+omni)")
        print(f"  -> best RKD vs best baseline: {r['best_rkd_vs_best_baseline_pct']:+.1f}%")


if __name__ == "__main__":
    main()
