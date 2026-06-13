"""
scanner.py — read GitHub issues labeled agent-task into a ranked CSF work list.

Usage:
    from csf_agent.scanner import scan_issues
    issues = scan_issues()  # list[dict], sorted by priority asc
"""

from __future__ import annotations

import json
import subprocess
from typing import Any, Dict, List, Optional

# Label → numeric priority
_PRIORITY_MAP = {"p0": 0, "p1": 1, "p2": 2}

# Label → stream name
_STREAM_MAP = {
    "dream-journal": "dream-journal",
    "convergence-io": "convergence-io",
    "csf-agent": "csf-agent",
}


def _extract_priority(labels: List[str]) -> int:
    for label in labels:
        if label in _PRIORITY_MAP:
            return _PRIORITY_MAP[label]
    return 99


def _extract_stream(labels: List[str]) -> Optional[str]:
    for label in labels:
        if label in _STREAM_MAP:
            return _STREAM_MAP[label]
    return None


def scan_issues(
    repo: str = "alex-place/lantern-os",
    required_label: str = "agent-task",
    limit: int = 100,
) -> List[Dict[str, Any]]:
    """
    Fetch open GitHub issues labeled `required_label` and return a list of dicts
    sorted by priority ascending (p0 first), then by issue number ascending.

    Returns empty list gracefully if gh is unavailable or returns no results.

    Each dict:
        number   int    — issue number
        title    str    — issue title
        body     str    — issue body (may be empty string)
        labels   list   — label name strings
        priority int    — 0/1/2/99
        stream   str|None — "dream-journal" | "convergence-io" | None
        url      str    — GitHub URL
        created_at str  — ISO timestamp
    """
    try:
        result = subprocess.run(
            [
                "gh", "issue", "list",
                "--repo", repo,
                "--label", required_label,
                "--state", "open",
                "--limit", str(limit),
                "--json", "number,title,body,labels,url,createdAt",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return []

    if result.returncode != 0:
        return []

    try:
        raw = json.loads(result.stdout)
    except json.JSONDecodeError:
        return []

    issues: List[Dict[str, Any]] = []
    for item in raw:
        label_names = [lb.get("name", "") for lb in item.get("labels", [])]
        issues.append(
            {
                "number": item.get("number", 0),
                "title": item.get("title", ""),
                "body": item.get("body", "") or "",
                "labels": label_names,
                "priority": _extract_priority(label_names),
                "stream": _extract_stream(label_names),
                "url": item.get("url", ""),
                "created_at": item.get("createdAt", ""),
            }
        )

    issues.sort(key=lambda i: (i["priority"], i["number"]))
    return issues
