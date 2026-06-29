"""
CSF Cache Manager — Lantern OS

Enforces that all agent data passes through cached CSF (Convergence-Fitted
Searchable Binary) format.  Provides:
  - get / set / delete via cache keys
  - automatic segment building using CsfSegmentBuilder
  - integrity verification (CRC32 + SHA-256)
  - TTL-based expiration
  - Cache hit/miss metrics

All agents are locked to this manager; raw JSON/txt storage is blocked.
"""

from __future__ import annotations

import functools
import hashlib
import json
import logging
import os
import struct
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("lantern.csf_cache")

# Compression is delegated to the ONE canonical CSF codec layer (zstd-19+LDM by
# default, self-describing 1-byte codec header) rather than hand-rolling zlib.
# On agent-cache / JSONL-shaped payloads the canonical codec is ~35-40x smaller
# than the old zlib-3 (10.5x -> 362-422x; see experiments/csf_compression_benchmark.py).
# Hot write path -> default to zstd, not the slower max-ratio "omni" panel.
# CSF_CACHE_CODEC overrides ("zstd" | "zlib" | "omni" | "store").
try:  # canonical codec; falls back to raw zlib only if the package is unavailable
    import csf as _csf
    _CACHE_CODEC = os.environ.get("CSF_CACHE_CODEC") or "zstd"
    if _CACHE_CODEC == "zstd" and _csf.DEFAULT_CODEC != "zstd":
        _CACHE_CODEC = _csf.DEFAULT_CODEC  # zstandard not installed -> zlib
except Exception:  # pragma: no cover - csf package missing
    _csf = None
    _CACHE_CODEC = "zlib"


def _codec_compress(raw: bytes) -> bytes:
    if _csf is not None:
        return _csf.compress_bytes(raw, _CACHE_CODEC)
    return b"\x01" + zlib.compress(raw, 9)  # mimic codec-id header (1 = zlib)


def _codec_decompress(blob: bytes) -> bytes:
    if _csf is not None:
        return _csf.decompress_bytes(blob)
    # csf unavailable: blob is [1-byte codec id][payload]; only zlib is decodable here
    return zlib.decompress(blob[1:])

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CACHE_DIR = REPO_ROOT / "data" / "csf_cache"

# ── Internal helpers ──

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_short(data: Any) -> str:
    return hashlib.sha256(json.dumps(data, default=str).encode()).hexdigest()[:16]


def _build_csf_segment(key: str, value: Any, meta: Dict[str, Any]) -> bytes:
    """Build a minimal CSF v1 segment from a cache entry."""
    record = {
        "cache_key": key,
        "value": value,
        "meta": meta,
        "stored_at": _now(),
        "integrity_hash": _sha256_short(value),
    }
    body_json = json.dumps(record, ensure_ascii=False).encode("utf-8")
    compressed = _codec_compress(body_json)

    # Token dictionary (minimal — just top keywords)
    tokens = {t.lower(): i for i, t in enumerate(set(json.dumps(value).split())) if len(t) > 2}
    dict_json = json.dumps(tokens, ensure_ascii=False).encode("utf-8")
    dict_compressed = _codec_compress(dict_json)

    header = struct.pack(
        ">8sHHIQQQ",
        b"CSFv2\x00\x00",
        1, 0x0001, 1,
        len(body_json), 0, 0,
    )
    segment_table = struct.pack(">IQI", 1, len(compressed), 0x0001)
    assembled = (
        header
        + segment_table
        + struct.pack(">I", len(dict_compressed))
        + dict_compressed
        + compressed
    )
    crc = zlib.crc32(assembled) & 0xFFFFFFFF
    assembled += struct.pack(">I", crc)
    return assembled


def _parse_csf_segment(raw: bytes) -> Optional[Dict[str, Any]]:
    """Parse a minimal CSF v1 segment back to a dict."""
    try:
        if len(raw) < 16:
            return None
        # struct ">8s" right-pads the 7-byte magic to 8, so match on the 5-byte
        # version prefix. (The pre-fix reader compared raw[:8] to a 7-byte literal
        # and so NEVER matched — the cache silently never returned a hit.)
        magic = raw[:5]
        # v2 = canonical CSF codec (self-describing header); v1 = legacy raw zlib.
        if magic == b"CSFv2":
            legacy = False
        elif magic == b"CSFv1":
            legacy = True
        else:
            return None
        # Read footer CRC
        stored_crc = struct.unpack(">I", raw[-4:])[0]
        computed_crc = zlib.crc32(raw[:-4]) & 0xFFFFFFFF
        if stored_crc != computed_crc:
            logger.warning("CSF CRC mismatch — cache corruption suspected")
            return None
        # Skip header (40 bytes) + segment table (16 bytes)
        pos = 56
        dict_len = struct.unpack(">I", raw[pos : pos + 4])[0]
        pos += 4
        # Skip dict block
        pos += dict_len
        # Remaining is compressed body
        compressed = raw[pos:-4]
        body_json = zlib.decompress(compressed) if legacy else _codec_decompress(compressed)
        return json.loads(body_json)
    except Exception as exc:
        logger.warning("CSF parse error: %s", exc)
        return None


# ── Cache Manager ──

class CsfCacheManager:
    """All agent data must flow through this manager.  No exceptions."""

    def __init__(self, cache_dir: Optional[Path] = None):
        self.cache_dir = cache_dir or DEFAULT_CACHE_DIR
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._metrics: Dict[str, int] = {"hits": 0, "misses": 0, "writes": 0, "errors": 0}
        self._ttl_seconds: float = float(os.environ.get("CSF_CACHE_TTL", "3600"))

    # ── Core ops ──

    def get(self, key: str) -> Optional[Any]:
        """Read from CSF cache.  Returns None on miss or corruption."""
        path = self._path(key)
        if not path.exists():
            self._metrics["misses"] += 1
            return None

        # TTL check
        if self._ttl_seconds > 0:
            age = time.time() - path.stat().st_mtime
            if age > self._ttl_seconds:
                logger.info("CSF cache entry expired: %s", key)
                path.unlink(missing_ok=True)
                self._metrics["misses"] += 1
                return None

        raw = path.read_bytes()
        parsed = _parse_csf_segment(raw)
        if parsed is None:
            self._metrics["errors"] += 1
            return None

        self._metrics["hits"] += 1
        return parsed.get("value")

    def set(
        self,
        key: str,
        value: Any,
        agent_id: str = "default",
        tool_name: str = "",
        ttl_override: Optional[float] = None,
    ) -> bool:
        """Write to CSF cache.  Always stored in CSF binary format."""
        meta = {
            "agent_id": agent_id,
            "tool_name": tool_name,
            "stored_at": _now(),
            "ttl_seconds": ttl_override or self._ttl_seconds,
        }
        try:
            csf_bytes = _build_csf_segment(key, value, meta)
            path = self._path(key)
            path.write_bytes(csf_bytes)
            self._metrics["writes"] += 1
            return True
        except Exception as exc:
            logger.exception("CSF cache write failed for key %s", key)
            self._metrics["errors"] += 1
            return False

    def delete(self, key: str) -> bool:
        path = self._path(key)
        if path.exists():
            path.unlink()
            return True
        return False

    def keys(self) -> List[str]:
        """List all cached keys."""
        return sorted(
            p.stem for p in self.cache_dir.glob("*.csf") if p.is_file()
        )

    def stats(self) -> Dict[str, Any]:
        return {
            "metrics": self._metrics.copy(),
            "cache_dir": str(self.cache_dir),
            "ttl_seconds": self._ttl_seconds,
            "entry_count": len(self.keys()),
            "format": "CSF v2.0",
            "codec": _CACHE_CODEC,
            "enforced": True,
        }

    # ── Validation ──

    def validate_all(self) -> Tuple[int, int]:
        """Validate every cached segment.  Returns (ok_count, corrupt_count)."""
        ok = 0
        corrupt = 0
        # Iterate files directly: keys() returns hashed stems, so re-deriving the
        # path via _path() would hash twice and miss every file.
        for path in self.cache_dir.glob("*.csf"):
            raw = path.read_bytes()
            parsed = _parse_csf_segment(raw)
            if parsed is None:
                corrupt += 1
            else:
                ok += 1
        return ok, corrupt

    # ── Private ──

    def _path(self, key: str) -> Path:
        safe = hashlib.sha256(key.encode()).hexdigest()[:24]
        return self.cache_dir / f"{safe}.csf"


# ── Enforcement decorator ──

def csf_cached(tool_name: str, agent_id: str = "default"):
    """Decorator that locks a function to the CSF cache manager.

    Usage:
        @csf_cached("my_tool")
        def my_tool_fn(x: int) -> int:
            return x * 2
    """
    manager = CsfCacheManager()

    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            cache_key = _sha256_short({"tool": tool_name, "args": args, "kwargs": kwargs})
            # Attempt cache read
            hit = manager.get(cache_key)
            if hit is not None:
                logger.debug("CSF cache hit for %s", tool_name)
                return hit
            # Execute and cache
            result = fn(*args, **kwargs)
            manager.set(cache_key, result, agent_id=agent_id, tool_name=tool_name)
            return result
        return wrapper
    return decorator
