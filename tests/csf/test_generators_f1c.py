"""F1c — registered, version-pinned scientific generators (#2799).

The generative-member tier stores a tiny recipe instead of bytes and regenerates them
deterministically. F1c makes the registry safe to GROW: a version pin per kind so a future
output-changing revision is refused on read (clear drift error) instead of silently emitting
wrong bytes, and a first slice-addressable scientific generator (Park-Miller minstd LCG — the
reproducible-"random" stream used to seed simulations).

The golden-hash test is the falsification contract: if `_gen_lcg`'s output ever changes, this
test fails, forcing a `_GEN_VERSIONS["lcg"]` bump (which cleanly invalidates old archives) —
"any cross-version regeneration drift → kind removed/re-versioned", per the issue's kill.
"""
import hashlib
import os
import sys
import tempfile

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "src"))

import csf  # noqa: E402
from csf import csf_pack as cp  # noqa: E402

SPEC = {"kind": "lcg", "seed": 42, "size": 400}
# Pinned forever for version 1. A change here means the LCG output drifted → bump the version.
GOLDEN_SHA256 = "efc5b25c300e6b4ae4bbeaab1d657b17039dc29127115047f81aeece4b677838"


def test_lcg_output_is_pinned_forever_golden_hash():
    assert hashlib.sha256(cp.materialize_generator(SPEC)).hexdigest() == GOLDEN_SHA256


def test_lcg_is_deterministic_and_seed_sensitive():
    a = cp.materialize_generator({"kind": "lcg", "seed": 7, "size": 128})
    b = cp.materialize_generator({"kind": "lcg", "seed": 7, "size": 128})
    c = cp.materialize_generator({"kind": "lcg", "seed": 8, "size": 128})
    assert a == b and a != c


def test_lcg_zero_seed_is_forbidden_fixed_point():
    # 0 is the LCG's absorbing fixed point (would emit all-zero); normalized to 1 instead.
    assert cp.materialize_generator({"kind": "lcg", "seed": 0, "size": 64}) == \
        cp.materialize_generator({"kind": "lcg", "seed": 1, "size": 64})


def test_lcg_slice_fast_path_matches_full_materialization():
    full = cp.materialize_generator(SPEC)
    for off, ln in [(0, 4), (2, 3), (4, 20), (10, 7), (396, 4), (0, 400), (128, 0)]:
        assert cp._gen_slice(SPEC, off, ln) == full[off:off + ln], f"({off},{ln})"


def test_lcg_slice_out_of_range_raises():
    with pytest.raises(ValueError):
        cp._gen_slice(SPEC, 398, 10)


def _pack(gen):
    d = tempfile.mkdtemp()
    arc = os.path.join(d, "g.csf")
    manifest = csf.pack_blobs({"m.bin": {"generator": gen}}, arc, compress=False)
    return arc, manifest


def test_packed_member_round_trips_and_is_version_stamped():
    arc, manifest = _pack({"kind": "lcg", "seed": 42, "size": 400})
    assert csf.read_file(arc, "m.bin") == cp.materialize_generator(SPEC)  # sha-verified read
    fe = next(f for f in manifest["files"] if f["path"] == "m.bin")
    assert fe["generator"]["version"] == 1, "packed generative members are version-pinned (F1c)"
    # slice through the real archive matches too
    full = cp.materialize_generator(SPEC)
    assert csf.read_slice(arc, "m.bin", 8, 16) == full[8:24]


def test_version_drift_is_refused_not_silently_regenerated():
    # a spec pinned to a version the registry no longer serves must raise, not emit wrong bytes
    with pytest.raises(ValueError, match="refusing"):
        cp.materialize_generator({"kind": "lcg", "seed": 42, "size": 400, "version": 999})
    with pytest.raises(ValueError, match="refusing"):
        cp._gen_slice({"kind": "lcg", "seed": 42, "size": 400, "version": 999}, 0, 4)


def test_legacy_specs_without_a_version_are_grandfathered():
    # pre-pin archives carry no `version` — they must still materialize (guard only fires on a
    # present-but-mismatched version).
    assert len(cp.materialize_generator({"kind": "sha256-ctr", "seed": "x", "size": 96})) == 96
    assert len(cp.materialize_generator({"kind": "lcg", "seed": 3, "size": 40})) == 40


def test_current_versions_match_reproducibly_at_registered_version():
    # explicitly pinning the CURRENT version must be accepted (round-trips through the guard)
    got = cp.materialize_generator({"kind": "lcg", "seed": 42, "size": 400, "version": 1})
    assert hashlib.sha256(got).hexdigest() == GOLDEN_SHA256
