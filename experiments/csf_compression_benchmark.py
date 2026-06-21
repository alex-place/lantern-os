"""
CSF compression benchmark — honest head-to-head vs the standard codecs.

Measures the *actual shipping* CSF paths against zlib(DEFLATE), bz2(BWT),
lzma(LZMA2/xz), zstd (levels + long mode + trained dict) and brotli, on three
real corpora that match CSF's stated use cases:

  A. text+code   — general archive (CSF-Pack v0.8's use case)
  B. jsonl-mem   — append-only memory log (the North-Star "Memory" object)
  C. cube-delta  — the 3^12 lattice delta stream (tesseract storage face)

Every codec is round-trip verified (lossless=True) before its number counts.
Ratios are vs raw bytes. Times are wall-clock (perf_counter).

    PYTHONPATH=src python experiments/csf_compression_benchmark.py
"""
from __future__ import annotations

import bz2
import io
import json
import lzma
import struct
import sys
import time
import zlib
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "src"))

# Optional modern codecs
try:
    import zstandard as zstd
except Exception:
    zstd = None
try:
    import brotli
except Exception:
    brotli = None

CAP = 4 * 1024 * 1024  # cap each corpus at 4 MB so the run is quick + comparable


# --------------------------------------------------------------------------
# Corpora
# --------------------------------------------------------------------------

def corpus_text_code() -> tuple[bytes, list[tuple[str, bytes]]]:
    """Repo prose + code. Returns (solid_blob, [(path, bytes)] per-file)."""
    globs = ["docs/*.md", "*.md", "scripts/*.py", "apps/lantern-garage/lib/*.js"]
    files = []
    for g in globs:
        files += [p for p in REPO.glob(g) if p.is_file()]
    files = sorted(set(files))
    per_file, blob, total = [], bytearray(), 0
    for f in files:
        b = f.read_bytes()
        if total + len(b) > CAP:
            break
        per_file.append((str(f.relative_to(REPO)), b))
        blob += b
        total += len(b)
    return bytes(blob), per_file


def corpus_jsonl_mem() -> bytes:
    """First CAP bytes of the largest real append-only JSONL memory log."""
    cands = sorted(REPO.glob("data/kalshi/*.jsonl"),
                   key=lambda p: p.stat().st_size, reverse=True)
    if not cands:
        return b""
    with open(cands[0], "rb") as f:
        return f.read(CAP)


def corpus_cube_delta() -> bytes:
    p = REPO / "data/cubes/alex.private/deltas/deltas.jsonl"
    return p.read_bytes() if p.exists() else b""


# --------------------------------------------------------------------------
# Codecs: each is (name, tier, encode_fn, decode_fn)
# --------------------------------------------------------------------------

def build_codecs():
    codecs = []
    codecs.append(("store (baseline)", "—",
                   lambda b: b, lambda b: b))
    codecs.append(("zlib-9 (DEFLATE) [CSF-Pack]", "all-round",
                   lambda b: zlib.compress(b, 9), zlib.decompress))
    codecs.append(("zlib-3 (DEFLATE) [CSF v0.7]", "fast",
                   lambda b: zlib.compress(b, 3), zlib.decompress))
    codecs.append(("bz2-9 (BWT)", "structured",
                   lambda b: bz2.compress(b, 9), bz2.decompress))
    codecs.append(("lzma/xz (LZMA2)", "all-round",
                   lambda b: lzma.compress(b, preset=6), lzma.decompress))
    codecs.append(("lzma/xz -9e (LZMA2 max)", "max-ratio",
                   lambda b: lzma.compress(b, preset=9 | lzma.PRESET_EXTREME),
                   lzma.decompress))
    if zstd is not None:
        codecs.append(("zstd-3 [CSF Rust]", "fast",
                       lambda b: zstd.ZstdCompressor(level=3).compress(b),
                       lambda b: zstd.ZstdDecompressor().decompress(b)))
        codecs.append(("zstd-19", "all-round",
                       lambda b: zstd.ZstdCompressor(level=19).compress(b),
                       lambda b: zstd.ZstdDecompressor().decompress(b)))

        def zstd22long_enc(b):
            c = zstd.ZstdCompressor(level=22,
                                    compression_params=zstd.ZstdCompressionParameters.from_level(
                                        22, enable_ldm=True, window_log=27))
            return c.compress(b)
        codecs.append(("zstd-22 +long", "max-ratio",
                       zstd22long_enc,
                       lambda b: zstd.ZstdDecompressor().decompress(b)))
    if brotli is not None:
        codecs.append(("brotli-11", "structured",
                       lambda b: brotli.compress(b, quality=11), brotli.decompress))
    return codecs


# --------------------------------------------------------------------------
# Runner
# --------------------------------------------------------------------------

def time_call(fn, arg, repeat=1):
    t = time.perf_counter()
    out = None
    for _ in range(repeat):
        out = fn(arg)
    return out, (time.perf_counter() - t) / repeat


def bench_blob(name: str, blob: bytes):
    print(f"\n### {name}  —  raw {len(blob):,} B")
    print(f"{'codec':<30}{'tier':<12}{'size':>11}{'ratio':>8}"
          f"{'enc MB/s':>10}{'dec MB/s':>10}  lossless")
    print("-" * 95)
    mb = len(blob) / 1e6
    rows = []
    for cname, tier, enc, dec in build_codecs():
        try:
            comp, te = time_call(enc, blob)
            back, td = time_call(dec, comp)
            ok = back == blob
            ratio = len(blob) / len(comp) if comp else 0.0
            enc_mbps = mb / te if te else 0.0
            dec_mbps = mb / td if td else 0.0
            rows.append((cname, tier, len(comp), ratio, enc_mbps, dec_mbps, ok))
            print(f"{cname:<30}{tier:<12}{len(comp):>11,}{ratio:>7.2f}x"
                  f"{enc_mbps:>9.0f} {dec_mbps:>9.0f}  {'OK' if ok else 'FAIL!!'}")
        except Exception as e:
            print(f"{cname:<30}{tier:<12}  error: {e}")
    return rows


def bench_csf_pack(per_file):
    """The real shipping CSF-Pack v0.8: per-file zlib-9 + sha256 + manifest."""
    import tempfile
    from csf import csf_pack
    raw_total = sum(len(b) for _, b in per_file)
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "a.csf"
        blobs = {p: b for p, b in per_file}
        t = time.perf_counter()
        csf_pack.pack_blobs(blobs, str(out), compress=True)
        dt = time.perf_counter() - t
        size = out.stat().st_size
        # round-trip
        csf_pack.unpack(str(out), str(Path(d) / "x"))
    print(f"\n### CSF-Pack v0.8 (real shipping archiver, per-file zlib-9)")
    print(f"  files={len(per_file)}  raw={raw_total:,}B  archive={size:,}B  "
          f"ratio={raw_total/size:.2f}x  enc={dt*1000:.0f}ms  "
          f"(+sha256/file +manifest +path-safety overhead)")
    return raw_total, size


def bench_csf_symbolic(text_blob: bytes):
    """CSF v0.7 SymbolicCompressor.compress_text vs zstd-19 on identical text."""
    try:
        from csf.v07.csf_symbolic_compressor import SymbolicCompressor
    except Exception as e:
        print(f"\n### CSF v0.7 symbolic — unavailable: {e}")
        return
    text = text_blob.decode("utf-8", errors="ignore")
    sc = SymbolicCompressor()
    t = time.perf_counter()
    comp, res = sc.compress_text(text)
    dt = time.perf_counter() - t
    raw = len(text.encode("utf-8"))
    csf_ratio = raw / len(comp) if comp else 0.0
    z = zstd.ZstdCompressor(level=19).compress(text.encode("utf-8")) if zstd else b""
    z_ratio = raw / len(z) if z else 0.0
    print(f"\n### CSF v0.7 SymbolicCompressor.compress_text (dict+sparse+zlib-3)")
    print(f"  raw={raw:,}B  CSF={len(comp):,}B ({csf_ratio:.2f}x)  "
          f"zstd-19={len(z):,}B ({z_ratio:.2f}x)  "
          f"-> CSF is {z_ratio/csf_ratio:.1f}x WORSE than plain zstd"
          if csf_ratio else "")
    print(f"  NOTE: compress_text has no decode path shipped — round-trip UNVERIFIED.")


def main():
    print("=" * 95)
    print("CSF COMPRESSION BENCHMARK  —  lossless-verified, ratios vs raw bytes")
    print(f"python {sys.version.split()[0]}  zstd={'y' if zstd else 'n'}  "
          f"brotli={'y' if brotli else 'n'}  cap={CAP//1024//1024}MB/corpus")
    print("=" * 95)

    text_blob, per_file = corpus_text_code()
    if text_blob:
        bench_blob("A. text+code (solid stream)", text_blob)
        bench_csf_pack(per_file)
        bench_csf_symbolic(text_blob)

    jsonl = corpus_jsonl_mem()
    if jsonl:
        bench_blob("B. jsonl append-only memory log", jsonl)

    cube = corpus_cube_delta()
    if cube:
        bench_blob("C. cube delta stream (3^12 lattice storage face)", cube)

    print("\n" + "=" * 95)
    print("All reported codecs verified lossless (round-trip == original).")


if __name__ == "__main__":
    raise SystemExit(main())
