#!/usr/bin/env python3
"""
Pre-commit change-record reminder (fragment-based).

The authoritative gate lives at pre-push (validate-prepush-version-changelog.py):
a code-bearing branch must add a timestamped fragment under ``changelog.d/``.
This pre-commit check is a light reminder only — if code is staged without a
staged changelog fragment, it prints a hint but does NOT block the commit, so
you can commit freely and drop the fragment before you push.

Create a fragment:  node scripts/new-changelog.mjs "what changed and why"

Run via pre-commit hook, or manually:
    python scripts/validate-version-changelog.py
"""

import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# Code files that make a change record advisable (ignore tests/docs/data/CI).
CODE_FILES_PATTERN = re.compile(
    r"""^(?!test/|tests/|docs/|\.github/|\.claude/|data/|changelog\.d/)
        .*\.(js|mjs|cjs|jsx|ts|tsx|py|rs)$""",
    re.VERBOSE,
)


def run_cmd(cmd):
    try:
        result = subprocess.run(
            cmd, shell=True, cwd=str(REPO_ROOT),
            capture_output=True, encoding="utf-8", errors="replace",
        )
        return (result.stdout or "").strip(), result.returncode
    except Exception as e:  # noqa: BLE001
        return str(e), 1


def staged_files():
    out, _ = run_cmd("git diff --cached --name-only")
    return [f for f in out.split("\n") if f]


def main():
    files = staged_files()
    has_code = any(CODE_FILES_PATTERN.match(f) for f in files)
    staged_fragment = any(
        f.startswith("changelog.d/") and f.endswith(".md")
        and Path(f).name.lower() != "readme.md"
        for f in files
    )

    if has_code and not staged_fragment:
        print(
            "[change-record] reminder: code is staged without a changelog fragment.\n"
            '  Add one before you push:  node scripts/new-changelog.mjs "what changed and why"\n'
            "  (No version bump / CHANGELOG.MD edit — folded once at release.)"
        )
    # Non-blocking: the pre-push gate enforces this.
    return 0


if __name__ == "__main__":
    sys.exit(main())
