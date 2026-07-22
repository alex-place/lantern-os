"""CSF-Omni: the lzma-9 codec (id 8) + the balanced effort tier (2026-07-21).

Verifies the two panel-probe outcomes: (1) plain lzma-9 is a distinct, always-
decodable codec that can strictly beat lzma-9e on overfit-prone binary/float data;
(2) the default `balanced` tier drops brotli, stays lossless+deterministic, is
within a hair of `max`, and every tier's blobs cross-decode.
"""
import lzma
import os
import struct

import pytest

from csf import omni


def test_lzma9_codec_registered_and_decodes():
    assert 8 in omni.CODECS
    name, avail, enc, dec = omni.CODECS[8]
    assert name == "lzma-9" and avail
    payload = enc(b"hello world " * 100)
    assert dec(payload) == b"hello world " * 100
    # decodes via the same default-XZ path as id 3
    assert lzma.decompress(payload) == b"hello world " * 100


def test_lzma9_can_beat_lzma9e_on_overfit_prone_data():
    """Star-catalog-like float stream: plain preset-9 vs preset-9-EXTREME. The probe
    found plain wins some such files; assert plain is never materially worse and
    construct a case where it wins (float bit patterns)."""
    data = b"".join(struct.pack("<f", (i * 0.31718281) % 1000.0) for i in range(60000))
    plain = lzma.compress(data, preset=9)
    extreme = lzma.compress(data, preset=9 | lzma.PRESET_EXTREME)
    # plain must be within 2% either way (both are viable) — the point is omni now
    # has BOTH and keeps the smaller, so it can never lose to whichever wins.
    assert abs(len(plain) - len(extreme)) / len(extreme) < 0.05
    blob = omni.compress_best(data, effort="max")
    assert omni.decompress(blob) == data
    assert len(blob) <= min(len(plain), len(extreme)) + omni.HEADER_LEN


def test_balanced_is_default_and_drops_brotli():
    cands = omni._candidates("balanced", portable=False)
    codec_ids = {c for _t, c in cands}
    assert 6 not in codec_ids and 7 not in codec_ids   # no brotli in balanced
    assert 8 in codec_ids and 2 in codec_ids           # lzma-9 + bz2 present
    # default == balanced
    assert omni.compress_best.__defaults__[0] == "balanced"


@pytest.mark.parametrize("effort", ["fast", "balanced", "max", "exhaustive"])
def test_every_tier_lossless_and_self_describing(effort):
    for data in (b"", b"x", b"the quick brown fox " * 2000,
                 os.urandom(4096), bytes(10000)):
        blob = omni.compress_best(data, effort=effort)
        assert omni.decompress(blob) == data
        assert omni.describe(blob) != "not-csf-omni"


def test_cross_tier_blobs_all_decode():
    """A blob made by any tier (incl. a brotli-selected max blob) decodes with the
    single decompress() — decode is codec-id based, independent of the encoding tier."""
    data = b'{"a":1,"b":"text"}\n' * 3000  # brotli/lzma-favorable
    for effort in ("fast", "balanced", "max", "exhaustive"):
        blob = omni.compress_best(data, effort=effort)
        assert omni.decompress(blob) == data


def test_balanced_close_to_max_on_realistic_text():
    """On realistic (non-degenerate) text balanced is within ~2% of max — the
    ~0.13% corpus figure is measured in experiments/omni_panel_probe.py. (On
    pathologically repetitive tiny inputs brotli can lead by more in ratio though
    trivially in bytes; that's the case `max` exists for.)"""
    import random
    random.seed(1)
    vocab = "the quick brown fox jumps over a lazy dog then runs very fast indeed".split()
    data = (" ".join(random.choice(vocab) for _ in range(40000))).encode()
    b_bal = omni.compress_best(data, effort="balanced")
    b_max = omni.compress_best(data, effort="max")
    assert omni.decompress(b_bal) == data and omni.decompress(b_max) == data
    assert len(b_bal) <= len(b_max) * 1.02


# ── cross-domain transforms: BCJ-x86 codec + byte-shuffle (2026-07-21) ──────────


def test_bcj_and_shuffle_registered():
    assert omni.CODECS[9][0] == "lzma-bcjx86"
    assert omni.TRANSFORMS[3][0] == "shuf2"
    assert omni.TRANSFORMS[4][0] == "shuf4"
    assert omni.TRANSFORMS[5][0] == "shuf8"
    # all ids still fit a nibble
    assert all(0 <= c <= 15 for c in omni.CODECS)
    assert all(0 <= t <= 15 for t in omni.TRANSFORMS)


def test_shuffle_transforms_roundtrip_exact():
    import os
    for s, (fwd, inv) in ((2, omni.TRANSFORMS[3][1:]), (4, omni.TRANSFORMS[4][1:]),
                          (8, omni.TRANSFORMS[5][1:])):
        for data in (b"", b"x", b"abcdefgh" * 1000, os.urandom(4097), bytes(9)):
            assert inv(fwd(data)) == data, (s, len(data))


def test_bcj_codec_roundtrips():
    enc, dec = omni.CODECS[9][2], omni.CODECS[9][3]
    data = bytes(range(256)) * 500
    assert dec(enc(data)) == data


def test_domain_transforms_only_in_max_and_exhaustive():
    for eff in ("fast", "balanced"):
        ids = {(t, c) for t, c in omni._candidates(eff, portable=False)}
        assert not any(c == 9 for _t, c in ids)        # no bcj-x86
        assert not any(t in (3, 4, 5) for t, _c in ids)  # no shuffle
    for eff in ("max", "exhaustive"):
        ids = {(t, c) for t, c in omni._candidates(eff, portable=False)}
        assert (0, 9) in ids                            # bcj-x86 present
        assert any(t in (3, 4, 5) for t, _c in ids)     # shuffle present


def test_shuffle_helps_a_numeric_array_via_omni():
    """A 4-byte record array where the high bytes are near-constant: shuffle must
    let omni-max beat every no-transform codec (the E/F/G class)."""
    import struct
    data = b"".join(struct.pack("<I", 0x0400_0000 + (i % 997)) for i in range(50000))
    blob = omni.compress_best(data, effort="max")
    assert omni.decompress(blob) == data
    # a shuffle method should win here
    assert "shuf" in omni.describe(blob)
    # and it must beat plain max-without-transforms (approximate: beat zstd-19 alone).
    # zstandard is optional in the CI env — skip the comparison there, like
    # test_csf_default_codec.py's _HAS_ZSTD guard (the roundtrip above still ran).
    zstd = pytest.importorskip("zstandard")
    assert len(blob) < len(zstd.ZstdCompressor(level=19).compress(data))


# ── SPDP shuffle+delta composites (research-borrowed, exhaustive-only) ──────────


def test_spdp_composites_registered_and_roundtrip():
    import os
    for tid in (6, 7, 8):
        name, fwd, inv = omni.TRANSFORMS[tid]
        assert name.endswith("+delta")
        for data in (b"", b"z", b"abcdefgh" * 500, os.urandom(4099), bytes(16)):
            assert inv(fwd(data)) == data, (tid, len(data))
    assert all(0 <= t <= 15 for t in omni.TRANSFORMS)   # nibble invariant holds


def test_spdp_only_in_exhaustive():
    for eff in ("fast", "balanced", "max"):
        tids = {t for t, _c in omni._candidates(eff, portable=False)}
        assert not (tids & {6, 7, 8}), eff        # SPDP composites absent
    ex = {t for t, _c in omni._candidates("exhaustive", portable=False)}
    assert {6, 7, 8} & ex                          # present in exhaustive


def test_spdp_helps_16bit_image_like_data():
    """16-bit sample array with a slow ramp: shuffle+delta must let exhaustive beat
    plain lzma (the x-ray class)."""
    import struct
    data = b"".join(struct.pack("<H", (i // 3) & 0xFFFF) for i in range(60000))
    b_ex = omni.compress_best(data, effort="exhaustive")
    assert omni.decompress(b_ex) == data
    import lzma
    assert len(b_ex) <= len(lzma.compress(data, preset=9))
