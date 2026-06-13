"""
suggester.py — generate a csf/ingest/ task spec from the top-scored issue.

Output follows the existing csf/ingest/*.md convention so agents can pick it
up without any additional tooling.

Usage:
    from csf_agent.suggester import generate_spec, write_spec
    md = generate_spec(issue, score=0.87)
    write_spec(issue, score=0.87)          # writes csf/ingest/auto-YYYY-MM-DD-issue-NNN.md
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_INGEST_DIR = _REPO_ROOT / "csf" / "ingest"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _extract_checklist(body: str) -> str:
    """Pull markdown checklist lines from body."""
    lines = [ln for ln in body.splitlines() if re.match(r"^\s*-\s*\[", ln)]
    return "\n".join(lines) if lines else "_No checklist items found in issue body._"


def _extract_test_command(body: str) -> str:
    """Extract the first code block after 'Test command'."""
    m = re.search(
        r"##\s*Test command.*?```(?:bash|sh|python)?\s*\n(.*?)```",
        body,
        re.DOTALL | re.IGNORECASE,
    )
    if m:
        return m.group(1).strip()
    # Fallback: look for pytest line
    m2 = re.search(r"python -m pytest[^\n]*", body)
    if m2:
        return m2.group(0).strip()
    return "_(see issue body)_"


def _infer_files(body: str, title: str) -> str:
    """Extract 'Files to create' section or infer from keywords."""
    m = re.search(
        r"##\s*Files to create.*?\n(.*?)(?=\n##|\Z)",
        body,
        re.DOTALL | re.IGNORECASE,
    )
    if m:
        lines = [ln.strip() for ln in m.group(1).splitlines() if ln.strip().startswith("-")]
        if lines:
            return "\n".join(lines)
    # Fallback: look for backtick paths
    paths = re.findall(r"`(src/[^\s`]+|tests/[^\s`]+|apps/[^\s`]+)`", body)
    if paths:
        return "\n".join(f"- `{p}`" for p in dict.fromkeys(paths))
    return "_(infer from issue body)_"


def generate_spec(issue: Dict[str, Any], score: float) -> str:
    """Return the markdown task spec string for the given issue."""
    number = issue.get("number", 0)
    title = issue.get("title", "untitled")
    body = (issue.get("body", "") or "").strip()
    stream = issue.get("stream") or "unspecified"
    url = issue.get("url", f"https://github.com/alex-place/lantern-os/issues/{number}")

    body_preview = body[:500] + ("…" if len(body) > 500 else "")
    checklist = _extract_checklist(body)
    test_cmd = _extract_test_command(body)
    files = _infer_files(body, title)

    return f"""# auto: {title}

**Source:** GitHub #{number} — {url}
**Score:** {score:.4f}
**Stream:** {stream}
**Generated:** {_now_iso()}

## Problem

{body_preview}

## Proposed implementation

{files}

## Files likely to change

{files}

## Acceptance criteria

{checklist}

## Test command

```bash
{test_cmd}
```
"""


def write_spec(
    issue: Dict[str, Any],
    score: float,
    ingest_dir: Optional[Path] = None,
) -> Path:
    """
    Write the task spec to csf/ingest/auto-YYYY-MM-DD-issue-NNN.md.
    Does not overwrite if the file already exists for this issue number.
    Returns the path (whether written or pre-existing).
    """
    ingest_dir = ingest_dir or _DEFAULT_INGEST_DIR
    ingest_dir.mkdir(parents=True, exist_ok=True)

    number = issue.get("number", 0)
    filename = f"auto-{_today()}-issue-{number:03d}.md"
    dest = ingest_dir / filename

    if dest.exists():
        return dest  # idempotent — do not overwrite

    content = generate_spec(issue, score)
    dest.write_text(content, encoding="utf-8")
    return dest
