#!/usr/bin/env python3
"""
Pre-push gate: block "revert-to-stale-blob" clobbers.

Root cause this guards against (first seen in 2fd3598c, 2026-07-01): a session
commits accumulated worktree state wholesale ("sync worktree state") from a
worktree whose files predate recently merged PRs. The commit's file contents
are byte-identical to OLD master versions, so pushing it silently reverts the
merged work (e.g. index.html lost PR #1763's compact home layout).

Detection, per file modified between merge-base(HEAD, origin/master) and HEAD:
the blob HEAD writes for the file is byte-identical to a HISTORICAL
origin/master blob of that same file (older than the merge-base version) while
differing from the merge-base blob. Editing on top of current content never
matches an old blob exactly, so false positives are rare; wholesale stale
copies match exactly and are caught.

Skips on master/dev/gh-pages, when origin/master is unresolvable, and for
files under data/ (runtime state churns legitimately).

Bypass: SKIP_CLOBBER_CHECK=1 git push ...
(Deliberately NOT bypassed by SKIP_MONOWORKSTREAM — the automation that uses
that flag is exactly what produced the clobber.)
"""

import os
import subprocess
import sys

BASE_REF = os.environ.get("PREPUSH_BASE_REF", "origin/master")
SKIP_BRANCHES = {"master", "dev", "gh-pages"}
SKIP_PREFIXES = ("data/",)
HISTORY_DEPTH = 100  # how many past master commits of a file to compare against


def git(*args):
    return subprocess.run(
        ["git", *args], capture_output=True, text=True, check=False
    ).stdout.strip()


def main() -> int:
    if os.environ.get("SKIP_CLOBBER_CHECK") == "1":
        return 0
    branch = git("symbolic-ref", "--short", "HEAD")
    if not branch or branch in SKIP_BRANCHES:
        return 0
    base = git("merge-base", "HEAD", BASE_REF)
    if not base:
        return 0

    changed = [
        f
        for f in git("diff", "--name-only", "--diff-filter=M", base, "HEAD").splitlines()
        if f and not f.startswith(SKIP_PREFIXES)
    ]
    clobbers = []
    for f in changed:
        head_blob = git("rev-parse", f"HEAD:{f}")
        base_blob = git("rev-parse", f"{base}:{f}")
        if not head_blob or not base_blob or head_blob == base_blob:
            continue
        # All (commit, blob) pairs for this file on master, newest first.
        raw = git(
            "log", "--format=%H", f"-{HISTORY_DEPTH}", BASE_REF, "--", f
        ).splitlines()
        seen_base = False
        for commit in raw:
            blob = git("rev-parse", f"{commit}:{f}")
            if blob == base_blob and not seen_base:
                seen_base = True
                continue
            if seen_base and blob == head_blob:
                # HEAD's content is an OLDER master version than the base's:
                # this push reverts merged work.
                subj = git("log", "-1", "--format=%h %s", commit)
                clobbers.append((f, subj))
                break

    if not clobbers:
        return 0
    print("")
    print("STALE-CLOBBER BLOCK: this push rewrites file(s) back to an OLDER")
    print("master version, silently reverting merged work (the 2fd3598c bug):")
    for f, subj in clobbers:
        print(f"  {f}")
        print(f"    -> byte-identical to master as of: {subj}")
    print("")
    print("Fix: rebase on origin/master and re-apply only your intended edits,")
    print("or restore the file: git checkout origin/master -- <file>")
    print("Bypass (only if the revert is intentional): SKIP_CLOBBER_CHECK=1 git push ...")
    print("")
    return 1


if __name__ == "__main__":
    sys.exit(main())
