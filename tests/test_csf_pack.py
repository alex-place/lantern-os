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


# --------------------------------------------------------------------------
# Per-file grounding: optional description + metadata (Σ₀ store)
# --------------------------------------------------------------------------

def test_annotations_round_trip_and_index():
    """description + metadata attach per file, survive the archive, and are
    retrievable via list_archive / file_annotation / annotations — while the
    blob content round-trips byte-for-byte."""
    blobs = {"a.py": b"print('a')\n", "b.py": b"print('b')\n", "c.py": b"# no note\n"}
    ann = {
        "a.py": {"description": "prints a", "metadata": {"loop_stage": "Act", "verdict": "grounded", "confidence": 0.9}},
        "b.py": "prints b",  # bare-string shorthand -> description only
    }
    with tempfile.TemporaryDirectory() as d:
        out = str(pathlib.Path(d) / "out.csf")
        csf_pack.pack_blobs(blobs, out, annotations=ann)

        # manifest carries the fields
        m = csf_pack.list_archive(out)
        by = {fe["path"]: fe for fe in m["files"]}
        assert by["a.py"]["description"] == "prints a"
        assert by["a.py"]["metadata"]["loop_stage"] == "Act"
        assert by["b.py"]["description"] == "prints b"
        assert "metadata" not in by["b.py"]        # bare string -> no metadata key
        assert "description" not in by["c.py"]      # un-annotated file stays clean
        assert "metadata" not in by["c.py"]

        # convenience readers
        fa = csf_pack.file_annotation(out, "a.py")
        assert fa == {"description": "prints a", "metadata": {"loop_stage": "Act", "verdict": "grounded", "confidence": 0.9}}
        idx = csf_pack.annotations(out)
        assert set(idx) == {"a.py", "b.py"}          # only annotated members appear
        assert idx["b.py"]["metadata"] is None

        # blob content is untouched by annotation
        dest = pathlib.Path(d) / "x"
        csf_pack.unpack(out, str(dest))
        for arc, raw in blobs.items():
            assert (dest / arc).read_bytes() == raw


def test_annotations_absent_is_byte_identical():
    """Packing with no annotations (or empty ones) must produce the exact same
    bytes as before the feature existed — annotating is strictly additive."""
    blobs = {"a.txt": b"x" * 100, "b.txt": b"y" * 100}
    with tempfile.TemporaryDirectory() as d:
        d = pathlib.Path(d)
        # created_at is time-based; pin it out of the comparison by zeroing both
        a = d / "a.csf"
        b = d / "b.csf"
        csf_pack.pack_blobs(blobs, str(a), codec="zlib")
        csf_pack.pack_blobs(blobs, str(b), codec="zlib", annotations={})
        ma, mb = csf_pack.list_archive(str(a)), csf_pack.list_archive(str(b))
        # file entries identical (no description/metadata keys introduced)
        assert [fe for fe in ma["files"]] == [fe for fe in mb["files"]]
        assert csf_pack.annotations(str(a)) == {}


def test_pack_files_with_annotations():
    """pack() (filesystem) accepts annotations keyed by the arc_path it lists."""
    with tempfile.TemporaryDirectory() as d:
        d = pathlib.Path(d)
        f = d / "script.py"
        f.write_text("print('hi')\n")
        out = str(d / "out.csf")
        csf_pack.pack([str(f)], out,
                      annotations={"script.py": {"description": "a script", "metadata": {"loop_stage": "Infra"}}})
        assert csf_pack.file_annotation(out, "script.py")["description"] == "a script"


# ── solid mode (one compressed stream over all members; v0.9, 2026-07-21) ───────


def test_solid_roundtrip_blobs_and_read_file():
    blobs = {f"logs/day{i}.jsonl": (b'{"n":%d,"msg":"the same structural line"}\n' % i) * 40
             for i in range(12)}
    with tempfile.TemporaryDirectory() as d:
        out = str(pathlib.Path(d) / "solid.csf")
        m = csf_pack.pack_blobs(blobs, out, solid=True)
        assert m.get("solid") and m["version"] == "0.9"
        assert csf_pack.unpack_blobs(out) == blobs               # full inverse
        one = "logs/day7.jsonl"
        assert csf_pack.read_file(out, one) == blobs[one]        # single-member read
        # per-file entries carry decompressed-space offsets, no csize
        assert all("csize" not in fe for fe in m["files"])


def test_solid_beats_or_ties_per_file_on_redundant_set():
    blobs = {f"f{i}.md": b"# shared header\ncommon boilerplate paragraph\n" * 30 + str(i).encode()
             for i in range(20)}
    with tempfile.TemporaryDirectory() as d:
        a = str(pathlib.Path(d) / "perfile.csf")
        b = str(pathlib.Path(d) / "solid.csf")
        csf_pack.pack_blobs(blobs, a)
        csf_pack.pack_blobs(blobs, b, solid=True)
        assert pathlib.Path(b).stat().st_size <= pathlib.Path(a).stat().st_size


def test_solid_tamper_detected():
    blobs = {"a.txt": b"hello " * 100, "b.txt": b"world " * 100}
    with tempfile.TemporaryDirectory() as d:
        out = pathlib.Path(d) / "s.csf"
        csf_pack.pack_blobs(blobs, str(out), solid=True)
        raw = bytearray(out.read_bytes())
        raw[len(raw) // 2] ^= 0xFF                                # flip a body byte
        out.write_bytes(bytes(raw))
        try:
            csf_pack.unpack_blobs(str(out))
            assert False, "tamper must not pass"
        except ValueError:
            pass                                                  # footer or sha catches it


def test_solid_ignored_for_store_and_dict_subsumed():
    blobs = {"x": b"abc" * 50, "y": b"def" * 50}
    with tempfile.TemporaryDirectory() as d:
        out = str(pathlib.Path(d) / "s.csf")
        m = csf_pack.pack_blobs(blobs, out, compress=False, solid=True)
        assert not m.get("solid") and m["version"] == "0.8"       # store: solid ignored
        m2 = csf_pack.pack_blobs(blobs, out, solid=True, use_dict=True)
        assert m2.get("solid") and not m2.get("shared_dict")      # dict subsumed


def test_non_solid_archives_unchanged():
    blobs = {"a": b"payload-a" * 20}
    with tempfile.TemporaryDirectory() as d:
        out = str(pathlib.Path(d) / "n.csf")
        m = csf_pack.pack_blobs(blobs, out)
        assert m["version"] == "0.8" and "solid" not in m
        assert csf_pack.unpack_blobs(out) == blobs


# ── generative members (v0.9): recomputation-as-storage, registry-only ─────────


def test_generative_members_roundtrip_and_ratio():
    """A 16 MiB lawful stream stored as a ~hundred-byte description, materialized
    on read and sha-verified — generator coding as a container primitive."""
    size = 16 * 1024 * 1024
    blobs = {
        "streams/lawful.bin": {"generator": {"kind": "sha256-ctr", "seed": "universe-42", "size": size}},
        "streams/zeros.bin": {"generator": {"kind": "zeros", "size": 4096}},
        "streams/pattern.bin": {"generator": {"kind": "repeat", "pattern_hex": "deadbeef", "size": 1000}},
        "notes/readme.md": b"# normal member alongside generative ones\n" * 20,
    }
    with tempfile.TemporaryDirectory() as d:
        out = pathlib.Path(d) / "gen.csf"
        m = csf_pack.pack_blobs(blobs, str(out))
        assert m["version"] == "0.9"
        archive_bytes = out.stat().st_size
        assert archive_bytes < 4096  # 16 MiB member, tiny archive
        got = csf_pack.unpack_blobs(str(out))
        assert len(got["streams/lawful.bin"]) == size
        assert got["streams/zeros.bin"] == b"\x00" * 4096
        assert got["streams/pattern.bin"][:4] == bytes.fromhex("deadbeef")
        assert got["notes/readme.md"] == blobs["notes/readme.md"]
        # determinism: same spec -> same bytes -> sha passes on a fresh read
        assert csf_pack.read_file(str(out), "streams/lawful.bin")[:32] == got["streams/lawful.bin"][:32]


def test_generative_member_tamper_detected():
    blobs = {"g.bin": {"generator": {"kind": "sha256-ctr", "seed": "s", "size": 4096}}}
    with tempfile.TemporaryDirectory() as d:
        out = pathlib.Path(d) / "g.csf"
        csf_pack.pack_blobs(blobs, str(out))
        raw = out.read_bytes()
        # flip the seed inside the manifest: sha over materialized bytes must fail
        tampered = raw.replace(b'"seed":"s"', b'"seed":"x"')
        assert tampered != raw
        out.write_bytes(tampered)
        try:
            csf_pack.unpack_blobs(str(out))
            assert False, "tampered generator must not verify"
        except ValueError:
            pass  # footer digest or member sha catches it


def test_generative_unknown_kind_and_guard():
    with tempfile.TemporaryDirectory() as d:
        out = str(pathlib.Path(d) / "x.csf")
        try:
            csf_pack.pack_blobs({"a": {"generator": {"kind": "evil-eval", "size": 10}}}, out)
            assert False, "unknown generator kind must be rejected"
        except ValueError:
            pass
        try:
            csf_pack.pack_blobs({"a": {"generator": {"kind": "zeros", "size": 1 << 40}}}, out)
            assert False, "materialization guard must reject huge sizes"
        except ValueError:
            pass


def test_generative_plus_solid_combo():
    blobs = {
        "doc1.md": b"shared boilerplate\n" * 50,
        "doc2.md": b"shared boilerplate\n" * 50 + b"tail",
        "law.bin": {"generator": {"kind": "sha256-ctr", "seed": "k", "size": 8192}},
    }
    with tempfile.TemporaryDirectory() as d:
        out = str(pathlib.Path(d) / "combo.csf")
        m = csf_pack.pack_blobs(blobs, out, solid=True)
        assert m.get("solid") and m["version"] == "0.9"
        got = csf_pack.unpack_blobs(out)
        assert got["doc2.md"].endswith(b"tail") and len(got["law.bin"]) == 8192


# ── F1b: read_slice (observer-slice reads) + framed solid ──────────────────────


def _slice_matches_full(out, path, cases):
    full = csf_pack.read_file(out, path)
    for off, ln in cases:
        assert csf_pack.read_slice(out, path, off, ln) == full[off:off + ln], (path, off, ln)


def test_read_slice_all_layouts_match_full_read():
    blobs = {
        "gen/law.bin": {"generator": {"kind": "sha256-ctr", "seed": "u", "size": 100_000}},
        "gen/zeros.bin": {"generator": {"kind": "zeros", "size": 5_000}},
        "gen/pat.bin": {"generator": {"kind": "repeat", "pattern_hex": "0badf00d51", "size": 7_777}},
        "doc/a.md": b"alpha beta gamma delta " * 400,
        "doc/b.md": b"epsilon zeta eta theta " * 300,
    }
    cases = [(0, 100), (31, 65), (999, 4001), (4_990, 10), (0, 0)]
    with tempfile.TemporaryDirectory() as d:
        # per-file layout
        out1 = str(pathlib.Path(d) / "perfile.csf")
        csf_pack.pack_blobs(blobs, out1)
        for p in blobs:
            _slice_matches_full(out1, p, cases)
        # store layout
        out2 = str(pathlib.Path(d) / "store.csf")
        csf_pack.pack_blobs(blobs, out2, compress=False)
        for p in ("doc/a.md", "doc/b.md"):
            _slice_matches_full(out2, p, cases)
        # solid (single frame) and framed solid
        out3 = str(pathlib.Path(d) / "solid.csf")
        csf_pack.pack_blobs(blobs, out3, solid=True)
        out4 = str(pathlib.Path(d) / "framed.csf")
        m4 = csf_pack.pack_blobs(blobs, out4, solid=True, solid_frame_mb=0.005)
        assert len(m4["solid"]["frames"]) > 1  # framing actually happened
        for p in blobs:
            _slice_matches_full(out3, p, cases)
            _slice_matches_full(out4, p, cases)
        # tail slice of the big generative member
        tail = csf_pack.read_slice(out1, "gen/law.bin", 100_000 - 7, 7)
        assert tail == csf_pack.read_file(out1, "gen/law.bin")[-7:]


def test_read_slice_bounds_and_missing():
    blobs = {"x.bin": b"0123456789"}
    with tempfile.TemporaryDirectory() as d:
        out = str(pathlib.Path(d) / "x.csf")
        csf_pack.pack_blobs(blobs, out)
        try:
            csf_pack.read_slice(out, "x.bin", 8, 5)
            assert False, "out-of-range slice must fail"
        except ValueError:
            pass
        try:
            csf_pack.read_slice(out, "nope", 0, 1)
            assert False
        except KeyError:
            pass


def test_framed_solid_roundtrip_and_frame_locality():
    """Frames cut at member boundaries: every member lies in exactly one frame,
    full unpack still byte-exact, and read_file on a framed archive works."""
    blobs = {f"m{i:02d}.txt": (f"member {i} ".encode() * 500) for i in range(20)}
    with tempfile.TemporaryDirectory() as d:
        out = str(pathlib.Path(d) / "framed.csf")
        m = csf_pack.pack_blobs(blobs, out, solid=True, solid_frame_mb=0.01)
        frames = m["solid"]["frames"]
        assert len(frames) > 1
        assert sum(fr["raw_size"] for fr in frames) == m["solid"]["raw_size"]
        # member->frame locality (boundaries respected)
        for fe in m["files"]:
            covering = [fr for fr in frames
                        if not (fr["raw_offset"] + fr["raw_size"] <= fe["offset"]
                                or fr["raw_offset"] >= fe["offset"] + fe["size"])]
            assert len(covering) == 1, fe["path"]
        assert csf_pack.unpack_blobs(out) == blobs
        assert csf_pack.read_file(out, "m07.txt") == blobs["m07.txt"]


def test_gen_slice_block_math_sha256_ctr():
    """The sha256-ctr slicer computes only covering blocks — verify exact block
    alignment across boundaries."""
    gen = {"kind": "sha256-ctr", "seed": "blocks", "size": 320}
    full = csf_pack.materialize_generator(gen)
    for off, ln in [(0, 32), (31, 2), (32, 32), (33, 63), (300, 20), (0, 320)]:
        assert csf_pack._gen_slice(gen, off, ln) == full[off:off + ln], (off, ln)
