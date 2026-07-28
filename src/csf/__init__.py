"""CSF — Convergence-Fitted Searchable Binary Archive (canonical v2).

ONE format. CSF is a lossless, zstd-backed container with per-file SHA-256
hashing, path-traversal safety, and a footer integrity check. The engine lives
in :mod:`csf.csf_pack`; this package root is its stable public API.

Quick start
-----------
    import csf

    # whole-archive (files or in-memory blobs), per-file integrity:
    csf.pack(["docs", "README.md"], "out.csf")          # default codec = zstd-19+LDM
    csf.unpack("out.csf", "dest/")
    data = csf.read_file("out.csf", "README.md")         # verified single member

    # lightweight single-blob stream (no manifest/integrity):
    blob = csf.compress(b"...")                           # 1-byte codec header + payload
    raw  = csf.decompress(blob)

Design notes
------------
* Default codec is **zstd-19 + long-distance matching** when ``zstandard`` is
  available, else **zlib-9**. Per-file ``codec`` makes archives self-describing
  and backward-readable (a missing codec reads as zlib).
* ``pack(..., use_dict=True)`` trains one shared zstd dictionary across files to
  recover cross-file redundancy while keeping per-file random access.
* The lossy "symbolic" text compressors and the legacy segmented/v0.3 writers
  were **removed** in the v2 consolidation. Existing on-disk archives still open
  read-only via :mod:`csf.legacy`. See ``docs/CSF-FORMAT-SPECIFICATION.md``.

The 3¹² lattice / Tesseract "storage face" primitives (``csf.v07.quantum_dust``,
``csf.v07.qutrit_delta``) are unchanged — CSF stores a point on that lattice; it
is not itself the lattice. See ``docs/TESSERACT-CSF-SINGULARITY.md``.
"""

from __future__ import annotations

from . import csf_pack, legacy
from .csf_pack import (
    DEFAULT_CODEC,
    MAGIC,
    VERSION,
    ZSTD_LEVEL,
    annotations,
    compress_bytes,
    compress_bytes as compress,        # friendly aliases
    decompress_bytes,
    decompress_bytes as decompress,
    file_annotation,
    list_archive,
    pack,
    pack_blobs,
    read_file,
    read_slice,
    read_slice_verified,
    member_merkle_root,
    merkle_root,
    verify_leaf,
    leaf_proof,
    unpack,
)

__all__ = [
    "pack",
    "pack_blobs",
    "unpack",
    "read_slice",
    "read_slice_verified",
    "member_merkle_root",
    "merkle_root",
    "verify_leaf",
    "leaf_proof",
    "list_archive",
    "read_file",
    "file_annotation",
    "annotations",
    "compress",
    "decompress",
    "compress_bytes",
    "decompress_bytes",
    "legacy",
    "csf_pack",
    "DEFAULT_CODEC",
    "ZSTD_LEVEL",
    "MAGIC",
    "VERSION",
]

__version__ = (2, 0, 0)
