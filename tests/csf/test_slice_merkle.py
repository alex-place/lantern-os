"""Tests for per-slice Merkle verification (F1b, #2799).

Two halves: the pure Merkle tree (root/proof/verify over bytes — the part that must be exactly
right or verification is worthless), and integration over a real CSF archive (a verified slice
must return the same bytes as read_file, and a tampered/mismatched root must be rejected).
"""
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src"))

from csf import csf_pack as sm  # noqa: E402  (per-slice Merkle now lives in csf_pack, F1b)
import csf  # noqa: E402


# ── pure Merkle correctness ───────────────────────────────────────────────────

def test_root_is_deterministic_and_leaf_size_sensitive():
    data = b"the quick brown fox jumps over the lazy dog" * 4
    assert sm.merkle_root(data, 16) == sm.merkle_root(data, 16)
    # different leaf granularity → different tree → different root (it's part of the contract)
    assert sm.merkle_root(data, 16) != sm.merkle_root(data, 32)


def test_single_leaf_root_is_that_leaf_hash():
    data = b"small"
    assert sm.merkle_root(data, 1024) == sm._leaf_hash(data)


def test_empty_member_has_a_defined_root_distinct_from_a_zero_byte():
    assert sm.merkle_root(b"", 16) == sm._leaf_hash(b"")
    assert sm.merkle_root(b"", 16) != sm.merkle_root(b"\x00", 16)


def test_leaf_and_internal_are_domain_separated():
    # a leaf whose bytes equal an internal node's preimage must not collide with that node
    assert sm._leaf_hash(b"x") != sm._node_hash(b"x"[:0], b"x"[:0])


def test_every_leaf_proof_verifies_against_the_root_across_sizes():
    # sweep leaf counts including odd ones (carry-up path) and a power of two
    for nbytes, leaf_size in [(1, 4), (7, 2), (16, 4), (17, 4), (100, 8), (256, 16)]:
        data = bytes((i * 37 + 11) & 0xFF for i in range(nbytes))
        root = sm.merkle_root(data, leaf_size)
        n = sm.leaf_count(len(data), leaf_size)
        for li in range(n):
            chunk = data[li * leaf_size:(li + 1) * leaf_size]
            proof = sm.leaf_proof(data, li, leaf_size)
            assert sm.verify_leaf(chunk, li, n, proof, root), f"n={nbytes} ls={leaf_size} leaf={li}"


def test_a_tampered_leaf_fails_verification():
    # distinct-content leaves so index-binding is exercised on real structure, not by luck
    data = bytes((i * 13 + 7) & 0xFF for i in range(100))
    n = sm.leaf_count(len(data), 8)
    root = sm.merkle_root(data, 8)
    proof = sm.leaf_proof(data, 3, 8)
    good = data[24:32]
    assert sm.verify_leaf(good, 3, n, proof, root)
    assert not sm.verify_leaf(b"B" * 8, 3, n, proof, root)       # wrong bytes
    assert not sm.verify_leaf(good, 3, n, proof, b"\x00" * 32)   # wrong root
    assert not sm.verify_leaf(good, 2, n, proof, root)           # wrong index → rejected


def test_a_proof_cannot_be_replayed_for_a_different_equal_content_leaf():
    # all leaves identical: an index-free checker would accept leaf-3's proof for leaf-2.
    # Index-binding must still reject the wrong position even when the bytes match.
    data = b"A" * 100
    n = sm.leaf_count(len(data), 8)
    root = sm.merkle_root(data, 8)
    proof3 = sm.leaf_proof(data, 3, 8)
    chunk = b"A" * 8
    assert sm.verify_leaf(chunk, 3, n, proof3, root)             # its own index: ok
    assert not sm.verify_leaf(chunk, 4, n, proof3, root)         # replayed to a neighbor: rejected


def test_covering_leaves_math():
    assert sm.covering_leaves(0, 10, 16) == (0, 0)
    assert sm.covering_leaves(10, 10, 16) == (0, 1)   # spans leaf boundary at 16
    assert sm.covering_leaves(32, 1, 16) == (2, 2)
    assert sm.covering_leaves(5, 0, 16) == (0, 0)     # zero-length


# ── integration over a real CSF archive ───────────────────────────────────────

@pytest.fixture()
def archive(tmp_path):
    body = bytes((i * 7 + 3) & 0xFF for i in range(250))  # 250 bytes → many 16-byte leaves
    out = tmp_path / "t.csf"
    csf.pack_blobs({"member.bin": body}, str(out), compress=False)
    return str(out), body


def test_verified_slice_matches_read_file_for_every_range(archive):
    path, body = archive
    ls = 16
    root = sm.member_merkle_root(path, "member.bin", ls)
    # leaf-aligned, sub-leaf, leaf-spanning, tail-past-last-full-leaf, whole
    for offset, length in [(0, 16), (5, 3), (10, 20), (240, 10), (0, 250), (128, 0)]:
        got = sm.read_slice_verified(path, "member.bin", offset, length, root, ls)
        assert got == body[offset:offset + length], f"({offset},{length})"


def test_verified_slice_rejects_a_wrong_root(archive):
    path, _ = archive
    with pytest.raises(ValueError, match="root"):
        sm.read_slice_verified(path, "member.bin", 0, 16, b"\x00" * 32, 16)


def test_verified_slice_rejects_out_of_range(archive):
    path, body = archive
    root = sm.member_merkle_root(path, "member.bin", 16)
    with pytest.raises(ValueError):
        sm.read_slice_verified(path, "member.bin", len(body) - 4, 100, root, 16)


def test_member_root_matches_recomputing_from_read_file(archive):
    path, body = archive
    assert sm.member_merkle_root(path, "member.bin", 16) == sm.merkle_root(body, 16)
