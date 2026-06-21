#!/usr/bin/env bash
# Stop hook — "no uncommitted code" reminder.
# See AGENTS.md → Workspace Hygiene → "Commit discipline — no uncommitted code".
#
# WHAT IT DOES
#   Flags TRACKED source files that became uncommitted *during this session* — the delta
#   since SessionStart. This keeps the perpetual automation churn (data/, caches, files
#   already dirty at session start) quiet, so a hit actually means "you (the agent) likely
#   left code uncommitted; commit it to a PR".
#
# IT IS A REMINDER, NOT A GATE (always exit 0). The tree's ambient churn makes a hard block
# impractical — the rule is enforced by discipline + this nudge, not by refusing to stop.
#
# WIRING (local, per-machine — .claude/settings.json is gitignored):
#   "SessionStart": [{ "hooks": [{ "type": "command",
#       "command": "bash scripts/hooks/stop-warn-uncommitted.sh --snapshot" }]}],
#   "Stop":        [{ "hooks": [{ "type": "command",
#       "command": "bash scripts/hooks/stop-warn-uncommitted.sh" }]}]

set -uo pipefail

gitdir="$(git rev-parse --git-dir 2>/dev/null)" || exit 0
baseline="$gitdir/uncommitted-baseline.txt"

# --snapshot: record the session-start baseline of already-dirty tracked files, then exit.
if [ "${1:-}" = "--snapshot" ]; then
  git status --porcelain=v1 --untracked-files=no 2>/dev/null | sort > "$baseline" 2>/dev/null || true
  exit 0
fi

# No baseline (no SessionStart snapshot this session) → can't compute a delta; stay quiet.
[ -f "$baseline" ] || exit 0

current="$(git status --porcelain=v1 --untracked-files=no 2>/dev/null | sort)"

# Lines dirty NOW but not at session start = changed during this session. Keep only
# source files in code-bearing dirs (strip the 2-char status + space, and rename arrows).
new="$(comm -13 "$baseline" <(printf '%s\n' "$current") 2>/dev/null \
  | sed 's/^...//; s/^.* -> //' \
  | grep -E '\.(js|mjs|cjs|jsx|ts|tsx|py|rs|html|css)$' \
  | grep -E '^(apps/|src/|scripts/|services/|caad/|csf/)' || true)"

[ -z "$new" ] && exit 0

{
  echo "⚠️  Uncommitted code from this session — AGENTS.md rule: no uncommitted code."
  printf '%s\n' "$new" | sed 's/^/   • /'
  echo "   → Commit ONLY these files (git add <paths>, never -A) on your lane branch and open a PR."
  echo "   (Reminder only. Ambient automation churn is filtered out; this is the delta you touched.)"
} >&2
exit 0
