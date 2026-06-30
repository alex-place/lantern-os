"""Integrity regression tests over the real data/csf_memory registry.

Context (the bug these tests pin)
---------------------------------
``MemoryRecord.verify()`` recomputes a SHA-256 over canonical JSON and compares
it to the stored ``checksum``. While probing CSF compression we found that
**0 of 373** real records in ``data/csf_memory/raw.jsonl`` passed
``MemoryRecord.from_dict(r).verify()``.

Root cause: those records were written by the Node runtime
(``apps/lantern-garage/lib/trading-memory.js`` / ``trading-news.js``), which
computed the checksum as
``JSON.stringify(payload, Object.keys(payload).sort())``. The array form of
``JSON.stringify`` is a *property allowlist*, not a key sort — so nested
``content.*`` (the actual order/signal/news payload) was excluded from the hash
entirely. That digest matches neither the Python canonical scheme nor the other
JS writer's ``_canonicalJson`` scheme. Three incompatible schemes had grown up:

    python-canonical   json.dumps(payload, sort_keys=True, ensure_ascii=False)   (memory_engine.py)
    js-canonical       recursive key-sort over the whole record                  (csf-memory-writer.js)
    js-trading-legacy  broken JSON.stringify replacer-allowlist                  (old trading-memory.js / trading-news.js)

Decisions encoded here:
* ``verify()`` is NOT on any read/load path (``from_dict``/``read``/``query``
  never re-verify) — so nothing was being silently rejected; the primitive was
  simply dormant. It must not be promoted to a read gate until records are
  re-stamped (``scripts/restamp-csf-memory.js``).
* The JS writers were fixed to use one sound, content-covering scheme.
* These tests guard against silent regression: every on-disk checksum must be
  attributable to a *recognized* scheme (a new incompatible writer or
  corruption => "unknown" => failure), and ``verify()`` must stay correctly
  runtime-local (it must not start falsely passing JS-written records).
"""

import hashlib
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from csf.memory_engine import MemoryRecord, create_trace  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
RAW_REGISTRY = REPO_ROOT / "data" / "csf_memory" / "raw.jsonl"

# Read the whole registry (small) but cap so the test stays fast as it grows.
_SAMPLE_CAP = 5000

_RECORD_FIELDS = {
    "memory_id", "tier", "created_at", "updated_at", "content", "confidence",
    "privacy_scope", "source_surface", "promoted_from", "promotion_chain",
    "cube_partition", "tags", "agents", "checksum", "vector_embedding",
    "keywords", "entities", "metadata", "actor_id", "actor_type",
    "confidence_reasoning", "staleness_signals",
}


def _load_sample():
    if not RAW_REGISTRY.exists():
        pytest.skip(f"no real registry at {RAW_REGISTRY}")
    records = []
    with open(RAW_REGISTRY, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            records.append(json.loads(line))
            if len(records) >= _SAMPLE_CAP:
                break
    if not records:
        pytest.skip("registry is empty")
    return records


# --- Reproductions of every recognized checksum scheme -----------------------
# These let us *attribute* an on-disk checksum to the writer that produced it.
# A record matching none of them is "unknown" => an unrecognized writer or
# corruption => the regression guard fires.

def _py_canonical(record):
    return MemoryRecord.from_dict(record)._compute_checksum()


def _js_number(value):
    # Mirror JS Number.prototype.toString for the values these records carry
    # (1.0 -> "1", 0.75 -> "0.75"). Exotic floats (exponent form) are not
    # expected here; if one appears it will fall through to "unknown", which is
    # the intended loud signal to revisit this classifier.
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value != value:  # NaN -> JSON null
            return "null"
        return str(int(value)) if value.is_integer() else repr(value)
    return None


def _js_scalar(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    return None


def _js_canonical_str(value):
    """Sound JS scheme: recursive key-sort over the whole record."""
    scalar = _js_scalar(value)
    if scalar is not None:
        return scalar
    if isinstance(value, list):
        return "[" + ",".join(_js_canonical_str(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys())
        return "{" + ",".join(
            json.dumps(k, ensure_ascii=False) + ":" + _js_canonical_str(value[k]) for k in keys
        ) + "}"
    return "null"


def _js_canonical(record):
    payload = {k: v for k, v in record.items() if k != "checksum"}
    return hashlib.sha256(_js_canonical_str(payload).encode("utf-8")).hexdigest()


def _js_legacy_str(value, proplist):
    """Broken legacy scheme: JSON.stringify(payload, sortedTopLevelKeys).

    Per ECMAScript, an array replacer is a *PropertyList*: every object (at any
    depth) emits only keys in the list, in list order. So nested content.* keys
    (whose names aren't top-level fields) were dropped from the hash.
    """
    scalar = _js_scalar(value)
    if scalar is not None:
        return scalar
    if isinstance(value, list):
        return "[" + ",".join(_js_legacy_str(v, proplist) for v in value) + "]"
    if isinstance(value, dict):
        parts = [
            json.dumps(k, ensure_ascii=False) + ":" + _js_legacy_str(value[k], proplist)
            for k in proplist if k in value
        ]
        return "{" + ",".join(parts) + "}"
    return "null"


def _js_legacy(record):
    payload = {k: v for k, v in record.items() if k != "checksum"}
    proplist = sorted(payload.keys())
    return hashlib.sha256(_js_legacy_str(payload, proplist).encode("utf-8")).hexdigest()


def _classify(record):
    stored = record.get("checksum", "")
    if not stored:
        return "empty"
    if stored == _py_canonical(record):
        return "python-canonical"
    if stored == _js_canonical(record):
        return "js-canonical"
    if stored == _js_legacy(record):
        return "js-trading-legacy"
    return "unknown"


# --- Tests -------------------------------------------------------------------

def test_real_sample_loads_and_is_structurally_sound():
    """Every real record parses, round-trips, and carries a full 64-hex stamp."""
    for record in _load_sample():
        # Full canonical field set — guards silent schema drift.
        assert set(record.keys()) == _RECORD_FIELDS, (
            f"field drift in {record.get('memory_id')}: "
            f"{set(record.keys()) ^ _RECORD_FIELDS}"
        )
        # from_dict must not raise (enum coercion, types).
        rec = MemoryRecord.from_dict(record)
        assert rec.memory_id == record["memory_id"]
        # raw.jsonl records are always written with a stamp.
        chk = record["checksum"]
        assert chk and len(chk) == 64 and all(c in "0123456789abcdef" for c in chk), (
            f"{record['memory_id']} has a non-hex/empty checksum: {chk!r}"
        )


def test_every_record_matches_a_recognized_checksum_scheme():
    """The core anti-regression guard.

    Every on-disk checksum must be attributable to a known writer scheme. A
    record landing in "unknown" means a new incompatible writer was introduced
    (the original bug) or the file was corrupted — either way, fail loudly.
    """
    sample = _load_sample()
    buckets = {}
    for record in sample:
        buckets.setdefault(_classify(record), []).append(record.get("memory_id"))

    unknown = buckets.get("unknown", [])
    assert not unknown, (
        f"{len(unknown)} record(s) use an unrecognized checksum scheme "
        f"(new incompatible writer or corruption): {unknown[:5]}"
    )
    # Sanity: the sample is actually attributed to known schemes, not all empty.
    recognized = sum(
        len(v) for k, v in buckets.items() if k in
        {"python-canonical", "js-canonical", "js-trading-legacy"}
    )
    assert recognized > 0


def test_verify_stays_runtime_local_and_does_not_falsely_pass():
    """verify() must not bless JS-written records under the Python scheme.

    JS-authored records (js-canonical / js-trading-legacy) must return False
    from the Python verify() — confirming the runtime-local contract and that
    no one has quietly loosened verify() to paper over the divergence. (After a
    re-stamp migration the scheme flips js-trading-legacy -> js-canonical, but
    it stays JS and still must not verify in Python.)
    """
    for record in _load_sample():
        scheme = _classify(record)
        if scheme in {"js-canonical", "js-trading-legacy"}:
            assert MemoryRecord.from_dict(record).verify() is False, (
                f"{record.get('memory_id')} ({scheme}) unexpectedly verified "
                f"under the Python canonical scheme"
            )


def test_python_written_record_round_trips_and_verifies():
    """A record stamped by the Python writer verifies and classifies cleanly."""
    rec = create_trace("integrity probe", "sess_integrity", keywords=["probe"])
    assert rec.verify() is True
    assert _classify(rec.to_dict()) == "python-canonical"
