"""
embedder.py — map CSF symbolic vocab to L2-normalized float32 vectors.

Uses co-occurrence frequency from csf_memory JSONL files to build weights.
Falls back to a hardcoded seed vocab if no JSONL data is available.
Pure numpy — no torch/transformers.

Usage:
    from csf_agent.embedder import CSFEmbedder
    emb = CSFEmbedder()
    vec = emb.embed(["dream", "convergence"])   # np.ndarray shape (vocab_size,)
    emb.save("data/csf_memory/embedder.npy")
    emb2 = CSFEmbedder.load("data/csf_memory/embedder.npy")
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np

# Canonical 34-token CSF symbolic vocabulary (seed — grows as CSF records accumulate)
_SEED_VOCAB: List[str] = [
    # Core convergence concepts
    "convergence", "loop", "phase", "validation", "receipt",
    "evidence", "boundary", "promotion", "drift",
    # Dream journal domain
    "dream", "journal", "lantern", "door", "memory", "lore",
    # Agent / fleet
    "agent", "slot", "fleet", "persona", "provider",
    # Tesseract
    "tesseract", "cube", "status", "belief", "bayesian",
    # Work / issue
    "issue", "fix", "bug", "feat", "task", "stream",
    # CSF / data
    "csf", "ingest", "signal",
]

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_JSONL_DIRS = [
    _REPO_ROOT / "data" / "csf_memory",
    _REPO_ROOT / "data" / "dream_journal",
]


def _build_weights_from_jsonl(vocab: List[str], jsonl_dirs: List[Path]) -> np.ndarray:
    """Count co-occurrence of vocab tokens in JSONL tag/keyword fields."""
    counts = np.ones(len(vocab), dtype=np.float32)  # Laplace smoothing
    vocab_set = {v: i for i, v in enumerate(vocab)}

    for directory in jsonl_dirs:
        if not directory.exists():
            continue
        for path in directory.glob("*.jsonl"):
            try:
                with open(path, "r", encoding="utf-8", errors="ignore") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            record = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        # Collect all token-like strings from tags/keywords/labels
                        tokens: List[str] = []
                        for field in ("tags", "keywords", "labels", "entities"):
                            val = record.get(field, [])
                            if isinstance(val, list):
                                tokens.extend(str(v).lower() for v in val)
                        # Also tokenize content text
                        content = record.get("content", {})
                        if isinstance(content, dict):
                            body = content.get("body", "") or content.get("raw", {})
                            if isinstance(body, dict):
                                body = str(body.get("body", ""))
                            tokens.extend(str(body).lower().split())
                        for tok in tokens:
                            idx = vocab_set.get(tok)
                            if idx is not None:
                                counts[idx] += 1.0
            except OSError:
                continue

    return counts


def _l2_normalize(v: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(v)
    if norm < 1e-9:
        return v
    return v / norm


class CSFEmbedder:
    """
    Maps lists of string tokens to L2-normalized float32 vectors of vocab size.
    Unknown tokens map to zero weight (no KeyError).
    """

    def __init__(
        self,
        vocab: Optional[List[str]] = None,
        jsonl_dirs: Optional[List[Path]] = None,
    ) -> None:
        self.vocab: List[str] = vocab if vocab is not None else list(_SEED_VOCAB)
        self._vocab_index: Dict[str, int] = {t: i for i, t in enumerate(self.vocab)}
        dirs = jsonl_dirs if jsonl_dirs is not None else _DEFAULT_JSONL_DIRS
        self._weights = _build_weights_from_jsonl(self.vocab, dirs)

    @property
    def vocab_size(self) -> int:
        return len(self.vocab)

    def embed(self, tokens: List[str]) -> np.ndarray:
        """
        Return L2-normalized float32 vector of vocab_size.
        Each position holds the weight of that vocab token scaled by
        how many times the token appears in `tokens`.
        Unknown tokens are silently ignored (zero contribution).
        """
        vec = np.zeros(self.vocab_size, dtype=np.float32)
        for tok in tokens:
            idx = self._vocab_index.get(str(tok).lower())
            if idx is not None:
                vec[idx] += self._weights[idx]
        return _l2_normalize(vec)

    def save(self, path: str | Path) -> None:
        """Save vocab + weights to a numpy .npy archive."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        np.save(str(path), {"vocab": self.vocab, "weights": self._weights}, allow_pickle=True)

    @classmethod
    def load(cls, path: str | Path) -> "CSFEmbedder":
        """Load a previously saved embedder from .npy file."""
        data = np.load(str(path), allow_pickle=True).item()
        inst = cls.__new__(cls)
        inst.vocab = list(data["vocab"])
        inst._vocab_index = {t: i for i, t in enumerate(inst.vocab)}
        inst._weights = np.asarray(data["weights"], dtype=np.float32)
        return inst
