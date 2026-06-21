"""
CSF-Omni — deterministic best-fit byte-stream compressor.

The honest answer to "beat every competitor" is not to invent a new entropy coder
— it is to *absorb* them. CSF-Omni runs a fixed panel of `transform x codec`
candidates over the input, keeps every candidate that round-trips losslessly, and
emits the smallest one behind a 7-byte self-describing, integrity-checked header.

By construction the output is `<=` the best codec in the panel on **any** input
(the *upper envelope*): CSF-Omni equals the best codec on every input and strictly
beats every *non-winning* codec, at the cost of a small self-describing header vs
the per-corpus champion. When different corpora are won by different codecs, no
single fixed codec can match CSF-Omni on all of them; when one codec (e.g. brotli)
happens to win every corpus in a workload, CSF-Omni *ties* it within the header —
it does not beat the frontier coder's raw bytes, it guarantees you always get them.

Blob layout (self-describing, integrity-checked, deterministic)
---------------------------------------------------------------
    [ magic  2 B : b"\\xc5\\xf0" ]                 # "C5F0" — CSF-Omni sentinel
    [ method 1 B : high nibble = transform id, low nibble = codec id ]
    [ crc32  4 B : big-endian CRC-32 of the ORIGINAL bytes ]
    [ payload    : codec(transform(data)) ]

The CRC-32 makes decode self-verifying: a corrupted payload (brotli and store carry
no internal integrity check) is caught and raised, never returned as silently-wrong
bytes. All decode failures surface as `ValueError`.

Determinism
-----------
Candidates are tried in a fixed id order and the *strict* minimum size wins (the
first-listed candidate wins ties), so identical input always yields identical bytes.
The winner is round-trip verified before it is emitted; if verification ever fails
the next-smallest verified candidate is used (`store` always succeeds), so a buggy
optional codec can never corrupt output — at worst it is not selected.

Portability
-----------
`store / zlib / bz2 / lzma` are Python stdlib and always present. `zstd` and
`brotli` are used when installed (they carry the high-ratio wins). A blob can only
be decoded where the codec it selected is available; Lantern is local-first with
both installed. Pass `portable=True` to restrict the panel to stdlib-only codecs so
the output decodes anywhere.
"""
from __future__ import annotations

import bz2
import lzma
import zlib
from typing import Callable

# Optional high-ratio codecs --------------------------------------------------
try:
    import zstandard as _zstd
except Exception:  # pragma: no cover - optional dep
    _zstd = None
try:
    import brotli as _brotli
except Exception:  # pragma: no cover - optional dep
    _brotli = None

MAGIC = b"\xc5\xf0"
HEADER_LEN = 7  # magic(2) + method(1) + crc32(4)

# LZMA raw filter with pb=0 — position bits 0 helps line-structured text/JSONL.
# The exact same filter spec is required to decode (FORMAT_RAW has no header).
_LZMA_PB0 = [{"id": lzma.FILTER_LZMA2, "preset": 9 | lzma.PRESET_EXTREME, "pb": 0}]


# ---------------------------------------------------------------------------
# Transforms — invertible byte-level pre-passes that compose with any codec.
# id -> (name, forward, inverse).  forward/inverse must be exact inverses.
# ---------------------------------------------------------------------------

def _delta_fwd(b: bytes) -> bytes:
    if not b:
        return b
    out = bytearray(len(b))
    prev = 0
    for i, x in enumerate(b):
        out[i] = (x - prev) & 0xFF
        prev = x
    return bytes(out)


def _delta_inv(b: bytes) -> bytes:
    if not b:
        return b
    out = bytearray(len(b))
    prev = 0
    for i, d in enumerate(b):
        prev = (prev + d) & 0xFF
        out[i] = prev
    return bytes(out)


TRANSFORMS: dict[int, tuple[str, Callable[[bytes], bytes], Callable[[bytes], bytes]]] = {
    0: ("none", lambda b: b, lambda b: b),
    1: ("delta", _delta_fwd, _delta_inv),
}


# ---------------------------------------------------------------------------
# Codecs — id -> (name, available, encode, decode).  ids are STABLE; never reuse.
# ---------------------------------------------------------------------------

def _build_codecs() -> dict[int, tuple[str, bool, Callable, Callable]]:
    codecs: dict[int, tuple[str, bool, Callable, Callable]] = {
        0: ("store", True, lambda b: b, lambda b: b),
        1: ("zlib-9", True, lambda b: zlib.compress(b, 9), zlib.decompress),
        2: ("bz2-9", True, lambda b: bz2.compress(b, 9), bz2.decompress),
        3: ("lzma-9e", True,
            lambda b: lzma.compress(b, preset=9 | lzma.PRESET_EXTREME),
            lzma.decompress),
        4: ("lzma-pb0", True,
            lambda b: lzma.compress(b, format=lzma.FORMAT_RAW, filters=_LZMA_PB0),
            lambda b: lzma.decompress(b, format=lzma.FORMAT_RAW, filters=_LZMA_PB0)),
    }
    if _zstd is not None:
        codecs[5] = ("zstd-19", True,
                     lambda b: _zstd.ZstdCompressor(level=19).compress(b),
                     lambda b: _zstd.ZstdDecompressor().decompress(b))
    if _brotli is not None:
        # 6 = brotli default window (matches the standard `brotli.compress(q=11)`);
        # 7 = brotli max window + text mode; on some large, line-structured text it
        # can edge out brotli-11, though on this repo's JSONL memory log it ties.
        # compress_best keeps the smaller, so the panel is >= stock brotli on every input.
        codecs[6] = ("brotli-11", True,
                     lambda b: _brotli.compress(b, quality=11),
                     _brotli.decompress)
        codecs[7] = ("brotli-11-tx", True,
                     lambda b: _brotli.compress(b, quality=11, lgwin=24, mode=_brotli.MODE_TEXT),
                     _brotli.decompress)
    return codecs


CODECS = _build_codecs()

# The method byte packs (transform_id, codec_id) into two nibbles, so every id MUST
# fit in 4 bits. Fail loud at import if a future id ever breaks that invariant.
assert all(0 <= cid <= 0x0F for cid in CODECS), "CSF-Omni codec id must fit a nibble (0-15)"
assert all(0 <= tid <= 0x0F for tid in TRANSFORMS), "CSF-Omni transform id must fit a nibble (0-15)"

# Codecs that ship with Python — safe for portable mode and present at decode.
_STDLIB_CODEC_IDS = {0, 1, 2, 3, 4}

# Candidate search order (transform id, codec id). Lower order wins ties, so the
# cheapest-to-decode / most-standard option is preferred on a tie. `store` first
# guarantees a verified fallback always exists; brotli-default (6) is listed before
# brotli-text (7) so a tie keeps the stock encoding.
_SEARCH_ORDER: list[tuple[int, int]] = [
    (t, c)
    for c in (0, 1, 5, 3, 4, 2, 6, 7)   # store zlib zstd lzma lzma-pb0 bz2 brotli brotli-tx
    for t in (0, 1)                     # none, delta
    if c in CODECS
]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def _candidates(effort: str, portable: bool) -> list[tuple[int, int]]:
    """Candidate (transform_id, codec_id) list for an effort tier.

    - ``fast``       : store / zlib / zstd only, no transforms — near-zlib speed,
                       zstd-class ratio. For hot write paths.
    - ``max`` (def.) : every codec, transform=none. The ratio-optimal codec choice
                       without the transform sweep (which never won on real text/
                       JSONL/log corpora) — so identical ratio at ~half the encode.
    - ``exhaustive`` : every codec x every transform (adds the delta pre-pass that
                       can help raw numeric/binary streams). Slowest.
    """
    if effort == "fast":
        order = [(0, c) for c in (0, 1, 5) if c in CODECS]
    elif effort == "exhaustive":
        order = list(_SEARCH_ORDER)                         # codecs x {none, delta}
    else:  # "max"
        order = [(t, c) for (t, c) in _SEARCH_ORDER if t == 0]
    if portable:
        order = [(t, c) for (t, c) in order if c in _STDLIB_CODEC_IDS]
    return order


def _encode_all(data: bytes, effort: str, portable: bool) -> list[tuple[int, int, int, bytes]]:
    """Encode `data` with every candidate, smallest first.

    Each transform is computed exactly once (cached) and reused across codecs, so a
    pure-Python pre-pass like `delta` never runs more than once. Returns a list of
    (payload_size, transform_id, codec_id, payload) sorted ascending by size; ties
    keep search order (stable sort), so selection is deterministic.
    """
    cands = _candidates(effort, portable)
    tcache: dict[int, bytes] = {}
    for tid in {t for t, _ in cands}:
        try:
            tcache[tid] = TRANSFORMS[tid][1](data)
        except Exception:
            tcache[tid] = None  # type: ignore[assignment]

    results: list[tuple[int, int, int, bytes]] = []
    for tid, cid in cands:
        src = tcache.get(tid)
        if src is None:
            continue
        _cname, _avail, enc, _dec = CODECS[cid]
        try:
            payload = enc(src)
        except Exception:
            continue
        results.append((len(payload), tid, cid, payload))
    results.sort(key=lambda r: r[0])  # stable -> search order breaks ties
    return results


def rank(data: bytes, effort: str = "max", portable: bool = False) -> list[tuple[str, int]]:
    """Diagnostic: every candidate's total blob size (incl. header), smallest first.

    Returns [(method_name, blob_size)] so callers/benchmarks can show *which* codec
    CSF-Omni selected and by how much it beat the runners-up.
    """
    rows = []
    for size, tid, cid, _payload in _encode_all(bytes(data), effort, portable):
        cname = CODECS[cid][0]
        tname = TRANSFORMS[tid][0]
        label = cname if tid == 0 else f"{tname}+{cname}"
        rows.append((label, size + HEADER_LEN))
    return rows


def compress_best(data: bytes, effort: str = "max", portable: bool = False) -> bytes:
    """Compress `data` with the deterministically smallest verified candidate.

    The returned blob is self-describing and integrity-checked — decode it with
    `decompress`. Guaranteed `len(result) <= min(len(codec(data)) for codec in panel)
    + 7`, i.e. never worse than the best codec in the panel (plus the 7-byte header).
    """
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError("compress_best expects bytes")
    data = bytes(data)
    crc = (zlib.crc32(data) & 0xFFFFFFFF).to_bytes(4, "big")

    # Smallest-first; emit the first that round-trips. `store` is always in the set
    # and always verifies, so this loop always terminates with a lossless result.
    for _size, tid, cid, payload in _encode_all(data, effort, portable):
        method = (tid << 4) | cid
        try:
            if _decode_method(method, payload) == data:
                return MAGIC + bytes([method]) + crc + payload
        except Exception:
            continue

    return MAGIC + bytes([0]) + crc + data  # store fallback (unreachable in practice)


def _decode_method(method: int, payload: bytes) -> bytes:
    tid = (method >> 4) & 0x0F
    cid = method & 0x0F
    if cid not in CODECS:
        raise ValueError(f"CSF-Omni: codec id {cid} unavailable in this environment")
    if tid not in TRANSFORMS:
        raise ValueError(f"CSF-Omni: unknown transform id {tid}")
    _cname, _avail, _enc, dec = CODECS[cid]
    _tname, _fwd, inv = TRANSFORMS[tid]
    try:
        return inv(dec(payload))
    except ValueError:
        raise
    except Exception as e:
        # Normalize codec-specific decode errors (zlib.error / OSError / LZMAError)
        # to ValueError so the documented contract holds for callers.
        raise ValueError(f"CSF-Omni: corrupt payload for codec {cid} "
                         f"({type(e).__name__}: {e})") from e


def decompress(blob: bytes) -> bytes:
    """Invert `compress_best`. Raises ValueError on a non-CSF-Omni blob or corruption."""
    if len(blob) < HEADER_LEN or blob[:2] != MAGIC:
        raise ValueError("not a CSF-Omni blob (bad magic)")
    method = blob[2]
    crc = int.from_bytes(blob[3:7], "big")
    result = _decode_method(method, blob[HEADER_LEN:])
    if (zlib.crc32(result) & 0xFFFFFFFF) != crc:
        raise ValueError("CSF-Omni: integrity check failed (CRC-32 mismatch — corrupt blob)")
    return result


def describe(blob: bytes) -> str:
    """Human-readable method label for a CSF-Omni blob (for reports/inspection)."""
    if len(blob) < HEADER_LEN or blob[:2] != MAGIC:
        return "not-csf-omni"
    method = blob[2]
    tid, cid = (method >> 4) & 0x0F, method & 0x0F
    tname = TRANSFORMS.get(tid, ("?",))[0]
    cname = CODECS.get(cid, ("?",))[0]
    return cname if tid == 0 else f"{tname}+{cname}"
