"""#2092 — pin that the CSF *active* codec matches its advertised claim.

The public API docstring advertises `zstd-19+LDM` (src/csf/__init__.py:12). ARCHITECTURE.md §9.3
previously flagged that the active path might silently bottleneck on zlib. These tests are the
regression that keeps the claim honest: when `zstandard` is importable (it is a declared
dependency, requirements.txt), the default codec IS zstd at level 19, and a packed archive
actually records `codec="zstd"` for its members — proving the hot write path runs the advertised
codec, not a silent zlib fallback. They also assert zstd-19 beats zlib-9 on JSONL-like data, so
"no substantial ratio left on the table" stays measured, not asserted from memory.
"""
import tempfile
from pathlib import Path

import pytest

from csf import csf_pack, read_file
from csf.csf_pack import DEFAULT_CODEC, ZSTD_LEVEL, _compress_blob, pack_blobs

_HAS_ZSTD = getattr(csf_pack, "_zstd", None) is not None

# A JSONL-shaped corpus with long-range repetition DEFLATE's 32 KB window can't fully exploit.
_CORPUS = b"".join(
    b'{"tier":"trace","session_id":"s%d","text":"the lantern remembers the well and the codeword"}\n' % i
    for i in range(4000)
)


@pytest.mark.skipif(not _HAS_ZSTD, reason="zstandard not installed in this env")
def test_default_codec_is_zstd_19_when_zstandard_present():
    assert DEFAULT_CODEC == "zstd"
    assert ZSTD_LEVEL == 19


@pytest.mark.skipif(not _HAS_ZSTD, reason="zstandard not installed in this env")
def test_packed_archive_records_zstd_codec_not_silent_zlib():
    """The hot write path must actually emit zstd — a manifest saying codec='zstd' is the proof
    the advertised codec ran, not a zlib fallback masquerading under the same API."""
    with tempfile.TemporaryDirectory() as tmp:
        out = str(Path(tmp) / "a.csf")
        manifest = pack_blobs({"mem.jsonl": _CORPUS}, out)              # default codec
        assert manifest["codec"] == "zstd"
        assert manifest["compressed"] is True
        for fe in manifest["files"]:
            assert fe.get("codec", "zstd") == "zstd"
        # and the zstd-packed member round-trips losslessly through the reader
        assert read_file(out, "mem.jsonl") == _CORPUS


@pytest.mark.skipif(not _HAS_ZSTD, reason="zstandard not installed in this env")
def test_zstd_19_beats_zlib_9_on_jsonl():
    """The advertised ratio advantage is real, not left on the table (ARCHITECTURE §9.3, #2092)."""
    zlib_sz = len(_compress_blob(_CORPUS, "zlib"))
    zstd_sz = len(_compress_blob(_CORPUS, "zstd"))
    assert zstd_sz < zlib_sz                     # zstd-19 strictly wins on this corpus
    assert zstd_sz < len(_CORPUS)                # and it actually compresses


if __name__ == "__main__":
    import sys
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"  ok  - {fn.__name__}")
        except Exception as e:
            failed += 1
            print(f"  FAIL- {fn.__name__}: {e}")
    print(f"\n{'all passed' if not failed else str(failed)+' FAILED'} ({len(fns)} tests)")
    sys.exit(1 if failed else 0)
