"""
tests/test_csf_embedder.py — unit tests for csf_agent.embedder

Covers: known tokens, unknown tokens, empty input, save/load round-trip, L2 norm.
"""

import sys
import tempfile
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from csf_agent.embedder import CSFEmbedder, _l2_normalize, _SEED_VOCAB


def _fresh_embedder() -> CSFEmbedder:
    """Embedder with no JSONL dirs (pure seed vocab + Laplace weights)."""
    return CSFEmbedder(jsonl_dirs=[])


# ── L2 normalize helper ───────────────────────────────────────────────────────

def test_l2_normalize_unit():
    v = np.array([3.0, 4.0], dtype=np.float32)
    n = _l2_normalize(v)
    assert abs(np.linalg.norm(n) - 1.0) < 1e-6


def test_l2_normalize_zero():
    v = np.zeros(5, dtype=np.float32)
    n = _l2_normalize(v)
    assert np.allclose(n, 0.0)


# ── CSFEmbedder basics ────────────────────────────────────────────────────────

def test_vocab_size():
    emb = _fresh_embedder()
    assert emb.vocab_size == len(_SEED_VOCAB)


def test_embed_known_tokens():
    emb = _fresh_embedder()
    vec = emb.embed(["dream", "convergence"])
    assert vec.shape == (emb.vocab_size,)
    # Known tokens produce non-zero dimensions
    assert vec.sum() > 0


def test_embed_unknown_tokens_no_error():
    emb = _fresh_embedder()
    vec = emb.embed(["xyzzy_unknown_token", "foobar"])
    assert vec.shape == (emb.vocab_size,)
    # Unknown tokens → zero vector
    assert np.allclose(vec, 0.0)


def test_embed_empty_returns_zero():
    emb = _fresh_embedder()
    vec = emb.embed([])
    assert vec.shape == (emb.vocab_size,)
    assert np.allclose(vec, 0.0)


def test_embed_l2_normalized():
    emb = _fresh_embedder()
    vec = emb.embed(["dream", "lantern", "convergence"])
    norm = np.linalg.norm(vec)
    assert abs(norm - 1.0) < 1e-5


def test_embed_case_insensitive():
    emb = _fresh_embedder()
    lower = emb.embed(["dream"])
    upper = emb.embed(["DREAM"])
    assert np.allclose(lower, upper)


# ── save / load round-trip ────────────────────────────────────────────────────

def test_save_load_round_trip():
    emb = _fresh_embedder()
    original_vec = emb.embed(["dream", "agent"])

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "test_emb.npy"
        emb.save(path)
        loaded = CSFEmbedder.load(path)

    assert loaded.vocab == emb.vocab
    assert np.allclose(loaded._weights, emb._weights)
    loaded_vec = loaded.embed(["dream", "agent"])
    assert np.allclose(loaded_vec, original_vec)
