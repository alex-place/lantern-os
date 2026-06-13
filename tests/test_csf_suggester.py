"""
tests/test_csf_suggester.py — unit tests for csf_agent.suggester

Covers: output contains title/number/score, checklist extraction,
        file non-overwrite, write path format.
"""

import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from csf_agent.suggester import generate_spec, write_spec


def _issue(number=42, title="Fix the scanner", body="", stream="dream-journal"):
    return {
        "number": number,
        "title": title,
        "body": body,
        "labels": ["agent-task", "p1", stream],
        "priority": 1,
        "stream": stream,
        "url": f"https://github.com/alex-place/lantern-os/issues/{number}",
        "created_at": "2026-06-13T10:00:00Z",
    }


BODY_WITH_CHECKLIST = """
## Acceptance Criteria
- [ ] `src/csf_agent/scanner.py` exists
- [ ] `scan_issues()` returns a list
- [x] Already done thing

## Test command
```bash
python -m pytest tests/test_csf_scanner.py -q --tb=short
```

## Files to create
- `src/csf_agent/scanner.py`
- `tests/test_csf_scanner.py`
"""


def test_generate_spec_contains_title():
    md = generate_spec(_issue(title="Fix the scanner"), score=0.85)
    assert "Fix the scanner" in md


def test_generate_spec_contains_number():
    md = generate_spec(_issue(number=42), score=0.85)
    assert "#42" in md


def test_generate_spec_contains_score():
    md = generate_spec(_issue(), score=0.8765)
    assert "0.8765" in md


def test_generate_spec_contains_stream():
    md = generate_spec(_issue(stream="dream-journal"), score=0.5)
    assert "dream-journal" in md


def test_generate_spec_checklist_extracted():
    issue = _issue(body=BODY_WITH_CHECKLIST)
    md = generate_spec(issue, score=0.9)
    assert "scan_issues()" in md
    assert "- [ ]" in md


def test_generate_spec_test_command_extracted():
    issue = _issue(body=BODY_WITH_CHECKLIST)
    md = generate_spec(issue, score=0.9)
    assert "pytest tests/test_csf_scanner.py" in md


def test_generate_spec_no_body():
    md = generate_spec(_issue(body=""), score=0.1)
    assert "Fix the scanner" in md  # title still present


def test_write_spec_creates_file():
    issue = _issue(number=99, body=BODY_WITH_CHECKLIST)
    with tempfile.TemporaryDirectory() as tmp:
        ingest = Path(tmp)
        path = write_spec(issue, score=0.77, ingest_dir=ingest)
        assert path.exists()
        content = path.read_text(encoding="utf-8")
        assert "#99" in content
        assert "0.7700" in content


def test_write_spec_no_overwrite():
    issue = _issue(number=77)
    with tempfile.TemporaryDirectory() as tmp:
        ingest = Path(tmp)
        path1 = write_spec(issue, score=0.5, ingest_dir=ingest)
        original = path1.read_text(encoding="utf-8")
        # Write again — should not overwrite
        path2 = write_spec(issue, score=0.9, ingest_dir=ingest)
        assert path1 == path2
        assert path2.read_text(encoding="utf-8") == original  # unchanged


def test_write_spec_filename_format():
    import re
    issue = _issue(number=123)
    with tempfile.TemporaryDirectory() as tmp:
        path = write_spec(issue, score=0.6, ingest_dir=Path(tmp))
        assert re.match(r"auto-\d{4}-\d{2}-\d{2}-issue-123\.md", path.name)
