#!/usr/bin/env python3
"""
Pre-push change-record gate (fragment-based).

A code-bearing branch must add a changelog FRAGMENT under ``changelog.d/`` — a
uniquely-named, timestamped markdown file describing the change. There is NO
per-PR version bump and NO ``CHANGELOG.MD`` edit: concurrent PRs each drop their
own fragment, so nothing ever conflicts. ``scripts/assemble-changelog.js`` folds
every fragment into ``CHANGELOG.MD`` and bumps the version ONCE, at release.

Create a fragment (conflict-free, timestamped filename):
    node scripts/new-changelog.mjs "what changed and why"

For the current branch, compared against its merge-base with BASE_REF (default
``origin/master``), this enforces exactly one thing:

  * If the branch changed code files, it MUST have added at least one new
    ``changelog.d/*.md`` fragment.

Skips silently on master/dev/gh-pages, when BASE_REF cannot be resolved (e.g. no
``git fetch`` yet), or when only docs/tests/data/CI files changed.

Bypass: ``SKIP_VERSION_CHECK=1`` or ``SKIP_MONOWORKSTREAM=1``.

Run via the pre-push hook, or manually:
    python scripts/validate-prepush-version-changelog.py
"""

import os
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BASE_REF = os.environ.get("PREPUSH_BASE_REF", "origin/master")
SKIP_BRANCHES = {"master", "dev", "gh-pages"}

# Source files whose change requires a change record.
CODE_RE = re.compile(r"\.(js|mjs|cjs|jsx|ts|tsx|py|rs)$")
# Path prefixes that, on their own, do NOT require a change record. changelog.d/
# is here so a fragment-only change is never itself treated as "code".
NON_CODE_PREFIXES = (
    "tests/", "test/", "docs/", ".github/", ".claude/", "data/", "changelog.d/",
)
FRAG_DIR = "changelog.d/"


def run(cmd):
    proc = subprocess.run(
        cmd, cwd=REPO_ROOT, capture_output=True, encoding="utf-8", errors="replace",
    )
    return (proc.stdout or "").strip(), proc.returncode


def current_branch():
    out, code = run(["git", "symbolic-ref", "--short", "HEAD"])
    return out if code == 0 else ""


def ref_exists(ref):
    _, code = run(["git", "rev-parse", "--verify", "--quiet", ref])
    return code == 0


def changed_files(base):
    out, code = run(["git", "diff", "--name-only", base, "HEAD"])
    return [f for f in out.splitlines() if f] if code == 0 else []


def has_code_change(files):
    for f in files:
        if f.endswith(".md"):
            continue
        if any(f.startswith(p) for p in NON_CODE_PREFIXES):
            continue
        if CODE_RE.search(f):
            return True
    return False


def added_fragments(base):
    """New changelog.d/*.md fragment files added on this branch vs base."""
    out, code = run(
        ["git", "diff", "--name-only", "--diff-filter=A", base, "HEAD", "--", FRAG_DIR]
    )
    if code != 0:
        return []
    return [
        f for f in out.splitlines()
        if f.endswith(".md") and os.path.basename(f).lower() != "readme.md"
    ]


def main():
    if os.environ.get("SKIP_VERSION_CHECK") or os.environ.get("SKIP_MONOWORKSTREAM"):
        print("[prepush] change-record gate skipped (skip env set).")
        return 0

    branch = current_branch()
    if not branch or branch in SKIP_BRANCHES:
        return 0

    if not ref_exists(BASE_REF):
        print(
            f"[prepush] base ref '{BASE_REF}' unavailable — skipping change-record "
            f"gate (run 'git fetch origin' to enable)."
        )
        return 0

    merge_base, code = run(["git", "merge-base", BASE_REF, "HEAD"])
    base = merge_base if code == 0 and merge_base else BASE_REF

    files = changed_files(base)
    if not has_code_change(files):
        print("[prepush] no code changes vs base — change record not required.")
        return 0

    frags = added_fragments(base)
    if frags:
        print("[prepush] OK - change record: " + ", ".join(frags))
        return 0

    print("\n[prepush] CHANGE-RECORD GATE FAILED:")
    print("  - code changed but no changelog fragment was added under changelog.d/.")
    print("\n  Add one (a timestamped, conflict-free fragment):")
    print('    node scripts/new-changelog.mjs "what changed and why"')
    print("\n  No version bump or CHANGELOG.MD edit needed — assemble-changelog.js")
    print("  folds every fragment and bumps the version once, at release.")
    print("\n  Bypass: SKIP_VERSION_CHECK=1 git push   (or SKIP_MONOWORKSTREAM=1)")
    print("")
    return 1


if __name__ == "__main__":
    sys.exit(main())
