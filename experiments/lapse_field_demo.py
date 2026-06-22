"""
Lapse-field demonstration — the code-length metric of the Lapse Tesseract is real,
computable, and NON-UNIFORM on actual CSF data.

The Lapse Tesseract (docs/research/2026-06-20-lapse-tesseract.md) warps CSF's flat
Status-Cube × depth tesseract by a per-cell scalar field:

    L(x_i) = -log2 p(x_i | context)        [bits]  = "information proper-length"
    lapse  = 2^(-(L0 - L))  ~ compressed/raw       ∈ (0, 1]  ("dilation factor" √g00)

This script does NOT use Ouro and does NOT claim to beat any codec. Its only job is to
expose the FIELD: it runs a plain adaptive order-k byte model (a real, losslessly
decodable arithmetic-coding model — the decoder rebuilds the same counts from the
bytes it has already decoded) over real corpora and reports the per-symbol -log2 p
field and its variation. By Shannon + arithmetic coding the sum of the field is the
achievable code length to within < 2 bits for the whole stream, so the field is the
exact thing a coder would spend. Round-trip-verified zlib/zstd/brotli sizes are shown
only as a reality check that the field's total is in the right ballpark.

    PYTHONPATH=src python experiments/lapse_field_demo.py
"""
from __future__ import annotations

import bz2
import lzma
import math
import zlib
from pathlib import Path

try:
    import zstandard as zstd
except Exception:
    zstd = None
try:
    import brotli
except Exception:
    brotli = None

REPO = Path(__file__).resolve().parent.parent
CAP = 1_000_000  # cap each corpus so the pure-Python model stays quick


def corpora() -> list[tuple[str, bytes]]:
    out = []
    cube = REPO / "data/cubes/alex.private/deltas/deltas.jsonl"
    if cube.exists():
        out.append(("cube-delta (3^12 lattice storage face)", cube.read_bytes()[:CAP]))
    kal = sorted(REPO.glob("data/kalshi/*.jsonl"), key=lambda p: p.stat().st_size, reverse=True)
    if kal:
        out.append(("jsonl memory log (kalshi)", kal[0].read_bytes()[:CAP]))
    readme = REPO / "README.md"
    if readme.exists():
        out.append(("README.md (prose)", readme.read_bytes()[:CAP]))
    return out


def lapse_field(data: bytes, order: int = 3, delta: float = 0.05) -> list[float]:
    """Per-byte code length L[i] = -log2 p(x_i | last `order` bytes), adaptive
    add-delta model. Causal + deterministic => exactly the field an adaptive
    arithmetic coder would realize (Shannon-achievable to <2 bits/stream)."""
    counts: dict[bytes, list[int]] = {}
    totals: dict[bytes, int] = {}
    field = [0.0] * len(data)
    ctx = b"\x00" * order
    denom0 = 256 * delta
    for i, sym in enumerate(data):
        c = counts.get(ctx)
        if c is None:
            p = 1.0 / 256.0  # unseen context -> uniform prior
        else:
            p = (c[sym] + delta) / (totals[ctx] + denom0)
        field[i] = -math.log2(p)
        # update model AFTER coding the symbol (decoder can mirror this exactly)
        if c is None:
            c = counts[ctx] = [0] * 256
            totals[ctx] = 0
        c[sym] += 1
        totals[ctx] += 1
        ctx = (ctx + bytes([sym]))[1:]
    return field


def verified_codecs(data: bytes) -> list[tuple[str, int]]:
    """Round-trip-verified sizes of real codecs (reality check only)."""
    rows = [("zlib-9", zlib.compress(data, 9), zlib.decompress),
            ("bz2-9", bz2.compress(data, 9), bz2.decompress),
            ("lzma-9e", lzma.compress(data, preset=9 | lzma.PRESET_EXTREME), lzma.decompress)]
    if zstd:
        rows.append(("zstd-19", zstd.ZstdCompressor(level=19).compress(data),
                     lambda b: zstd.ZstdDecompressor().decompress(b)))
    if brotli:
        rows.append(("brotli-11", brotli.compress(data, quality=11), brotli.decompress))
    out = []
    for name, comp, dec in rows:
        assert dec(comp) == data, name  # lossless-verified
        out.append((name, len(comp)))
    return out


def main():
    print("=" * 88)
    print("LAPSE-FIELD DEMO — is the code-length metric real + non-uniform on CSF data?")
    print("order-3 adaptive byte model; L = -log2 p per byte; sum L / 8 = arithmetic-coder bytes (<2b/stream)")
    print("=" * 88)
    for name, data in corpora():
        if not data:
            continue
        n = len(data)
        field = lapse_field(data)
        total_bits = sum(field)
        pred_bytes = total_bits / 8.0
        # The "warp": how non-uniform is the field?
        horizon = sum(1 for L in field if L < 1.0) / n      # near-dust: <1 bit (very predictable)
        flat = sum(1 for L in field if L > 7.0) / n          # ~incompressible: >7 of 8 bits
        mean = total_bits / n
        var = sum((L - mean) ** 2 for L in field) / n
        print(f"\n### {name}   raw={n:,} B")
        print(f"  lapse field: mean={mean:.2f} bits/byte  std={var**0.5:.2f}  "
              f"min={min(field):.2f}  max={max(field):.2f}")
        print(f"  WARP — horizon cells (L<1 bit, deep wells)={horizon*100:.1f}%  "
              f"flat cells (L>7 bits, ~random)={flat*100:.1f}%")
        print(f"  order-3 model predicted size = {pred_bytes:,.0f} B  "
              f"(ratio {n/pred_bytes:.2f}x) — a TOY model; exposes the field, not a frontier coder")
        codecs = verified_codecs(data)
        print(f"  reality check (lossless-verified): " +
              "  ".join(f"{nm}={sz:,}B({n/sz:.1f}x)" for nm, sz in codecs))
    print("\n" + "=" * 88)
    print("Reading: a non-zero field std + a real horizon/flat split = the metric is NON-UNIFORM")
    print("(curved), i.e. the warp exists on real data. The toy order-3 model is only the probe;")
    print("the production lapse predictor is Ouro converge-depth (hypothesis E1/E2, not run here).")


if __name__ == "__main__":
    raise SystemExit(main())
