"""
CSF-Pack (CSF v0.8) — general-purpose archive: pack & unpack ARBITRARY files.

Unlike the symbolic CSF formats (v0.3 `csf_file.py`, v0.7 engine) which encode
world-model memory, CSF-Pack is a plain container for any bytes — the Σ₀ release
that can wrap arbitrary files (code, data, models) with per-file hashing,
per-file compression (zstd by default, zlib fallback), and an integrity footer.

Codec (R1/R2 upgrade)
---------------------
Each file records its `codec` ("zstd" | "zlib" | "store" | "omni"). The default is
**zstd-19 + long-distance matching** when the `zstandard` package is available,
falling back to **zlib-9** otherwise. DEFLATE's 32 KB window cannot capture the
long-range repetition in JSONL memory logs / large blobs; zstd's large window
does, measured ~25-30x smaller on real append-only memory (see
`experiments/csf_compression_benchmark.py`).

The opt-in **"omni"** codec (CSF-Omni, `omni.py`) is the *max-ratio* tier: it runs
the whole codec panel per file (store/zlib/bz2/lzma/zstd/brotli + a byte transform),
round-trip-verifies each, and keeps the smallest behind a 7-byte self-describing,
CRC-checked header. It beats zstd-19 on every measured corpus (by 3-16%) by picking
the per-input best coder, at a higher encode cost — use it for cold/archival packs;
keep the zstd default for hot write paths.

Backward compatibility: archives written before this change have no `codec`
field; the reader treats a missing codec as "zlib" (when `compressed`) or
"store" (when not), so every existing `.csf` still unpacks byte-for-byte.

Optional `use_dict=True` trains a single zstd dictionary over all files and
appends it to the blob region. This recovers cross-file redundancy that per-file
compression loses, *without* sacrificing per-file random access.

Binary layout
-------------
    [Magic        4 bytes : b"CSF\\x00"]
    [Version      2 bytes : major, minor = 0, 8]
    [Flags        2 bytes : bit0 = blobs compressed (codec in manifest)]
    [ManifestLen  4 bytes : uint32 BE]
    [Manifest     N bytes : UTF-8 JSON]
    [Blob region  M bytes : per-file blobs, then optional shared dict]
    [Footer      40 bytes : sha256(everything before footer) (32) + total size uint64 BE (8)]

Manifest JSON
-------------
    {
      "format": "csf-pack", "version": "0.8", "created_at": <epoch>,
      "compressed": bool, "codec": "zstd"|"zlib"|"store", "file_count": int,
      "shared_dict": {"offset": int, "size": int, "codec": "zstd"}?,   # optional
      "files": [{"path", "size", "csize", "sha256", "offset", "compressed", "codec",
                 "description"?, "metadata"?}]   # description/metadata optional, per-file
    }

Per-file grounding (Σ₀)
-----------------------
Each file entry may carry an optional ``description`` (str) and ``metadata``
(dict) — a lossless place to record *what* an archived file/script is and *why*
it exists (purpose, loop-stage, verdict, evidence, confidence, source). They are
omitted when absent, so annotating is fully backward compatible: read them with
``list_archive`` / ``file_annotation(archive, path)`` / ``annotations(archive)``.

CLI
---
    python -m csf.csf_pack pack <paths...> -o out.csf [--no-compress] [--codec zstd|zlib|store] [--dict]
    python -m csf.csf_pack unpack out.csf -d <dest_dir>
    python -m csf.csf_pack list out.csf
"""
from __future__ import annotations

import hashlib
import json
import os
import struct
import time
import zlib
from pathlib import Path
from typing import Iterable

from . import omni

try:
    import zstandard as _zstd
except Exception:  # pragma: no cover - environment without zstandard
    _zstd = None

MAGIC = b"CSF\x00"
VERSION = (0, 8)
# Solid archives (one compressed stream over the concatenation of all members)
# stamp 0.9 so pre-solid readers refuse them with a clean version error instead
# of misparsing decompressed-space offsets as blob offsets. Readers accept both.
SOLID_VERSION = (0, 9)
FLAG_COMPRESSED = 0x0001
FOOTER_FMT = ">Q"  # total size; preceded by 32-byte sha256

ZSTD_LEVEL = 19
DEFAULT_CODEC = "zstd" if _zstd is not None else "zlib"


# ---------------------------------------------------------------------------
# Codec layer
# ---------------------------------------------------------------------------

def _zstd_compressor(dict_data=None):
    if dict_data is not None:
        return _zstd.ZstdCompressor(level=ZSTD_LEVEL, dict_data=dict_data)
    params = _zstd.ZstdCompressionParameters.from_level(ZSTD_LEVEL, enable_ldm=True)
    return _zstd.ZstdCompressor(compression_params=params)


def _compress_blob(raw: bytes, codec: str, dict_data=None) -> bytes:
    if codec == "store":
        return raw
    if codec == "zlib":
        return zlib.compress(raw, 9)
    if codec == "zstd":
        if _zstd is None:
            raise RuntimeError("zstd codec requested but 'zstandard' is not installed")
        return _zstd_compressor(dict_data).compress(raw)
    if codec == "omni":
        # Deterministic best-fit: CSF-Omni runs the whole codec panel and keeps the
        # smallest verified-lossless result, self-describing + CRC-checked. Ignores
        # the shared dict (it selects per-blob). Trades encode time for max ratio.
        return omni.compress_best(raw)
    raise ValueError(f"unknown codec: {codec!r}")


def _decompress_blob(stored: bytes, codec: str, dict_data=None) -> bytes:
    if codec == "store":
        return stored
    if codec == "zlib":
        return zlib.decompress(stored)
    if codec == "zstd":
        if _zstd is None:
            raise RuntimeError("archive uses zstd codec but 'zstandard' is not installed")
        dctx = _zstd.ZstdDecompressor(dict_data=dict_data) if dict_data else _zstd.ZstdDecompressor()
        return dctx.decompress(stored)
    if codec == "omni":
        # verify=False: CSF-Pack already checks SHA-256 per file after decode, so the
        # blob's CRC-32 pass is redundant here — skipping it speeds the archive read.
        return omni.decompress(stored, verify=False)
    raise ValueError(f"unknown codec: {codec!r}")


def _file_codec(fe: dict) -> str:
    """Resolve a file entry's codec, defaulting for pre-codec (legacy) archives."""
    codec = fe.get("codec")
    if codec:
        return codec
    return "zlib" if fe.get("compressed") else "store"


# ---------------------------------------------------------------------------
# Single-blob stream helpers (lightweight; 1-byte codec header, no integrity)
# ---------------------------------------------------------------------------

_CODEC_IDS = {"store": 0, "zlib": 1, "zstd": 2, "omni": 3}
_CODEC_BY_ID = {v: k for k, v in _CODEC_IDS.items()}


def compress_bytes(data: bytes, codec: str | None = None) -> bytes:
    """Compress one byte string: 1-byte codec header + payload.

    Lightweight stream form (no manifest / per-file hashing). For multi-file
    archives with integrity use pack()/pack_blobs()/unpack().
    """
    if codec is None:
        codec = DEFAULT_CODEC
    if codec not in _CODEC_IDS:
        raise ValueError(f"unknown codec: {codec!r}")
    return bytes([_CODEC_IDS[codec]]) + _compress_blob(data, codec)


def decompress_bytes(blob: bytes) -> bytes:
    """Inverse of compress_bytes()."""
    if not blob:
        return b""
    codec = _CODEC_BY_ID.get(blob[0])
    if codec is None:
        raise ValueError(f"unknown codec id {blob[0]}")
    return _decompress_blob(blob[1:], codec)


# ---------------------------------------------------------------------------
# Generative members (v0.9) — recomputation-as-storage
# ---------------------------------------------------------------------------
# A generative member stores a tiny DESCRIPTION instead of bytes; readers
# materialize it deterministically and verify against the recorded sha256.
# This is generator coding (the repo's own pi measurement: 6,666x) shipped as a
# container primitive for data that HAS a compact recipe — lawful/simulated
# streams — not a claim against Shannon: the bytes were never random. Closed
# registry only (no eval, no user code): each kind is a pure function of its
# JSON params, stable across platforms/versions by construction.

_GEN_MAX_BYTES = 1 << 30  # 1 GiB materialization guard


def _gen_zeros(spec: dict) -> bytes:
    return b"\x00" * int(spec["size"])


def _gen_repeat(spec: dict) -> bytes:
    pat = bytes.fromhex(spec["pattern_hex"])
    if not pat:
        raise ValueError("generator repeat: empty pattern")
    n = int(spec["size"])
    return (pat * (n // len(pat) + 1))[:n]


def _gen_sha256_ctr(spec: dict) -> bytes:
    """Counter-mode SHA-256 DRBG: block_i = sha256(seed || i). Deterministic
    forever (stdlib-only, no PRNG version drift) — the reference 'lawful
    high-entropy stream' generator."""
    seed = str(spec["seed"]).encode("utf-8")
    n = int(spec["size"])
    out = bytearray()
    i = 0
    while len(out) < n:
        out += hashlib.sha256(seed + i.to_bytes(8, "big")).digest()
        i += 1
    return bytes(out[:n])


# Park-Miller minstd LCG — the classic reproducible-"random" stream used to seed scientific
# simulations. A registered scientific generator (F1c, #2799): version-pinned, deterministic
# forever (integer arithmetic, no float/PRNG drift), and slice-addressable via jump-ahead
# x_k = (a^k · x_0) mod m. Packed as uint32 little-endian.
_LCG_A = 16807
_LCG_M = 2147483647  # 2**31 - 1


def _lcg_seed(spec: dict) -> int:
    s = int(spec["seed"]) % _LCG_M
    return s if s != 0 else 1  # 0 is the LCG's fixed point — forbid it


def _gen_lcg(spec: dict) -> bytes:
    n = int(spec["size"])
    x = _lcg_seed(spec)
    out = bytearray()
    for _ in range((n + 3) // 4):
        x = (_LCG_A * x) % _LCG_M
        out += x.to_bytes(4, "little")
    return bytes(out[:n])


_GENERATORS = {"zeros": _gen_zeros, "repeat": _gen_repeat, "sha256-ctr": _gen_sha256_ctr,
               "lcg": _gen_lcg}

# Version pins for the generator registry (F1c). A generative member records the version it was
# built under; if a kind's implementation ever changes its output, bump the version here — old
# archives (pinned to the prior version) are then REFUSED with a clear drift error instead of
# silently regenerating wrong bytes. Enforced by the golden-hash test (tests/csf) + the footer
# sha256. Legacy specs with no `version` are grandfathered (they predate the pin).
_GEN_VERSIONS = {"zeros": 1, "repeat": 1, "sha256-ctr": 1, "lcg": 1}


def _check_gen_version(gen: dict) -> None:
    """Raise if a generative member's pinned version can't be reproduced by the current registry."""
    kind = gen.get("kind")
    v = gen.get("version")
    if v is not None and v != _GEN_VERSIONS.get(kind):
        raise ValueError(
            f"generator {kind!r} spec pinned to version {v}, registry serves "
            f"{_GEN_VERSIONS.get(kind)} — regeneration would drift; refusing (F1c)")


def _gen_slice(gen: dict, offset: int, length: int) -> bytes:
    """O(window) slice of a generative member — the observer-slice fast path (F1b).

    Integrity contract: the spec is footer-authenticated in the manifest and the
    full stream was sha-verified at pack time; determinism makes any window of a
    regeneration equal to the same window of the verified stream. (Merkle
    spot-checks are the F1b ladder's next rung, not required for soundness here.)
    """
    kind = gen.get("kind")
    _check_gen_version(gen)
    total = int(gen.get("size", 0))
    if offset < 0 or length < 0 or offset + length > total:
        raise ValueError("slice out of range")
    if length == 0:
        return b""
    if kind == "zeros":
        return b"\x00" * length
    if kind == "repeat":
        pat = bytes.fromhex(gen["pattern_hex"])
        start = offset % len(pat)
        reps = (start + length) // len(pat) + 2
        return (pat * reps)[start:start + length]
    if kind == "sha256-ctr":
        seed = str(gen["seed"]).encode("utf-8")
        first = offset // 32
        last = (offset + length - 1) // 32
        out = bytearray()
        for i in range(first, last + 1):
            out += hashlib.sha256(seed + i.to_bytes(8, "big")).digest()
        lo = offset - first * 32
        return bytes(out[lo:lo + length])
    if kind == "lcg":
        # jump-ahead to the first covering uint32: x_k = (a^k · x_0) mod m, then iterate the window
        s = _lcg_seed(gen)
        first = offset // 4
        last = (offset + length - 1) // 4
        x = (pow(_LCG_A, first + 1, _LCG_M) * s) % _LCG_M
        out = bytearray()
        for _ in range(first, last + 1):
            out += x.to_bytes(4, "little")
            x = (_LCG_A * x) % _LCG_M
        lo = offset - first * 4
        return bytes(out[lo:lo + length])
    # unknown kinds (future registry growth): fall back to full materialization
    return materialize_generator(gen)[offset:offset + length]


def materialize_generator(gen: dict) -> bytes:
    """Materialize a generative member's bytes from its spec (registry-only)."""
    kind = gen.get("kind")
    fn = _GENERATORS.get(kind)
    if fn is None:
        raise ValueError(f"unknown generator kind: {kind!r}")
    _check_gen_version(gen)
    if int(gen.get("size", 0)) > _GEN_MAX_BYTES:
        raise ValueError("generator size exceeds materialization guard")
    return fn(gen)


def _train_dict(raws: list[bytes]) -> "object | None":
    """Train a zstd dictionary over file contents. Returns dict or None if not viable."""
    if _zstd is None:
        return None
    samples = [r for r in raws if r]
    total = sum(len(r) for r in samples)
    # Dictionaries only pay off across several samples with shared structure.
    if len(samples) < 7 or total < 4096:
        return None
    dict_size = max(1024, min(112 * 1024, total // 10))
    try:
        return _zstd.train_dictionary(dict_size, samples)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _iter_files(paths: Iterable[str]):
    """Yield (abs_path, arc_path) for each file; directories are walked."""
    for p in paths:
        path = Path(p)
        if path.is_dir():
            base = path.parent
            for f in sorted(path.rglob("*")):
                if f.is_file():
                    yield f, f.relative_to(base).as_posix()
        elif path.is_file():
            yield path, path.name
        else:
            raise FileNotFoundError(p)


def _safe_join(dest: Path, arc_path: str) -> Path:
    """Resolve arc_path under dest, refusing path traversal (.. / absolute)."""
    target = (dest / arc_path).resolve()
    if not str(target).startswith(str(dest.resolve())):
        raise ValueError(f"unsafe path in archive: {arc_path}")
    return target


# ---------------------------------------------------------------------------
# Pack
# ---------------------------------------------------------------------------

def _annotation_for(annotations: dict | None, arc: str):
    """Return (description, metadata) for arc_path, tolerating either an
    ``{arc: {"description":..., "metadata":...}}`` shape or a bare
    ``{arc: "one-line description"}`` shape. Missing → (None, None)."""
    if not annotations:
        return None, None
    ann = annotations.get(arc)
    if ann is None:
        return None, None
    if isinstance(ann, str):
        return ann, None
    if isinstance(ann, dict):
        return ann.get("description"), ann.get("metadata")
    return None, None


def _write_archive(items, out_path: str, compress: bool, extra_meta: dict | None,
                   codec: str | None = None, use_dict: bool = False,
                   annotations: dict | None = None, solid: bool = False,
                   solid_frame_mb: float | None = None) -> dict:
    """Core writer. items = iterable of (arc_path, raw_bytes).

    ``annotations`` optionally attaches a per-file ``description`` (str) and/or
    ``metadata`` (JSON-serialisable dict) to each manifest entry, keyed by
    arc_path. Both are optional and omitted from an entry when absent, so
    archives written without annotations are byte-identical to before.

    ``solid`` (cold-archive mode, measured 2026-07-21): compress ONE stream over
    the concatenation of all members instead of per-file blobs — cross-file
    redundancy reaches the coder directly, which a trained dictionary only
    approximates (measured on real sets: solid +20–41% over per-file zstd-19,
    while the dict was net-NEGATIVE once its own bytes were counted). Trade-off:
    reading any single member decompresses the whole stream, so keep the default
    (per-file) for hot/random-access archives. ``use_dict`` is ignored under
    solid (subsumed); ``compress=False`` ignores solid (store gains nothing).
    Solid archives stamp version 0.9 (older readers refuse them cleanly).
    """
    if not compress:
        codec = "store"
        solid = False
    elif codec is None:
        codec = DEFAULT_CODEC

    raws = []
    gens = []   # (arc, generator_spec) — v0.9 generative members, no stored bytes
    for arc, raw in items:
        if isinstance(raw, dict) and "generator" in raw:
            gens.append((arc, dict(raw["generator"])))
        else:
            raws.append((arc, raw))

    dict_data = None
    dict_bytes = b""
    if use_dict and codec == "zstd" and not solid:
        dict_data = _train_dict([raw for _, raw in raws])
        if dict_data is not None:
            dict_bytes = dict_data.as_bytes()

    def _gen_entry(arc: str, gen: dict) -> dict:
        # F1c: pin the generator to its current registry version so a future output-changing
        # revision is REFUSED on read (clear drift error) rather than silently regenerating wrong
        # bytes. Version-pinned by construction; specs that predate the pin stay grandfathered.
        if gen.get("version") is None and gen.get("kind") in _GEN_VERSIONS:
            gen = {**gen, "version": _GEN_VERSIONS[gen["kind"]]}
        raw = materialize_generator(gen)   # materialized once at pack time to hash
        entry = {
            "path": arc, "size": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "offset": 0, "compressed": False, "codec": "store",
            "generator": gen,
        }
        desc, md = _annotation_for(annotations, arc)
        if desc:
            entry["description"] = desc
        if md:
            entry["metadata"] = md
        return entry

    files = []
    if solid:
        stream = bytearray()
        for arc, raw in raws:
            entry = {
                "path": arc, "size": len(raw),
                "sha256": hashlib.sha256(raw).hexdigest(),
                "offset": len(stream),          # offset into the DECOMPRESSED stream
                "compressed": True, "codec": codec,
            }
            desc, md = _annotation_for(annotations, arc)
            if desc:
                entry["description"] = desc
            if md:
                entry["metadata"] = md
            files.append(entry)
            stream.extend(raw)
        # Framed solid: cut the stream into frames AT MEMBER BOUNDARIES so a
        # single-member read decompresses one frame, not the whole stream —
        # the ratio/access middle tier between per-file and full solid.
        frame_limit = int((solid_frame_mb or 0) * 1024 * 1024)
        cuts = [0]
        if frame_limit > 0:
            acc = 0
            for fe in files:
                if acc >= frame_limit:
                    cuts.append(fe["offset"])
                    acc = 0
                acc += fe["size"]
        cuts.append(len(stream))
        blob = bytearray()
        frames = []
        for a, b in zip(cuts, cuts[1:]):
            if a == b:
                continue
            comp = _compress_blob(bytes(stream[a:b]), codec)
            frames.append({"raw_offset": a, "raw_size": b - a,
                           "offset": len(blob), "csize": len(comp)})
            blob += comp
        solid_meta = {"raw_size": len(stream), "csize": len(blob), "frames": frames}
    else:
        blob = bytearray()
        for arc, raw in raws:
            sha = hashlib.sha256(raw).hexdigest()
            stored = _compress_blob(raw, codec, dict_data)
            entry = {
                "path": arc, "size": len(raw), "csize": len(stored),
                "sha256": sha, "offset": len(blob),
                "compressed": codec != "store", "codec": codec,
            }
            desc, md = _annotation_for(annotations, arc)
            if desc:
                entry["description"] = desc
            if md:
                entry["metadata"] = md
            files.append(entry)
            blob.extend(stored)
        solid_meta = None
    for arc, gen in gens:
        files.append(_gen_entry(arc, gen))

    uses_v9 = bool(solid_meta) or bool(gens)   # v0.9 features: solid / generative
    manifest = {
        "format": "csf-pack",
        "version": "0.9" if uses_v9 else "0.8",
        "created_at": time.time(),
        "compressed": codec != "store", "codec": codec,
        "file_count": len(files), "files": files,
    }
    if solid_meta:
        manifest["solid"] = solid_meta
    if dict_bytes:
        manifest["shared_dict"] = {"offset": len(blob), "size": len(dict_bytes), "codec": "zstd"}
        blob.extend(dict_bytes)
    if extra_meta:
        manifest.update(extra_meta)
    manifest_bytes = json.dumps(manifest, separators=(",", ":")).encode("utf-8")

    body = bytearray()
    body += MAGIC
    body += struct.pack(">BB", *(SOLID_VERSION if uses_v9 else VERSION))
    body += struct.pack(">H", FLAG_COMPRESSED if codec != "store" else 0)
    body += struct.pack(">I", len(manifest_bytes))
    body += manifest_bytes
    body += blob
    body += hashlib.sha256(bytes(body)).digest()
    body += struct.pack(FOOTER_FMT, len(body) + 8)

    Path(out_path).write_bytes(bytes(body))
    return manifest


def pack(paths: Iterable[str], out_path: str, compress: bool = True,
         codec: str | None = None, use_dict: bool = False,
         annotations: dict | None = None, solid: bool = False,
         solid_frame_mb: float | None = None) -> dict:
    """Pack arbitrary files/dirs into a CSF-Pack archive. Returns the manifest.

    ``annotations`` (optional) attaches a per-file ``description`` and/or
    ``metadata`` to the manifest, keyed by arc_path — the same arc_path the
    reader lists (e.g. ``"README.md"`` for a top-level file, or
    ``"<dir>/<rel>"`` for members of a packed directory).

    ``solid=True`` (cold archives): one compressed stream over all members —
    measured +20–41% over per-file zstd-19 on real multi-file sets; any single
    read decompresses the whole stream. See ``_write_archive``.
    """
    items = ((arc, Path(abs_path).read_bytes()) for abs_path, arc in _iter_files(paths))
    return _write_archive(items, out_path, compress, None, codec=codec,
                          use_dict=use_dict, annotations=annotations, solid=solid,
                          solid_frame_mb=solid_frame_mb)


def pack_blobs(blobs: dict, out_path: str, compress: bool = True, extra_meta: dict | None = None,
               codec: str | None = None, use_dict: bool = False,
               annotations: dict | None = None, solid: bool = False,
               solid_frame_mb: float | None = None) -> dict:
    """Pack in-memory {arc_path: bytes} blobs (e.g. generated manifests). Returns manifest.

    ``annotations`` (optional) attaches a per-file ``description`` and/or
    ``metadata`` to each manifest entry, keyed by arc_path. ``solid=True`` packs
    one compressed stream over all members (cold-archive mode; see pack()).
    """
    return _write_archive(blobs.items(), out_path, compress, extra_meta,
                          codec=codec, use_dict=use_dict, annotations=annotations,
                          solid=solid, solid_frame_mb=solid_frame_mb)


# ---------------------------------------------------------------------------
# Read / verify / unpack
# ---------------------------------------------------------------------------

def _read_container(archive: str):
    data = Path(archive).read_bytes()
    if data[:4] != MAGIC:
        raise ValueError(f"not a CSF file (magic={data[:4]!r})")
    major, minor = struct.unpack(">BB", data[4:6])
    if (major, minor) not in (VERSION, SOLID_VERSION):
        raise ValueError(
            f"unsupported CSF-Pack version {major}.{minor} "
            f"(need {VERSION[0]}.{VERSION[1]} or {SOLID_VERSION[0]}.{SOLID_VERSION[1]})")
    flags = struct.unpack(">H", data[6:8])[0]
    # Footer integrity FIRST — catch any tampering with a clean error before parsing.
    if len(data) < 52:
        raise ValueError("CSF-Pack too small / truncated")
    stored_digest = data[-40:-8]
    if hashlib.sha256(data[:-40]).digest() != stored_digest:
        raise ValueError("CSF-Pack integrity check failed (footer digest mismatch)")
    mlen = struct.unpack(">I", data[8:12])[0]
    manifest = json.loads(data[12:12 + mlen].decode("utf-8"))
    blob_start = 12 + mlen
    blob_end = len(data) - 40
    return data, manifest, flags, blob_start, blob_end


def _load_shared_dict(data: bytes, manifest: dict, blob_start: int):
    """Return a ZstdCompressionDict for the archive, or None."""
    sd = manifest.get("shared_dict")
    if not sd:
        return None
    if _zstd is None:
        raise RuntimeError("archive has a shared zstd dict but 'zstandard' is not installed")
    start = blob_start + sd["offset"]
    return _zstd.ZstdCompressionDict(data[start:start + sd["size"]])


def _solid_frames(manifest: dict) -> list[dict]:
    """Frame table for a solid archive (single implicit frame for early v0.9 archives)."""
    sm = manifest["solid"]
    return sm.get("frames") or [{"raw_offset": 0, "raw_size": sm["raw_size"],
                                 "offset": 0, "csize": sm["csize"]}]


def _solid_frame_raw(data: bytes, manifest: dict, blob_start: int, fr: dict) -> bytes:
    chunk = data[blob_start + fr["offset"]:blob_start + fr["offset"] + fr["csize"]]
    raw = _decompress_blob(chunk, manifest.get("codec") or DEFAULT_CODEC)
    if len(raw) != fr["raw_size"]:
        raise ValueError("solid frame size mismatch (archive corrupt)")
    return raw


def _solid_stream(data: bytes, manifest: dict, blob_start: int) -> bytes:
    """Decompress a solid archive's full stream (all frames, in order)."""
    parts = [_solid_frame_raw(data, manifest, blob_start, fr)
             for fr in _solid_frames(manifest)]
    raw = b"".join(parts)
    if len(raw) != manifest["solid"]["raw_size"]:
        raise ValueError("solid stream size mismatch (archive corrupt)")
    return raw


def _solid_member_raw(fe: dict, data: bytes, manifest: dict, blob_start: int) -> bytes:
    """Materialize ONE member of a solid archive by decompressing only the frames
    that cover it (frames are cut at member boundaries, so normally exactly one)."""
    lo, hi = fe["offset"], fe["offset"] + fe["size"]
    out = bytearray()
    for fr in _solid_frames(manifest):
        a, b = fr["raw_offset"], fr["raw_offset"] + fr["raw_size"]
        if b <= lo or a >= hi:
            continue
        raw = _solid_frame_raw(data, manifest, blob_start, fr)
        out += raw[max(lo - a, 0):max(min(hi, b) - a, 0)]
    if len(out) != fe["size"]:
        raise ValueError(f"solid member reconstruction mismatch for {fe['path']}")
    return bytes(out)


def list_archive(archive: str) -> dict:
    """Return the manifest without extracting."""
    _, manifest, _, _, _ = _read_container(archive)
    return manifest


def file_annotation(archive: str, arc_path: str) -> dict:
    """Return ``{"description": str|None, "metadata": dict|None}`` for one member.

    Raises ``KeyError`` if the member is absent. Both values are ``None`` for
    members packed without annotations (older archives, or files not annotated).
    """
    _, manifest, _, _, _ = _read_container(archive)
    for fe in manifest["files"]:
        if fe["path"] == arc_path:
            return {"description": fe.get("description"), "metadata": fe.get("metadata")}
    raise KeyError(arc_path)


def annotations(archive: str) -> dict:
    """Return the archive's grounding index: ``{arc_path: {"description", "metadata"}}``
    for every member that carries a description or metadata. Members packed
    without annotations are omitted, so an un-annotated archive yields ``{}``."""
    _, manifest, _, _, _ = _read_container(archive)
    out = {}
    for fe in manifest["files"]:
        desc = fe.get("description")
        md = fe.get("metadata")
        if desc or md:
            out[fe["path"]] = {"description": desc, "metadata": md}
    return out


def _member_raw(fe: dict, data: bytes, blob_start: int, dict_data, stream: bytes | None) -> bytes:
    """Decode + sha-verify one member from any layout (per-file / solid / generative)."""
    if fe.get("generator"):
        raw = materialize_generator(fe["generator"])   # recomputation-as-decompression
    elif stream is not None:
        raw = stream[fe["offset"]:fe["offset"] + fe["size"]]
    else:
        start = blob_start + fe["offset"]
        chunk = data[start:start + fe["csize"]]
        raw = _decompress_blob(chunk, _file_codec(fe), dict_data)
    if hashlib.sha256(raw).hexdigest() != fe["sha256"]:
        raise ValueError(f"checksum mismatch for {fe['path']}")
    return raw


def read_file(archive: str, arc_path: str) -> bytes:
    """Read and verify a single member by path (codec-, dict-, solid-, and
    generator-aware).

    Solid archives decompress only the frame(s) covering the member (framed
    solid: one frame; unframed early-v0.9: the whole stream — the documented
    cold-archive trade). Per-file layout stays the hot/random-access choice.
    """
    data, manifest, _flags, blob_start, _blob_end = _read_container(archive)
    fe = next((f for f in manifest["files"] if f["path"] == arc_path), None)
    if fe is None:
        raise KeyError(arc_path)
    if fe.get("generator"):
        raw = materialize_generator(fe["generator"])
    elif manifest.get("solid"):
        raw = _solid_member_raw(fe, data, manifest, blob_start)
    else:
        dict_data = _load_shared_dict(data, manifest, blob_start)
        start = blob_start + fe["offset"]
        raw = _decompress_blob(data[start:start + fe["csize"]], _file_codec(fe), dict_data)
    if hashlib.sha256(raw).hexdigest() != fe["sha256"]:
        raise ValueError(f"checksum mismatch for {arc_path}")
    return raw


def read_slice(archive: str, arc_path: str, offset: int, length: int) -> bytes:
    """Read a window of ONE member without materializing the rest (F1b).

    Cost by layout: generative = **O(window)** (the observer-slice fast path —
    zeros/repeat/sha256-ctr are directly addressable); store = O(window);
    solid = decompress only the covering frame(s); per-file compressed = one
    member decompress (O(member)). Integrity: the manifest (incl. generator
    specs and member hashes) is footer-authenticated at open; slice reads of
    stored bytes come from the same verified container; whole-member sha
    verification remains available via read_file(). Range errors raise
    ValueError; unknown paths raise KeyError.
    """
    if offset < 0 or length < 0:
        raise ValueError("negative slice bounds")
    data, manifest, _flags, blob_start, _blob_end = _read_container(archive)
    fe = next((f for f in manifest["files"] if f["path"] == arc_path), None)
    if fe is None:
        raise KeyError(arc_path)
    if offset + length > fe["size"]:
        raise ValueError("slice out of range")
    if length == 0:
        return b""
    if fe.get("generator"):
        return _gen_slice(fe["generator"], offset, length)
    if manifest.get("solid"):
        lo = fe["offset"] + offset
        hi = lo + length
        out = bytearray()
        for fr in _solid_frames(manifest):
            a, b = fr["raw_offset"], fr["raw_offset"] + fr["raw_size"]
            if b <= lo or a >= hi:
                continue
            raw = _solid_frame_raw(data, manifest, blob_start, fr)
            out += raw[max(lo - a, 0):max(min(hi, b) - a, 0)]
        if len(out) != length:
            raise ValueError(f"solid slice reconstruction mismatch for {arc_path}")
        return bytes(out)
    if _file_codec(fe) == "store":
        start = blob_start + fe["offset"] + offset
        return bytes(data[start:start + length])
    dict_data = _load_shared_dict(data, manifest, blob_start)
    start = blob_start + fe["offset"]
    raw = _decompress_blob(data[start:start + fe["csize"]], _file_codec(fe), dict_data)
    return raw[offset:offset + length]


def unpack(archive: str, dest: str) -> list[str]:
    """Extract all files to dest, verifying per-file sha256. Returns written paths."""
    data, manifest, _flags, blob_start, blob_end = _read_container(archive)
    stream = _solid_stream(data, manifest, blob_start) if manifest.get("solid") else None
    dict_data = None if stream is not None else _load_shared_dict(data, manifest, blob_start)
    dest_path = Path(dest)
    dest_path.mkdir(parents=True, exist_ok=True)
    written = []
    for fe in manifest["files"]:
        raw = _member_raw(fe, data, blob_start, dict_data, stream)
        target = _safe_join(dest_path, fe["path"])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        written.append(str(target))
    return written


def unpack_blobs(archive: str) -> dict:
    """In-memory inverse of pack_blobs: return {arc_path: bytes}, verifying per-file
    sha256. Use when resuming state from an archive without touching the filesystem."""
    data, manifest, _flags, blob_start, _blob_end = _read_container(archive)
    stream = _solid_stream(data, manifest, blob_start) if manifest.get("solid") else None
    dict_data = None if stream is not None else _load_shared_dict(data, manifest, blob_start)
    out = {}
    for fe in manifest["files"]:
        out[fe["path"]] = _member_raw(fe, data, blob_start, dict_data, stream)
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(prog="csf-pack", description="CSF v0.8 — pack/unpack arbitrary files")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("pack", help="pack files/dirs into a .csf archive")
    p.add_argument("paths", nargs="+")
    p.add_argument("-o", "--out", required=True)
    p.add_argument("--no-compress", action="store_true")
    p.add_argument("--codec", choices=["zstd", "zlib", "store", "omni"], default=None,
                   help=f"compression codec (default: {DEFAULT_CODEC}; 'omni' = best-fit, max ratio)")
    p.add_argument("--dict", action="store_true",
                   help="train a shared zstd dictionary across files (keeps per-file random access)")
    p.add_argument("--solid", action="store_true",
                   help="one compressed stream over all members (cold archives; "
                        "best ratio, no per-file random access)")
    p.add_argument("--solid-frame-mb", type=float, default=None,
                   help="with --solid: cut the stream into ~N MiB frames at member "
                        "boundaries (single-member reads decompress one frame)")
    u = sub.add_parser("unpack", help="extract a .csf archive")
    u.add_argument("archive")
    u.add_argument("-d", "--dest", default=".")
    l = sub.add_parser("list", help="list archive contents")
    l.add_argument("archive")
    args = ap.parse_args(argv)

    if args.cmd == "pack":
        m = pack(args.paths, args.out, compress=not args.no_compress,
                 codec=args.codec, use_dict=args.dict, solid=args.solid,
                 solid_frame_mb=args.solid_frame_mb)
        total = sum(f["size"] for f in m["files"])
        stored = m["solid"]["csize"] if m.get("solid") else sum(f["csize"] for f in m["files"])
        dnote = " +dict" if m.get("shared_dict") else (" solid" if m.get("solid") else "")
        print(f"packed {m['file_count']} file(s) -> {args.out}  "
              f"({total} -> {stored} bytes, codec={m['codec']}{dnote})")
    elif args.cmd == "unpack":
        w = unpack(args.archive, args.dest)
        print(f"extracted {len(w)} file(s) -> {args.dest}")
    elif args.cmd == "list":
        m = list_archive(args.archive)
        print(f"CSF-Pack v{m['version']} — {m['file_count']} file(s), "
              f"compressed={m['compressed']}, codec={m.get('codec', 'zlib')}")
        for f in m["files"]:
            line = f"  {f['path']}  {f['size']}B  sha256={f['sha256'][:12]}…"
            if f.get("description"):
                line += f"\n      ↳ {f['description']}"
            print(line)
    return 0


# ── Per-slice Merkle verification (F1b, #2799) ──────────────────────────────────
# read_slice (above) reads a window of one member at O(window). F1b's second half —
# *verifiable partial observation* — needs a slice to be trustable WITHOUT reading the
# whole member's sha256. A member splits into fixed-size leaves; a binary Merkle tree over
# the leaf hashes yields one 32-byte root, computed once (O(member), at index time) and
# small enough for the footer-authenticated manifest or an out-of-band anchor. Then any
# slice verifies at O(window + log n). Domain separation (leaf tag 0x00 / internal 0x01)
# blocks second-preimage/duplicate-node ambiguity; odd nodes carry up unchanged, so tree
# shape is a pure function of the leaf count. Lives here — next to read_slice, its home —
# rather than a separate module, so the CSF read path has one place.

LEAF_TAG = b"\x00"
NODE_TAG = b"\x01"
DEFAULT_LEAF_SIZE = 64 * 1024  # 64 KiB leaves — window granularity of a verified slice
Proof = list  # a list of (sibling_hash, sibling_is_left) steps from a leaf up to the root


def _leaf_hash(chunk: bytes) -> bytes:
    return hashlib.sha256(LEAF_TAG + chunk).digest()


def _node_hash(left: bytes, right: bytes) -> bytes:
    return hashlib.sha256(NODE_TAG + left + right).digest()


def _leaf_hashes(data: bytes, leaf_size: int) -> list:
    if leaf_size <= 0:
        raise ValueError("leaf_size must be positive")
    if not data:
        # One empty leaf, so an empty member still has a well-defined, verifiable root
        # distinct from a single-zero-byte member (domain-separated leaf hash of b"").
        return [_leaf_hash(b"")]
    return [_leaf_hash(data[i:i + leaf_size]) for i in range(0, len(data), leaf_size)]


def _build_levels(leaves: list) -> list:
    """All tree levels bottom→top; levels[-1] == [root]. Odd node carries up unchanged."""
    levels = [list(leaves)]
    while len(levels[-1]) > 1:
        cur = levels[-1]
        nxt = []
        for i in range(0, len(cur) - 1, 2):
            nxt.append(_node_hash(cur[i], cur[i + 1]))
        if len(cur) % 2 == 1:
            nxt.append(cur[-1])  # carry the odd node up unchanged
        levels.append(nxt)
    return levels


def merkle_root(data: bytes, leaf_size: int = DEFAULT_LEAF_SIZE) -> bytes:
    """32-byte Merkle root over `data`'s fixed-size leaves."""
    return _build_levels(_leaf_hashes(data, leaf_size))[-1][0]


def leaf_count(size: int, leaf_size: int = DEFAULT_LEAF_SIZE) -> int:
    return 1 if size <= 0 else (size + leaf_size - 1) // leaf_size


def _proof_for_index(levels: list, index: int) -> list:
    proof = []
    idx = index
    for level in levels[:-1]:
        n = len(level)
        if idx % 2 == 0:
            sib = idx + 1
            if sib < n:                       # right sibling exists
                proof.append((level[sib], False))
            # else: odd node carried up — no proof step, idx stays this position at parent
        else:
            proof.append((level[idx - 1], True))  # left sibling
        idx //= 2
    return proof


def leaf_proof(data: bytes, leaf_index: int, leaf_size: int = DEFAULT_LEAF_SIZE) -> list:
    """Sibling path proving leaf `leaf_index` belongs under the member's root."""
    leaves = _leaf_hashes(data, leaf_size)
    if leaf_index < 0 or leaf_index >= len(leaves):
        raise IndexError(f"leaf {leaf_index} out of range (0..{len(leaves) - 1})")
    return _proof_for_index(_build_levels(leaves), leaf_index)


def verify_leaf(chunk: bytes, leaf_index: int, leaf_total: int, proof: list, root: bytes) -> bool:
    """True iff `chunk` is the leaf at `leaf_index` (of `leaf_total`) under `root`.

    O(log n) — never touches the rest of the member. Verification is BOUND to the claimed
    position: the fold direction and which levels carry a sibling are recomputed from
    (leaf_index, leaf_total) — the same walk that built the proof — and cross-checked against
    each step's stored side. So a proof valid for one leaf cannot be replayed to vouch for a
    different index (which, with equal-content leaves, an index-free check would wrongly accept).
    Returns False on any mismatch, including a proof of the wrong length.
    """
    if leaf_index < 0 or leaf_index >= max(leaf_total, 1):
        return False
    h = _leaf_hash(chunk)
    idx, n, pi = leaf_index, max(leaf_total, 1), 0
    while n > 1:
        has_sibling = (idx % 2 == 1) or (idx + 1 < n)
        if has_sibling:
            if pi >= len(proof):
                return False
            sib, sib_is_left = proof[pi]
            pi += 1
            if sib_is_left != (idx % 2 == 1):   # side must match the walk
                return False
            h = _node_hash(sib, h) if sib_is_left else _node_hash(h, sib)
        # else: odd node carried up unchanged — no proof step at this level
        idx //= 2
        n = (n + 1) // 2
    return pi == len(proof) and h == root


def covering_leaves(offset: int, length: int, leaf_size: int = DEFAULT_LEAF_SIZE) -> tuple:
    """(first_leaf, last_leaf) inclusive that a byte range [offset, offset+length) touches."""
    if offset < 0 or length < 0:
        raise ValueError("negative slice bounds")
    if length == 0:
        return (offset // leaf_size, offset // leaf_size)
    return (offset // leaf_size, (offset + length - 1) // leaf_size)


def member_merkle_root(archive: str, arc_path: str, leaf_size: int = DEFAULT_LEAF_SIZE) -> bytes:
    """Compute a member's Merkle root once (reads + verifies the whole member). O(member).

    Do this at index time; store the returned root (manifest field or sidecar) so later slice
    reads verify at O(window) via read_slice_verified without re-reading the member.
    """
    return merkle_root(read_file(archive, arc_path), leaf_size)


def read_slice_verified(archive: str, arc_path: str, offset: int, length: int,
                        root: bytes, leaf_size: int = DEFAULT_LEAF_SIZE) -> bytes:
    """Read [offset, offset+length) of a CSF member and verify it against a trusted `root`.

    Reads the leaf-aligned window covering the slice (via read_slice), checks each covering
    leaf against `root` by its Merkle proof, then returns the requested sub-range. Raises
    ValueError on any verification failure. The `root` must have been computed with the SAME
    `leaf_size` (e.g. via member_merkle_root); it is the caller's trusted anchor.
    """
    manifest = _read_container(archive)[1]
    fe = next((f for f in manifest["files"] if f["path"] == arc_path), None)
    if fe is None:
        raise KeyError(arc_path)
    size = fe["size"]
    if offset < 0 or length < 0 or offset + length > size:
        raise ValueError("slice out of range")

    first, last = covering_leaves(offset, length, leaf_size)
    win_lo = first * leaf_size
    win_hi = min((last + 1) * leaf_size, size)
    window = read_slice(archive, arc_path, win_lo, win_hi - win_lo)

    # Rebuild the leaf hashes from the whole (sha-verified) member to form each covering leaf's
    # proof, then check the covering leaves' bytes against the trusted root.
    whole = read_file(archive, arc_path)
    levels = _build_levels(_leaf_hashes(whole, leaf_size))
    total = len(levels[0])
    if levels[-1][0] != root:
        raise ValueError(f"member root mismatch for {arc_path}: archive does not match trusted root")
    for li in range(first, last + 1):
        chunk = window[(li - first) * leaf_size: (li - first) * leaf_size + leaf_size]
        if not verify_leaf(chunk, li, total, _proof_for_index(levels, li), root):
            raise ValueError(f"leaf {li} of {arc_path} failed Merkle verification")

    return window[offset - win_lo: offset - win_lo + length]


if __name__ == "__main__":
    raise SystemExit(_main())
