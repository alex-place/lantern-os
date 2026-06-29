"""CSF-Col transform (Technique 1, issue #1593) — losslessness + omni integration."""
import json
import random

import pytest

from csf import col_transform as col, omni


def _rt(data: bytes):
    """forward+inverse must reproduce bytes exactly, or be NotApplicable."""
    try:
        t = col.forward(data)
    except col.NotApplicable:
        return None
    assert col.inverse(t) == data
    return t


def test_basic_jsonl_roundtrip():
    rows = [
        {"id": "a1", "conf": 0.7, "ts": "2026-06-16T04:59:31Z", "ok": False, "ev": []},
        {"id": "a2", "conf": 0.91, "ts": "2026-06-16T05:00:00Z", "ok": True, "ev": [1, 2]},
    ]
    data = ("\n".join(json.dumps(r, separators=(",", ":")) for r in rows) + "\n").encode()
    t = _rt(data)
    assert t is not None


@pytest.mark.parametrize("nl", [True, False])
def test_crlf_and_trailing_newline(nl):
    # CRLF line endings (the real data/convergence/records.jsonl shape) must round-trip.
    line = json.dumps({"id": "x", "v": 1, "n": None}, separators=(",", ":"))
    data = (line + "\r\n" + line + "\r" + ("\n" if nl else "")).encode()
    assert _rt(data) is not None


def test_heterogeneous_schema_roundtrip():
    rows = [{"a": 1}, {"a": 2, "b": "x"}, {"c": [1, 2, 3]}, {}]
    data = ("\n".join(json.dumps(r, separators=(",", ":")) for r in rows)).encode()
    assert _rt(data) is not None


@pytest.mark.parametrize("blob", [b"", b"not json", b"{broken", b"\x00\x01", b"plain text\nlines"])
def test_non_jsonl_is_not_applicable(blob):
    with pytest.raises(col.NotApplicable):
        col.forward(blob)


def test_unicode_and_escapes_preserved():
    data = (json.dumps({"s": "café\t\"q\"\\z", "e": "😀"}, separators=(",", ":")) + "\n").encode()
    t = _rt(data)
    assert t is not None


def test_fuzz_roundtrip():
    rnd = random.Random(1234)
    vals = [0, -7, 999, 3.14, "s\t\"x", None, True, False, [1, 2], {"q": 1}]
    for _ in range(1500):
        rows = []
        for _ in range(rnd.randint(0, 6)):
            keys = rnd.sample(["a", "b", "ts", "conf", "note", "tags"], rnd.randint(1, 5))
            rows.append(json.dumps({k: rnd.choice(vals) for k in keys}, separators=(",", ":")))
        data = ("\n".join(rows) + ("\n" if rnd.random() < 0.5 else "")).encode()
        if data.startswith(b"{"):
            _rt(data)  # asserts inside


def test_omni_selects_col_and_stays_lossless():
    # A schema-homogeneous append-only log: omni should pick the col transform AND
    # round-trip losslessly.
    rows = [json.dumps({"id": f"r{i}", "conf": 0.7, "reasoner": "Lantern",
                        "ts": f"2026-06-16T04:{i % 60:02d}:00Z", "ok": False},
                       separators=(",", ":")) for i in range(200)]
    data = ("\n".join(rows) + "\n").encode()
    blob = omni.compress_best(data, effort="max")
    assert omni.decompress(blob) == data
    assert "col" in omni.describe(blob)  # the transform won on this homogeneous log


def test_omni_falls_back_on_non_jsonl():
    data = b"the quick brown fox " * 500
    blob = omni.compress_best(data, effort="max")
    assert omni.decompress(blob) == data
    assert "col" not in omni.describe(blob)
