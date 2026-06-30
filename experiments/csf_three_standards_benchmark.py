"""
CSF vs the standard codecs — three benchmarks, three data regimes, all lossless.

Honest head-to-head of the *shipping* CSF entropy stage (CSF-Omni best-fit, which
auto-selects the CSF-Col columnar transform where it wins) against the standard
general-purpose codecs (zlib/DEFLATE, bzip2/BWT, lzma/xz, zstd, brotli), over
three deliberately different corpora:

  1. STANDARD PROSE  — enwik8, the Large Text Compression Benchmark / Hutter
     Prize corpus (Wikipedia XML). The recognised standard. Tests general text.
       download: curl -O http://mattmahoney.net/dc/enwik8.zip ; unzip enwik8.zip
       pass:     --enwik /path/to/enwik8   (first 4 MB is used)
  2. MEMORY LOGS     — data/csf_memory/*.jsonl, append-only schema-homogeneous
     records (the North-Star "Memory" object). CSF-Col's target regime.
  3. SOURCE CODE     — a repo prose+code mix (the CSF-Pack archive use case).

Every codec is round-trip verified (lossless) before its number is reported.
Ratios are vs raw bytes; throughput is wall-clock MB/s. CSF-Col is surfaced as
its own row on every corpus so its contribution is legible, not hidden inside Omni.

    PYTHONPATH=src python experiments/csf_three_standards_benchmark.py --enwik <path>
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "src"))

try:  # Windows consoles default to cp1252; the tables use ×/✓/≤
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import brotli  # noqa: E402  (panel requires it; hard-fail early if missing)

# Reuse the EXACT codec panel + corpora the standing benchmark uses, so numbers
# are directly comparable to experiments/csf_compression_benchmark.py.
from csf_compression_benchmark import build_codecs, corpus_text_code  # noqa: E402

CAP = 4 * 1024 * 1024


def col_codec():
    """A visible 'CSF-Col -> brotli-11' row: the columnar transform front-end with
    a brotli entropy back-end, exactly what CSF-Omni picks internally where col wins.
    Falls back to plain brotli when the input is not column-transposable JSONL, so
    it is never a regression — and round-trips losslessly either way."""
    from csf import col_transform

    def enc(b: bytes) -> bytes:
        try:
            return b"\x01" + brotli.compress(col_transform.forward(b), quality=11)
        except col_transform.NotApplicable:
            return b"\x00" + brotli.compress(b, quality=11)

    def dec(c: bytes) -> bytes:
        body = brotli.decompress(c[1:])
        return col_transform.inverse(body) if c[:1] == b"\x01" else body

    return ("CSF-Col -> brotli-11", "csf-col", enc, dec)


def time_call(fn, arg):
    t = time.perf_counter()
    out = fn(arg)
    return out, time.perf_counter() - t


def bench(title: str, blob: bytes, note: str = "") -> None:
    mb = len(blob) / 1e6
    panel = build_codecs() + [col_codec()]
    rows = []
    for cname, _tier, enc, dec in panel:
        try:
            comp, te = time_call(enc, blob)
            back, td = time_call(dec, comp)
            if back != blob:
                rows.append((cname, len(comp), 0.0, 0.0, 0.0, False))
                continue
            rows.append((cname, len(comp), len(blob) / len(comp),
                         mb / te if te else 0.0, mb / td if td else 0.0, True))
        except Exception as e:  # pragma: no cover
            rows.append((cname, -1, 0.0, 0.0, 0.0, f"err: {e}"))
    rows_ok = [r for r in rows if r[5] is True]
    # champion = the best STANDARD tool (exclude store and both CSF rows), so the
    # table reads as "CSF vs the best non-CSF codec".
    champion = min((r for r in rows_ok if not r[0].startswith(("store", "CSF"))),
                   key=lambda r: r[1], default=None)

    print(f"\n### {title}")
    if note:
        print(f"*{note}*  \n")
    print(f"raw = **{len(blob):,} B**\n")
    print("| codec | size (B) | ratio | enc MB/s | dec MB/s | lossless |")
    print("|---|--:|--:|--:|--:|:--:|")
    for cname, size, ratio, enc_s, dec_s, ok in sorted(rows, key=lambda r: (r[1] < 0, r[1])):
        if ok is not True:
            print(f"| {mark(cname)} | — | — | — | — | {'FAIL' if ok is False else ok} |")
            continue
        tag = ""
        if champion and cname == champion[0]:
            tag = "  ⬅ best non-CSF"
        print(f"| {mark(cname)} | {size:,} | {ratio:.2f}× | {sp(enc_s)} | {sp(dec_s)} | ✓{tag} |")
    print()


def sp(mbps: float) -> str:
    """Throughput with one decimal under 10 MB/s so slow codecs don't round to 0."""
    return f"{mbps:.1f}" if mbps < 10 else f"{mbps:.0f}"


def mark(name: str) -> str:
    return f"**{name}**" if name.startswith(("CSF-Omni", "CSF-Col")) else name


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--enwik", help="path to extracted enwik8 (standard prose corpus)")
    args = ap.parse_args()

    print("# CSF vs standard codecs — three benchmarks (lossless-verified)\n")
    print(f"python {sys.version.split()[0]} · zstd+brotli+lzma+bz2 panel · "
          f"≤{CAP // 1024 // 1024} MB/corpus · ratios vs raw · CSF-Omni = shipping best-fit envelope\n")

    # 1. STANDARD PROSE — enwik8
    if args.enwik and Path(args.enwik).exists():
        data = Path(args.enwik).read_bytes()[:CAP]
        bench("Benchmark 1 — STANDARD PROSE: enwik8 (Large Text Compression Benchmark)",
              data, note="Wikipedia XML, the recognised Hutter-Prize/LTCB standard corpus")
    else:
        print("\n### Benchmark 1 — STANDARD PROSE: enwik8 — SKIPPED")
        print("pass --enwik <path>; get it via `curl -O http://mattmahoney.net/dc/enwik8.zip && unzip enwik8.zip`\n")

    # 2. MEMORY LOGS — CSF's native regime
    mem = b"".join(sorted(
        (p.read_bytes() for p in (REPO / "data/csf_memory").glob("*.jsonl")),
        key=len, reverse=True))[:CAP]
    if mem:
        bench("Benchmark 2 — MEMORY LOGS: data/csf_memory/*.jsonl (append-only, schema-homogeneous)",
              mem, note="CSF's North-Star 'Memory' object — the regime CSF-Col is built for")

    # 3. SOURCE CODE — CSF-Pack archive regime
    code_blob, _ = corpus_text_code()
    if code_blob:
        bench("Benchmark 3 — SOURCE CODE: repo prose+code mix (CSF-Pack archive use case)",
              code_blob[:CAP], note="heterogeneous .md/.py/.js — general developer archive")

    print("\n_All rows round-trip verified == original before counting. "
          "CSF-Omni's payload equals the best panel codec by construction (best-fit envelope), "
          "so it ties or beats every column at the cost of a small self-describing header._")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
