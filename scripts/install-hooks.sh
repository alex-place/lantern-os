#!/bin/sh
# Activate the repo-managed git hooks.
#
# The hooks live in scripts/hooks/ and are version-controlled, so contributors run
# the SAME pre-commit / commit-msg / pre-push checks. Instead of copying them into
# .git/hooks (which drifts and must be re-run on every hook change), we point git at
# the tracked directory with core.hooksPath — so an edit to a hook takes effect for
# everyone on their next pull, no reinstall needed.
#
# This normally runs automatically from the `prepare` npm script on `npm install`.
# Run it by hand after cloning if you skipped install: `bash scripts/install-hooks.sh`
# (or `npm run hooks`, or `make hooks`).
#
# Usage: bash scripts/install-hooks.sh
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if command -v node >/dev/null 2>&1 && [ -f scripts/setup-hooks.mjs ]; then
  # One source of truth: the node setup also marks the hooks executable in git.
  node scripts/setup-hooks.mjs
else
  # Fallback when node is unavailable: set the path and exec bits directly.
  git config core.hooksPath scripts/hooks
  for h in pre-commit commit-msg prepare-commit-msg pre-push post-merge post-checkout post-commit; do
    [ -f "scripts/hooks/$h" ] && chmod +x "scripts/hooks/$h" 2>/dev/null || true
    [ -f "scripts/hooks/$h" ] && git update-index --chmod=+x "scripts/hooks/$h" 2>/dev/null || true
  done
  echo "[hooks] set core.hooksPath = scripts/hooks — repo-managed git hooks active."
fi

echo ""
echo "[OK] Repo-managed hooks active. Enforced on commit/push:"
echo "  - pre-commit:  per-lane workstream gate + slop scan (secrets/debug/sqli/exec/size) + consolidation"
echo "  - commit-msg:  blocks slop messages (empty, <8 chars, wip, placeholder, temp, ...)"
echo "  - pre-push:    master protection + change-record/version gate + stale-clobber gate"
echo "                 + SPRAWL TRIPWIRE (new public surface must declare a loop stage, #1561)"
echo "                 + per-lane workstream gate + staleness block + git-lfs"
echo "  - post-merge:  stale-branch + pending-changelog-fragment warnings"
echo ""
echo "Bypass (per push/commit): SKIP_MONOWORKSTREAM=1 | SKIP_SPRAWL_CHECK=1 | SKIP_VERSION_CHECK=1"
echo "Override master push:     OVERRIDE_MERGE=1 git push origin master"
echo ""
echo "To deactivate: git config --unset core.hooksPath"
