"""
embedder.py — CSF symbolic vocab co-occurrence vectorizer.

⚠️  NOT semantic embeddings. This is a 34-token co-occurrence frequency counter
(pure numpy, no transformers). It produces L2-normalized vectors whose cosine
similarity measures shared-vocabulary overlap, NOT semantic meaning. Renamed from
misleading "embedder"/"semantic search" framing in #937.

Use ``CSFCooccurrenceVectorizer`` (canonical name). ``CSFEmbedder`` is kept as a
backwards-compat alias so existing imports keep working without changes.

Usage:
    from csf_agent.embedder import CSFCooccurrenceVectorizer
    vec_fn = CSFCooccurrenceVectorizer()
    vec = vec_fn.vectorize(["dream", "convergence"])   # np.ndarray shape (vocab_size,)
    vec_fn.save("data/csf_memory/vectorizer.npy")
    vec2 = CSFCooccurrenceVectorizer.load("data/csf_memory/vectorizer.npy")

    # legacy alias
    from csf_agent.embedder import CSFEmbedder   # still works
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


class CSFCooccurrenceVectorizer:
    """
    Maps lists of string tokens to L2-normalized float32 co-occurrence vectors.

    ⚠️  This is a co-occurrence frequency counter over a fixed 34-token seed
    vocabulary. Cosine similarity between two vectors measures shared vocab
    overlap, NOT semantic meaning. Do not advertise as "semantic search".

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

    def vectorize(self, tokens: List[str]) -> np.ndarray:
        """Return L2-normalized co-occurrence frequency vector of vocab_size.

        Each position holds the co-occurrence weight of that vocab token scaled
        by how many times the token appears in `tokens`. Cosine similarity of
        two such vectors measures shared-vocabulary overlap only.
        """
        vec = np.zeros(self.vocab_size, dtype=np.float32)
        for tok in tokens:
            idx = self._vocab_index.get(str(tok).lower())
            if idx is not None:
                vec[idx] += self._weights[idx]
        return _l2_normalize(vec)

    def embed(self, tokens: List[str]) -> np.ndarray:
        """Backwards-compat alias for vectorize(). Prefer vectorize()."""
        return self.vectorize(tokens)

    def save(self, path: str | Path) -> None:
        """Save vocab + weights to a numpy .npy archive."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        np.save(str(path), {"vocab": self.vocab, "weights": self._weights}, allow_pickle=True)

    @classmethod
    def load(cls, path: str | Path) -> "CSFCooccurrenceVectorizer":
        """Load a previously saved vectorizer from .npy file."""
        data = np.load(str(path), allow_pickle=True).item()
        inst = cls.__new__(cls)
        inst.vocab = list(data["vocab"])
        inst._vocab_index = {t: i for i, t in enumerate(inst.vocab)}
        inst._weights = np.asarray(data["weights"], dtype=np.float32)
        return inst


# Backwards-compat alias — existing `from csf_agent.embedder import CSFEmbedder` keeps working.
# New code should use CSFCooccurrenceVectorizer.
CSFEmbedder = CSFCooccurrenceVectorizer
