"""
tests/test_csf_loop.py — integration tests for csf_agent.loop

Covers: --once --dry-run exits 0 and prints summary, --once writes file,
        get_pending_specs, skip-if-pending logic.
"""

import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from csf_agent.loop import run_once, get_pending_specs, _has_pending


# ── fixtures ──────────────────────────────────────────────────────────────────

def _make_issues(n=3):
    from datetime import datetime, timezone, timedelta
    issues = []
    for i in range(n):
        created = (datetime.now(timezone.utc) - timedelta(days=i)).isoformat()
        issues.append({
            "number": 100 + i,
            "title": f"Issue {i}",
            "body": f"fix convergence dream loop {i}",
            "labels": ["agent-task", "p0", "dream-journal"],
            "priority": 0,
            "stream": "dream-journal",
            "url": f"https://github.com/alex-place/lantern-os/issues/{100 + i}",
            "created_at": created,
        })
    return issues


def _patch_scanner(issues):
    return patch("csf_agent.loop.scan_issues", return_value=issues)


# ── get_pending_specs ─────────────────────────────────────────────────────────

def test_get_pending_specs_empty_dir():
    with tempfile.TemporaryDirectory() as tmp:
        specs = get_pending_specs(Path(tmp))
    assert specs == []


def test_get_pending_specs_missing_dir():
    specs = get_pending_specs(Path("/nonexistent/path/xyz"))
    assert specs == []


def test_get_pending_specs_finds_files():
    with tempfile.TemporaryDirectory() as tmp:
        ingest = Path(tmp)
        (ingest / "auto-2026-06-13-issue-042.md").write_text("spec content")
        (ingest / "auto-2026-06-14-issue-099.md").write_text("spec content 2")
        (ingest / "other-file.md").write_text("not a spec")
        specs = get_pending_specs(ingest)
    names = [s["name"] for s in specs]
    assert "auto-2026-06-13-issue-042.md" in names
    assert "auto-2026-06-14-issue-099.md" in names
    assert "other-file.md" not in names


def test_get_pending_specs_extracts_issue_number():
    with tempfile.TemporaryDirectory() as tmp:
        ingest = Path(tmp)
        (ingest / "auto-2026-06-13-issue-042.md").write_text("x")
        specs = get_pending_specs(ingest)
    assert specs[0]["issue_number"] == 42


# ── _has_pending ──────────────────────────────────────────────────────────────

def test_has_pending_false_empty():
    with tempfile.TemporaryDirectory() as tmp:
        assert not _has_pending(Path(tmp))


def test_has_pending_true_with_spec():
    with tempfile.TemporaryDirectory() as tmp:
        ingest = Path(tmp)
        (ingest / "auto-2026-06-13-issue-001.md").write_text("spec")
        assert _has_pending(ingest)


# ── run_once dry-run ──────────────────────────────────────────────────────────

def test_run_once_dry_run_exits_0(capsys):
    issues = _make_issues(2)
    with tempfile.TemporaryDirectory() as tmp:
        ingest = Path(tmp)
        with _patch_scanner(issues):
            code = run_once(dry_run=True, ingest_dir=ingest)
    assert code == 0
    out = capsys.readouterr().out
    assert "[csf-agent]" in out
    assert "scanned 2 issues" in out
    assert "--dry-run" in out


def test_run_once_dry_run_prints_top_issue(capsys):
    issues = _make_issues(3)
    with tempfile.TemporaryDirectory() as tmp:
        with _patch_scanner(issues):
            run_once(dry_run=True, ingest_dir=Path(tmp))
    out = capsys.readouterr().out
    assert "Issue 0" in out or "#100" in out  # top issue


def test_run_once_dry_run_writes_nothing():
    issues = _make_issues(2)
    with tempfile.TemporaryDirectory() as tmp:
        ingest = Path(tmp)
        with _patch_scanner(issues):
            run_once(dry_run=True, ingest_dir=ingest)
        assert not any(ingest.glob("auto-*.md"))


# ── run_once write mode ───────────────────────────────────────────────────────

def test_run_once_writes_spec():
    issues = _make_issues(1)
    with tempfile.TemporaryDirectory() as tmp:
        ingest = Path(tmp)
        with _patch_scanner(issues):
            code = run_once(dry_run=False, ingest_dir=ingest)
        assert code == 0
        specs = list(ingest.glob("auto-*.md"))
        assert len(specs) == 1


def test_run_once_no_issues_returns_1(capsys):
    with tempfile.TemporaryDirectory() as tmp:
        with _patch_scanner([]):
            code = run_once(dry_run=False, ingest_dir=Path(tmp))
    assert code == 1
    out = capsys.readouterr().out
    assert "0 issues" in out


def test_run_once_prints_summary(capsys):
    issues = _make_issues(5)
    with tempfile.TemporaryDirectory() as tmp:
        with _patch_scanner(issues):
            run_once(dry_run=True, ingest_dir=Path(tmp))
    out = capsys.readouterr().out
    assert "scanned 5 issues" in out
    assert "score=" in out
