"""#2099 — CSFv1 segment header must record real offsets, not zeroed placeholders.

CsfSegmentBuilder.encode() used to pack 0 for uncompressed-size / dictionary-offset /
index-offset while flagging `has index` (0x0001) over an index block it never wrote — so a
reader couldn't seek by the header. These tests pin the fix: the header now carries the real
uncompressed size and a real, seekable dictionary offset; the has-index flag is cleared (no index
is written yet); and the CRC footer actually validates the payload.
"""
import struct
import zlib

from cadd_dollhouse_csf import REPO_ROOT, CsfSegmentBuilder


def _builder():
    b = CsfSegmentBuilder("seg-test", REPO_ROOT / "README.md")
    for i in range(5):
        b.add_record({"id": i, "text": f"the lantern remembers record {i}", "kind": "trace"})
    return b


def test_header_offsets_are_real_not_zero():
    b = _builder()
    blob = b.encode()
    h = CsfSegmentBuilder.decode_header(blob)

    assert h["magic"].rstrip(b"\x00") == b"CSFv1"
    assert h["version"] == 1
    assert h["segment_count"] == 1
    # uncompressed size is the real body length, not a 0 placeholder
    assert h["uncompressed_size"] > 0
    # dictionary offset points right after the fixed header + segment table
    expected = struct.calcsize(CsfSegmentBuilder.HEADER_FMT) + struct.calcsize(CsfSegmentBuilder.SEGMENT_TABLE_FMT)
    assert h["dictionary_offset"] == expected
    # the has-index flag is NOT set (no index block is written) and index_offset stays 0
    assert h["has_index"] is False
    assert h["index_offset"] == 0


def test_dictionary_offset_is_actually_seekable():
    """Seek to dictionary_offset, read the length-prefixed zlib dict block, and recover the
    builder's dictionary — proving the advertised offset is real, not a placeholder."""
    b = _builder()
    b.build_dictionary()
    expected_dict = dict(b.dictionary)
    blob = b.encode()
    off = CsfSegmentBuilder.decode_header(blob)["dictionary_offset"]

    dict_len = struct.unpack(">I", blob[off : off + 4])[0]
    dict_compressed = blob[off + 4 : off + 4 + dict_len]
    recovered = __import__("json").loads(zlib.decompress(dict_compressed).decode("utf-8"))
    assert recovered == expected_dict


def test_crc_footer_validates_and_detects_tampering():
    b = _builder()
    blob = b.encode()
    assert CsfSegmentBuilder.verify_crc(blob) is True
    # flip a payload byte → CRC must fail
    tampered = bytearray(blob)
    tampered[20] ^= 0xFF
    assert CsfSegmentBuilder.verify_crc(bytes(tampered)) is False


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
