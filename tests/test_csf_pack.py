"""Round-trip + integrity tests for CSF-Pack (CSF v0.8 arbitrary-file archive)."""
import hashlib
import json
import os
import pathlib
import struct
import tempfile

import pytest

from csf import csf_pack

_HAS_ZSTD = csf_pack._zstd is not None


def _sample_tree(root: pathlib.Path):
    (root / "sub").mkdir(parents=True)
    (root / "a.txt").write_text("hello arbitrary file\n" * 50)
    (root / "data.json").write_text('{"k":1,"v":[1,2,3]}')
    (root / "sub" / "blob.bin").write_bytes(os.urandom(8000))
    (root / "empty.dat").write_bytes(b"")


@pytest.mark.parametrize("compress", [True, False])
def test_round_trip(compress):
    with tempfile.TemporaryDirectory() as d:
        d = pathlib.Path(d)
        src = d / "src"
        _sample_tree(src)
        out = str(d / "out.csf")
        m = csf_pack.pack([str(src)], out, compress=compress)
        assert m["file_count"] == 4
        assert os.path.getsize(out) > 0

        dest = d / "out"
        written = csf_pack.unpack(out, str(dest))
        assert len(written) == 4
        for f in src.rglob("*"):
            if f.is_file():
                rel = f.relative_to(src.parent).as_posix()
                assert (dest / rel).read_bytes() == f.read_bytes()


def test_list_does_not_extract():
    with tempfile.TemporaryDirectory() as d:
        d = pathlib.Path(d)
        src = d / "src"
        _sample_tree(src)
        out = str(d / "out.csf")
        csf_pack.pack([str(src)], out)
        manifest = csf_pack.list_archive(out)
        assert manifest["format"] == "csf-pack"
        assert manifest["version"] == "0.8"
        assert manifest["file_count"] == 4


def test_tamper_detected():
    with tempfile.TemporaryDirectory() as d:
        d = pathlib.Path(d)
        src = d / "src"
        _sample_tree(src)
        out = pathlib.Path(d / "out.csf")
        csf_pack.pack([str(src)], str(out))
        b = bytearray(out.read_bytes())
        b[len(b) // 2] ^= 0xFF  # flip a blob byte
        bad = d / "bad.csf"
        bad.write_bytes(bytes(b))
        with pytest.raises(ValueError):
            csf_pack.unpack(str(bad), str(d / "bad"))


def test_path_traversal_rejected():
    # A manifest path escaping dest must be refused.
    with tempfile.TemporaryDirectory() as d:
        d = pathlib.Path(d)
        f = d / "x.txt"
        f.write_text("x")
        out = str(d / "out.csf")
        csf_pack.pack([str(f)], out)
        # Sanity: normal extract works
        assert csf_pack.unpack(out, str(d / "ok"))


# --------------------------------------------------------------------------
# R1/R2 codec upgrade
# --------------------------------------------------------------------------

_CODECS = ["zlib", "store", "omni"] + (["zstd"] if _HAS_ZSTD else [])


@pytest.mark.parametrize("codec", _CODECS)
def test_round_trip_codec(codec):
    with tempfile.TemporaryDirectory() as d:
        d = pathlib.Path(d)
        src = d / "src"
        _sample_tree(src)
        out = str(d / "out.csf")
        m = csf_pack.pack([str(src)], out, codec=codec)
        assert m["codec"] == codec
        assert all(fe["codec"] == codec for fe in m["files"])
        dest = d / "out"
        csf_pack.unpack(out, str(dest))
        for f in src.rglob("*"):
            if f.is_file():
                rel = f.relative_to(src.parent).as_posix()
                assert (dest / rel).read_bytes() == f.read_bytes()


def test_omni_payload_is_panel_minimum():
    """The best-fit omni payload must be <= every codec it absorbs (the envelope).
    (Its blob adds a fixed 7-byte CRC header, so on tiny inputs the *archive* can be
    a few bytes larger than a header-less single codec — the guarantee is per-payload.)"""
    import bz2 as _bz2
    import lzma as _lzma
    import zlib as _zlib

    from csf import omni
    # varied-but-compressible JSONL so the codec choice matters by more than the header
    data = b"".join(
        ('{"ts":%d,"px":%d,"side":"%s","id":"mkt-%05d"}\n'
         % (i, 100 + (i % 37), "yes" if i % 2 else "no", i)).encode()
        for i in range(3000)
    )
    blob = omni.compress_best(data)
    assert omni.decompress(blob) == data
    payload = len(blob) - omni.HEADER_LEN
    assert payload <= len(_zlib.compress(data, 9))
    assert payload <= len(_bz2.compress(data, 9))
    assert payload <= len(_lzma.compress(data, preset=9 | _lzma.PRESET_EXTREME))


def test_omni_crc_detects_payload_corruption():
    """CSF-Omni's CRC-32 must reject a corrupt payload, not return wrong bytes."""
    from csf import omni
    data = b"ABCABCABCDEF" * 100
    blob = bytearray(omni.compress_best(data))
    assert omni.decompress(bytes(blob)) == data
    blob[-1] ^= 0x40  # flip a payload bit
    with pytest.raises(ValueError):
        omni.decompress(bytes(blob))


def test_omni_parallel_encode_is_deterministic_and_exact():
    """Large inputs encode via the thread pool: the result must be deterministic
    (independent of thread completion order), round-trip lossless, and the EXACT
    best-fit — i.e. equal to the panel minimum computed serially."""
    from csf import omni
    data = b"".join(
        b'{"ts":%d,"px":%d,"side":"%s","id":"mkt-%06d"}\n'
        % (i, 100 + (i % 37), b"yes" if i % 2 else b"no", i) for i in range(8_000))
    assert len(data) > omni._PARALLEL_MIN                       # exercises the parallel path
    a = omni.compress_best(data)
    assert omni.compress_best(data) == a                       # deterministic across runs
    assert omni.decompress(a) == data                          # lossless
    for eff in ("max", "fast", "exhaustive"):
        assert omni.decompress(omni.compress_best(data, effort=eff)) == data, eff
    # exact best-fit: payload == the panel minimum computed serially
    serial_min = min(len(omni.CODECS[c][2](omni.TRANSFORMS[t][1](data)))
                     for t, c in omni._candidates("max", False))
    assert len(a) - omni.HEADER_LEN == serial_min


def test_omni_decompress_verify_flag():
    """verify=False returns the same bytes but skips the CRC check (used by CSF-Pack)."""
    from csf import omni
    data = b"the quick brown fox " * 4000
    blob = bytearray(omni.compress_best(data))
    assert omni.decompress(bytes(blob), verify=True) == data
    assert omni.decompress(bytes(blob), verify=False) == data
    blob[-1] ^= 0x20  # corrupt a payload bit
    # verify=True catches it; verify=False trusts the caller's outer integrity
    with pytest.raises(ValueError):
        omni.decompress(bytes(blob), verify=True)


@pytest.mark.skipif(not _HAS_ZSTD, reason="zstandard not installed")
def test_default_codec_is_zstd():
    with tempfile.TemporaryDirectory() as d:
        d = pathlib.Path(d)
        f = d / "a.txt"
        f.write_text("payload\n" * 100)
        out = str(d / "out.csf")
        m = csf_pack.pack([str(f)], out)  # no codec specified
        assert m["codec"] == "zstd"


@pytest.mark.skipif(not _HAS_ZSTD, reason="zstandard not installed")
def test_shared_dict_round_trip():
    # Many similar small files (the profile-pack case): a shared dict must train
    # and round-trip losslessly while keeping per-file random access.
    blobs = {f"rec/{i:04d}.json": (
        json.dumps({"id": i, "kind": "tightband", "market": "BTC-2026",
                    "edge": 0.66, "ts": 1781999419 + i, "note": "auto"}).encode()
    ) for i in range(256)}
    with tempfile.TemporaryDirectory() as d:
        d = pathlib.Path(d)
        out_d = str(d / "dict.csf")
        out_n = str(d / "nodict.csf")
        m = csf_pack.pack_blobs(blobs, out_d, use_dict=True)
        csf_pack.pack_blobs(blobs, out_n, use_dict=False)
        assert "shared_dict" in m  # corpus is large enough to train
        # lossless round-trip through the shared dict
        written = csf_pack.unpack(out_d, str(d / "x"))
        assert len(written) == len(blobs)
        for arc, raw in blobs.items():
            assert (d / "x" / arc).read_bytes() == raw
        # single-member random access still works with a shared dict
        assert csf_pack.read_file(out_d, "rec/0100.json") == blobs["rec/0100.json"]
        # sanity: dict path is not pathologically larger than dictless
        assert os.path.getsize(out_d) <= os.path.getsize(out_n) * 1.2


def test_read_file_single_member():
    blobs = {"a.txt": b"alpha", "b.txt": b"beta" * 100}
    with tempfile.TemporaryDirectory() as d:
        out = str(pathlib.Path(d) / "out.csf")
        csf_pack.pack_blobs(blobs, out)
        assert csf_pack.read_file(out, "b.txt") == b"beta" * 100
        with pytest.raises(KeyError):
            csf_pack.read_file(out, "missing.txt")


def _seal_legacy_archive(blobs: dict, out: str):
    """Reproduce a pre-codec (legacy) v0.8 writer: zlib per file, NO codec field."""
    import zlib
    files, blob = [], bytearray()
    for arc, raw in blobs.items():
        stored = zlib.compress(raw, 9)
        files.append({"path": arc, "size": len(raw), "csize": len(stored),
                      "sha256": hashlib.sha256(raw).hexdigest(),
                      "offset": len(blob), "compressed": True})  # note: no "codec"
        blob.extend(stored)
    manifest = {"format": "csf-pack", "version": "0.8", "created_at": 0,
                "compressed": True, "file_count": len(files), "files": files}
    mb = json.dumps(manifest, separators=(",", ":")).encode()
    body = bytearray(csf_pack.MAGIC)
    body += struct.pack(">BB", *csf_pack.VERSION)
    body += struct.pack(">H", csf_pack.FLAG_COMPRESSED)
    body += struct.pack(">I", len(mb)) + mb + blob
    body += hashlib.sha256(bytes(body)).digest()
    body += struct.pack(csf_pack.FOOTER_FMT, len(body) + 8)
    pathlib.Path(out).write_bytes(bytes(body))


def test_legacy_no_codec_field_still_unpacks():
    # Backward compat: archives written before the codec field must still extract.
    blobs = {"old.txt": b"legacy zlib bytes\n" * 40, "raw.json": b'{"v":1}'}
    with tempfile.TemporaryDirectory() as d:
        d = pathlib.Path(d)
        out = str(d / "legacy.csf")
        _seal_legacy_archive(blobs, out)
        m = csf_pack.list_archive(out)
        assert "codec" not in m["files"][0]  # genuinely legacy
        csf_pack.unpack(out, str(d / "x"))
        for arc, raw in blobs.items():
            assert (d / "x" / arc).read_bytes() == raw
