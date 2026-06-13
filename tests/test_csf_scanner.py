"""
tests/test_csf_scanner.py — unit tests for csf_agent.scanner

Covers: happy path, empty result, priority sort, gh unavailable.
"""

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from csf_agent.scanner import scan_issues, _extract_priority, _extract_stream


# ── helpers ──────────────────────────────────────────────────────────────────

def _make_gh_issue(number, title, labels, body="", url="", created_at="2026-06-13T00:00:00Z"):
    return {
        "number": number,
        "title": title,
        "body": body,
        "labels": [{"name": lbl} for lbl in labels],
        "url": url or f"https://github.com/alex-place/lantern-os/issues/{number}",
        "createdAt": created_at,
    }


def _mock_run(issues):
    """Return a mock subprocess result with the given issue list as JSON."""
    mock = MagicMock()
    mock.returncode = 0
    mock.stdout = json.dumps(issues)
    return mock


# ── unit tests ────────────────────────────────────────────────────────────────

def test_extract_priority_p0():
    assert _extract_priority(["agent-task", "p0", "dream-journal"]) == 0


def test_extract_priority_p1():
    assert _extract_priority(["p1"]) == 1


def test_extract_priority_unlabeled():
    assert _extract_priority(["bug", "help wanted"]) == 99


def test_extract_stream_dream_journal():
    assert _extract_stream(["agent-task", "dream-journal"]) == "dream-journal"


def test_extract_stream_convergence_io():
    assert _extract_stream(["convergence-io"]) == "convergence-io"


def test_extract_stream_none():
    assert _extract_stream(["bug"]) is None


def test_scan_issues_happy_path():
    raw = [
        _make_gh_issue(10, "Fix scanner", ["agent-task", "p1", "convergence-io"]),
        _make_gh_issue(5,  "Add embedder", ["agent-task", "p0", "dream-journal"]),
        _make_gh_issue(20, "Docs update",  ["agent-task"]),
    ]
    with patch("csf_agent.scanner.subprocess.run", return_value=_mock_run(raw)):
        issues = scan_issues()

    assert len(issues) == 3
    # p0 (issue 5) should come first
    assert issues[0]["number"] == 5
    assert issues[0]["priority"] == 0
    assert issues[0]["stream"] == "dream-journal"
    # p1 (issue 10) second
    assert issues[1]["number"] == 10
    assert issues[1]["priority"] == 1
    # unlabeled (issue 20) last
    assert issues[2]["priority"] == 99


def test_scan_issues_empty_result():
    with patch("csf_agent.scanner.subprocess.run", return_value=_mock_run([])):
        issues = scan_issues()
    assert issues == []


def test_scan_issues_gh_not_found():
    import subprocess as sp
    with patch("csf_agent.scanner.subprocess.run", side_effect=FileNotFoundError):
        issues = scan_issues()
    assert issues == []


def test_scan_issues_gh_nonzero_exit():
    mock = MagicMock()
    mock.returncode = 1
    mock.stdout = ""
    with patch("csf_agent.scanner.subprocess.run", return_value=mock):
        issues = scan_issues()
    assert issues == []


def test_scan_issues_bad_json():
    mock = MagicMock()
    mock.returncode = 0
    mock.stdout = "not json {"
    with patch("csf_agent.scanner.subprocess.run", return_value=mock):
        issues = scan_issues()
    assert issues == []


def test_scan_issues_priority_tie_broken_by_number():
    raw = [
        _make_gh_issue(20, "Second p1", ["agent-task", "p1"]),
        _make_gh_issue(10, "First p1",  ["agent-task", "p1"]),
    ]
    with patch("csf_agent.scanner.subprocess.run", return_value=_mock_run(raw)):
        issues = scan_issues()
    assert issues[0]["number"] == 10  # older issue wins tie
    assert issues[1]["number"] == 20
