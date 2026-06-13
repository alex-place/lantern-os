"""
tests/test_csf_scorer.py — unit tests for csf_agent.scorer

Covers: score ordering, tie-breaking, empty input, recency bonus.
"""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from csf_agent.embedder import CSFEmbedder
from csf_agent.scorer import score_issues, _z_score, _y_score, _recency_bonus


def _fresh_embedder() -> CSFEmbedder:
    return CSFEmbedder(jsonl_dirs=[])


def _issue(number, labels, body="", title="test issue", days_old=30):
    created = (datetime.now(timezone.utc) - timedelta(days=days_old)).isoformat()
    return {
        "number": number,
        "title": title,
        "body": body,
        "labels": labels,
        "priority": 99,
        "stream": None,
        "url": f"https://github.com/alex-place/lantern-os/issues/{number}",
        "created_at": created,
    }


# ── axis helpers ──────────────────────────────────────────────────────────────

def test_z_score_p0():
    assert _z_score(["agent-task", "p0"]) == 1.0

def test_z_score_p1():
    assert _z_score(["p1"]) == 0.6

def test_z_score_p2():
    assert _z_score(["p2"]) == 0.3

def test_z_score_unlabeled():
    assert _z_score(["bug"]) == 0.0

def test_y_score_dream_journal():
    assert _y_score(["dream-journal"]) == 1.0

def test_y_score_csf_agent():
    assert _y_score(["csf-agent"]) == 0.9

def test_y_score_convergence_io():
    assert _y_score(["convergence-io"]) == 0.8

def test_y_score_unlabeled():
    assert _y_score(["bug"]) == 0.0

def test_recency_bonus_recent():
    created = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    assert _recency_bonus(created) == 0.2

def test_recency_bonus_old():
    created = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    assert _recency_bonus(created) == 0.0

def test_recency_bonus_empty():
    assert _recency_bonus("") == 0.0


# ── score_issues ──────────────────────────────────────────────────────────────

def test_score_empty():
    emb = _fresh_embedder()
    assert score_issues([], emb) == []


def test_score_ordering():
    emb = _fresh_embedder()
    issues = [
        _issue(10, ["p2", "convergence-io"], body="fix validation"),
        _issue(5,  ["p0", "dream-journal"],  body="dream convergence loop"),
        _issue(20, ["p1", "csf-agent"],      body="agent scanner"),
    ]
    ranked = score_issues(issues, emb)
    # p0 + dream-journal should score highest
    assert ranked[0]["number"] == 5
    # p1 + csf-agent should beat p2 + convergence-io
    assert ranked[1]["number"] == 20
    assert ranked[2]["number"] == 10


def test_score_tie_broken_by_number_asc():
    emb = _fresh_embedder()
    # Two issues with identical labels and body → same score → lower number wins
    issues = [
        _issue(30, ["p1", "dream-journal"], body="same body"),
        _issue(10, ["p1", "dream-journal"], body="same body"),
    ]
    ranked = score_issues(issues, emb)
    assert ranked[0]["number"] == 10
    assert ranked[1]["number"] == 30


def test_score_field_added():
    emb = _fresh_embedder()
    issues = [_issue(1, ["p0", "dream-journal"])]
    ranked = score_issues(issues, emb)
    assert "score" in ranked[0]
    assert 0.0 <= ranked[0]["score"] <= 1.5  # theoretical max ~1.0 + 0.2 recency


def test_score_recency_increases_score():
    emb = _fresh_embedder()
    old   = _issue(1, ["p1", "dream-journal"], days_old=30)
    fresh = _issue(2, ["p1", "dream-journal"], days_old=1)
    ranked = score_issues([old, fresh], emb)
    assert ranked[0]["number"] == 2  # fresh issue wins same-label tie
