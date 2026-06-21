"""
scorer.py — rank issues via tesseract axes + CSF co-occurrence similarity.

Score = 0.4*z + 0.3*y + 0.2*cosine_sim(vectorize(keywords), vectorize(body_tokens)) + 0.1*t

Tesseract axes:
  z (boundary/priority): p0→1.0, p1→0.6, p2→0.3, unlabeled→0.0
  y (lane/stream):        dream-journal→1.0, convergence-io→0.8, csf-agent→0.9, other→0.0
  cosine_sim:             ⚠️ co-occurrence vocabulary overlap (NOT semantic similarity) — see #937
  t (recency):            +0.2 bonus for issues created within last 7 days

Usage:
    from csf_agent.scanner import scan_issues
    from csf_agent.embedder import CSFCooccurrenceVectorizer
    from csf_agent.scorer import score_issues

    issues = scan_issues()
    vec_fn = CSFCooccurrenceVectorizer()
    ranked = score_issues(issues, vec_fn)
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Dict, List

import numpy as np

from csf_agent.embedder import CSFEmbedder

# Axis weight coefficients (must sum to 1.0)
_W_Z = 0.4   # priority/boundary
_W_Y = 0.3   # stream/lane
_W_SIM = 0.2  # co-occurrence cosine similarity (⚠️ vocab overlap, not semantic — #937)
_W_T = 0.1   # recency

_Z_MAP = {"p0": 1.0, "p1": 0.6, "p2": 0.3}
_Y_MAP = {
    "dream-journal": 1.0,
    "csf-agent": 0.9,
    "convergence-io": 0.8,
}
_RECENCY_DAYS = 7


def _z_score(labels: List[str]) -> float:
    for lbl in labels:
        if lbl in _Z_MAP:
            return _Z_MAP[lbl]
    return 0.0


def _y_score(labels: List[str]) -> float:
    best = 0.0
    for lbl in labels:
        best = max(best, _Y_MAP.get(lbl, 0.0))
    return best


def _tokenize(text: str) -> List[str]:
    """Simple whitespace + punctuation tokenizer → lowercase tokens."""
    return re.findall(r"[a-z0-9_\-]+", text.lower())


def _cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    na = np.linalg.norm(a)
    nb = np.linalg.norm(b)
    if na < 1e-9 or nb < 1e-9:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def _recency_bonus(created_at: str) -> float:
    if not created_at:
        return 0.0
    try:
        dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        age_days = (datetime.now(timezone.utc) - dt).total_seconds() / 86400
        return 0.2 if age_days <= _RECENCY_DAYS else 0.0
    except (ValueError, TypeError):
        return 0.0


def score_issues(
    issues: List[Dict[str, Any]],
    embedder: CSFEmbedder,
) -> List[Dict[str, Any]]:
    """
    Add a `score` float to each issue dict and return list sorted descending.
    Ties broken by issue number ascending (oldest first).
    """
    if not issues:
        return []

    scored = []
    for issue in issues:
        labels = issue.get("labels", [])
        body = issue.get("body", "") or ""
        title = issue.get("title", "") or ""

        z = _z_score(labels)
        y = _y_score(labels)

        # Embed title+labels as "keywords", body as context
        keyword_tokens = _tokenize(title) + labels
        body_tokens = _tokenize(body)

        kw_vec = embedder.embed(keyword_tokens)
        body_vec = embedder.embed(body_tokens)
        sim = _cosine_sim(kw_vec, body_vec)

        t = _recency_bonus(issue.get("createdAt", "") or issue.get("created_at", ""))

        score = round(_W_Z * z + _W_Y * y + _W_SIM * sim + _W_T * t, 4)

        scored.append({**issue, "score": score})

    scored.sort(key=lambda i: (-i["score"], i["number"]))
    return scored
