#!/usr/bin/env python3
"""
Pre-push gate: a code-bearing branch must carry a change record and a bumped
semantic version (X.X.X) relative to its PR base (origin/master).

For the current branch, compared against its merge-base with BASE_REF
(default ``origin/master``), this enforces:

  1. If the branch changed code files, ``package.json`` "version" MUST differ
     from the base version (i.e. it was bumped).
  2. The branch version MUST be strict semantic ``X.X.X`` (``^\\d+\\.\\d+\\.\\d+$``).
  3. The branch version MUST be greater than the base version.
  4. ``CHANGELOG.MD`` MUST contain a ``## [X.X.X] - YYYY-MM-DD`` entry for the
     branch version, with at least one non-empty content line (the change
     record itself).

Skips silently on master/dev/gh-pages, when BASE_REF cannot be resolved (e.g.
no ``git fetch`` yet), or when only docs/tests/data/CI files changed.

Bypass: ``SKIP_VERSION_CHECK=1`` or ``SKIP_MONOWORKSTREAM=1``.

Run via the pre-push hook, or manually:
    python scripts/validate-prepush-version-changelog.py
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BASE_REF = os.environ.get("PREPUSH_BASE_REF", "origin/master")
SKIP_BRANCHES = {"master", "dev", "gh-pages"}

# Source files whose change requires a version bump.
CODE_RE = re.compile(r"\.(js|mjs|cjs|jsx|ts|tsx|py|rs)$")
# Path prefixes that, on their own, do NOT require a version bump.
NON_CODE_PREFIXES = ("tests/", "test/", "docs/", ".github/", ".claude/", "data/")

SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")
CHANGELOG_NAMES = ("CHANGELOG.MD", "CHANGELOG.md", "CHANGELOG.markdown")


def run(cmd):
    """Run a git command at the repo root; return (stdout, returncode).

    Decode as UTF-8 (git's output encoding) so non-ASCII content — em dashes,
    emoji in CHANGELOG.MD — does not crash on Windows' cp1252 default.
    """
    proc = subprocess.run(
        cmd,
        cwd=REPO_ROOT,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    return (proc.stdout or "").strip(), proc.returncode


def current_branch():
    out, code = run(["git", "symbolic-ref", "--short", "HEAD"])
    return out if code == 0 else ""


def ref_exists(ref):
    _, code = run(["git", "rev-parse", "--verify", "--quiet", ref])
    return code == 0


def file_at_ref(ref, path):
    """Return file contents at a git ref, or None if absent."""
    out, code = run(["git", "show", f"{ref}:{path}"])
    return out if code == 0 else None


def version_at(ref):
    raw = file_at_ref(ref, "package.json")
    if raw is None:
        return None
    try:
        return json.loads(raw).get("version")
    except (ValueError, TypeError):
        return None


def changed_files(base):
    out, code = run(["git", "diff", "--name-only", base, "HEAD"])
    if code != 0:
        return []
    return [f for f in out.splitlines() if f]


def has_code_change(files):
    for f in files:
        if f.endswith(".md"):
            continue
        if any(f.startswith(p) for p in NON_CODE_PREFIXES):
            continue
        if CODE_RE.search(f):
            return True
    return False


def semver_tuple(version):
    return tuple(int(part) for part in version.split("."))


def read_changelog():
    """Changelog content as it will be pushed (HEAD), falling back to disk."""
    for name in CHANGELOG_NAMES:
        raw = file_at_ref("HEAD", name)
        if raw is not None:
            return raw, name
    for name in CHANGELOG_NAMES:
        path = REPO_ROOT / name
        if path.exists():
            return path.read_text(encoding="utf-8"), name
    return None, "CHANGELOG.MD"


def changelog_has_record(version):
    content, name = read_changelog()
    if content is None:
        return False, f"{name} not found"
    header = re.search(
        rf"^##\s*\[{re.escape(version)}\]\s*-\s*\d{{4}}-\d{{2}}-\d{{2}}",
        content,
        re.MULTILINE,
    )
    if not header:
        return False, f"no '## [{version}] - YYYY-MM-DD' entry in {name}"
    # Require at least one real content line before the next '## ' header.
    body_start = header.end()
    nxt = content.find("\n## ", body_start)
    body = content[body_start:] if nxt == -1 else content[body_start:nxt]
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped or stripped == "---" or stripped.startswith("#"):
            continue
        if stripped.startswith("**Build:**") or stripped.startswith("**Commit:**"):
            continue
        return True, "ok"
    return False, f"changelog entry for {version} has no content"


def main():
    if os.environ.get("SKIP_VERSION_CHECK") or os.environ.get("SKIP_MONOWORKSTREAM"):
        print("[prepush] change-record / version gate skipped (skip env set).")
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
        print("[prepush] no code changes vs base — version bump not required.")
        return 0

    base_version = version_at(base)
    new_version = version_at("HEAD")

    errors = []
    if not new_version:
        errors.append("could not read 'version' from package.json at HEAD")
    elif not SEMVER_RE.match(new_version):
        errors.append(
            f"version '{new_version}' is not X.X.X format (e.g. 1.4.3)"
        )
    else:
        if base_version and base_version == new_version:
            errors.append(
                f"code changed but version not bumped (still {base_version}). "
                f"Bump 'version' in package.json."
            )
        elif (
            base_version
            and SEMVER_RE.match(base_version)
            and semver_tuple(new_version) <= semver_tuple(base_version)
        ):
            errors.append(
                f"version {new_version} is not greater than base {base_version}."
            )

        ok, msg = changelog_has_record(new_version)
        if not ok:
            errors.append(f"missing change record: {msg}")

    if errors:
        print("\n[prepush] CHANGE-RECORD / VERSION GATE FAILED:")
        for err in errors:
            print(f"  - {err}")
        print(f"\n  Base ({BASE_REF}) version: {base_version}")
        print(f"  This branch version:      {new_version}")
        print("\n  To pass, in one commit on this branch:")
        print("    1. Bump \"version\" in package.json (X.X.X, greater than base).")
        print("    2. Add a matching entry at the top of CHANGELOG.MD:")
        print("         ## [X.X.X] - YYYY-MM-DD")
        print("         - what changed and why")
        print("\n  Bypass: SKIP_VERSION_CHECK=1 git push   (or SKIP_MONOWORKSTREAM=1)")
        print("")
        return 1

    print(
        f"[prepush] OK - version {base_version} -> {new_version} "
        f"with matching CHANGELOG.MD record."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
