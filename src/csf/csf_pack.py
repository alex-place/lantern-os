"""
CSF-Pack (CSF v0.8) — general-purpose archive: pack & unpack ARBITRARY files.

Unlike the symbolic CSF formats (v0.3 `csf_file.py`, v0.7 engine) which encode
world-model memory, CSF-Pack is a plain container for any bytes — the Σ₀ release
that can wrap arbitrary files (code, data, models) with per-file hashing,
per-file compression (zstd by default, zlib fallback), and an integrity footer.

Codec (R1/R2 upgrade)
---------------------
Each file records its `codec` ("zstd" | "zlib" | "store"). The default is
**zstd-19 + long-distance matching** when the `zstandard` package is available,
falling back to **zlib-9** otherwise. DEFLATE's 32 KB window cannot capture the
long-range repetition in JSONL memory logs / large blobs; zstd's large window
does, measured ~25-30x smaller on real append-only memory (see
`experiments/csf_compression_benchmark.py`).

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
      "files": [{"path", "size", "csize", "sha256", "offset", "compressed", "codec"}]
    }

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

try:
    import zstandard as _zstd
except Exception:  # pragma: no cover - environment without zstandard
    _zstd = None

MAGIC = b"CSF\x00"
VERSION = (0, 8)
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
    raise ValueError(f"unknown codec: {codec!r}")


def _file_codec(fe: dict) -> str:
    """Resolve a file entry's codec, defaulting for pre-codec (legacy) archives."""
    codec = fe.get("codec")
    if codec:
        return codec
    return "zlib" if fe.get("compressed") else "store"


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

def _write_archive(items, out_path: str, compress: bool, extra_meta: dict | None,
                   codec: str | None = None, use_dict: bool = False) -> dict:
    """Core writer. items = iterable of (arc_path, raw_bytes)."""
    if not compress:
        codec = "store"
    elif codec is None:
        codec = DEFAULT_CODEC

    raws = [(arc, raw) for arc, raw in items]

    dict_data = None
    dict_bytes = b""
    if use_dict and codec == "zstd":
        dict_data = _train_dict([raw for _, raw in raws])
        if dict_data is not None:
            dict_bytes = dict_data.as_bytes()

    files, blob = [], bytearray()
    for arc, raw in raws:
        sha = hashlib.sha256(raw).hexdigest()
        stored = _compress_blob(raw, codec, dict_data)
        files.append({
            "path": arc, "size": len(raw), "csize": len(stored),
            "sha256": sha, "offset": len(blob),
            "compressed": codec != "store", "codec": codec,
        })
        blob.extend(stored)

    manifest = {
        "format": "csf-pack", "version": "0.8", "created_at": time.time(),
        "compressed": codec != "store", "codec": codec,
        "file_count": len(files), "files": files,
    }
    if dict_bytes:
        manifest["shared_dict"] = {"offset": len(blob), "size": len(dict_bytes), "codec": "zstd"}
        blob.extend(dict_bytes)
    if extra_meta:
        manifest.update(extra_meta)
    manifest_bytes = json.dumps(manifest, separators=(",", ":")).encode("utf-8")

    body = bytearray()
    body += MAGIC
    body += struct.pack(">BB", *VERSION)
    body += struct.pack(">H", FLAG_COMPRESSED if codec != "store" else 0)
    body += struct.pack(">I", len(manifest_bytes))
    body += manifest_bytes
    body += blob
    body += hashlib.sha256(bytes(body)).digest()
    body += struct.pack(FOOTER_FMT, len(body) + 8)

    Path(out_path).write_bytes(bytes(body))
    return manifest


def pack(paths: Iterable[str], out_path: str, compress: bool = True,
         codec: str | None = None, use_dict: bool = False) -> dict:
    """Pack arbitrary files/dirs into a CSF-Pack archive. Returns the manifest."""
    items = ((arc, Path(abs_path).read_bytes()) for abs_path, arc in _iter_files(paths))
    return _write_archive(items, out_path, compress, None, codec=codec, use_dict=use_dict)


def pack_blobs(blobs: dict, out_path: str, compress: bool = True, extra_meta: dict | None = None,
               codec: str | None = None, use_dict: bool = False) -> dict:
    """Pack in-memory {arc_path: bytes} blobs (e.g. generated manifests). Returns manifest."""
    return _write_archive(blobs.items(), out_path, compress, extra_meta,
                          codec=codec, use_dict=use_dict)


# ---------------------------------------------------------------------------
# Read / verify / unpack
# ---------------------------------------------------------------------------

def _read_container(archive: str):
    data = Path(archive).read_bytes()
    if data[:4] != MAGIC:
        raise ValueError(f"not a CSF file (magic={data[:4]!r})")
    major, minor = struct.unpack(">BB", data[4:6])
    if (major, minor) != VERSION:
        raise ValueError(f"unsupported CSF-Pack version {major}.{minor} (need {VERSION[0]}.{VERSION[1]})")
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


def list_archive(archive: str) -> dict:
    """Return the manifest without extracting."""
    _, manifest, _, _, _ = _read_container(archive)
    return manifest


def read_file(archive: str, arc_path: str) -> bytes:
    """Read and verify a single member by path (codec-aware, dict-aware)."""
    data, manifest, _flags, blob_start, _blob_end = _read_container(archive)
    dict_data = _load_shared_dict(data, manifest, blob_start)
    for fe in manifest["files"]:
        if fe["path"] == arc_path:
            start = blob_start + fe["offset"]
            chunk = data[start:start + fe["csize"]]
            raw = _decompress_blob(chunk, _file_codec(fe), dict_data)
            if hashlib.sha256(raw).hexdigest() != fe["sha256"]:
                raise ValueError(f"checksum mismatch for {arc_path}")
            return raw
    raise KeyError(arc_path)


def unpack(archive: str, dest: str) -> list[str]:
    """Extract all files to dest, verifying per-file sha256. Returns written paths."""
    data, manifest, _flags, blob_start, blob_end = _read_container(archive)
    dict_data = _load_shared_dict(data, manifest, blob_start)
    dest_path = Path(dest)
    dest_path.mkdir(parents=True, exist_ok=True)
    written = []
    for fe in manifest["files"]:
        start = blob_start + fe["offset"]
        chunk = data[start:start + fe["csize"]]
        raw = _decompress_blob(chunk, _file_codec(fe), dict_data)
        if hashlib.sha256(raw).hexdigest() != fe["sha256"]:
            raise ValueError(f"checksum mismatch for {fe['path']}")
        target = _safe_join(dest_path, fe["path"])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        written.append(str(target))
    return written


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
    p.add_argument("--codec", choices=["zstd", "zlib", "store"], default=None,
                   help=f"compression codec (default: {DEFAULT_CODEC})")
    p.add_argument("--dict", action="store_true",
                   help="train a shared zstd dictionary across files (keeps per-file random access)")
    u = sub.add_parser("unpack", help="extract a .csf archive")
    u.add_argument("archive")
    u.add_argument("-d", "--dest", default=".")
    l = sub.add_parser("list", help="list archive contents")
    l.add_argument("archive")
    args = ap.parse_args(argv)

    if args.cmd == "pack":
        m = pack(args.paths, args.out, compress=not args.no_compress,
                 codec=args.codec, use_dict=args.dict)
        total = sum(f["size"] for f in m["files"])
        stored = sum(f["csize"] for f in m["files"])
        dnote = " +dict" if m.get("shared_dict") else ""
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
            print(f"  {f['path']}  {f['size']}B  sha256={f['sha256'][:12]}…")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
