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
# PER-SESSION STATE (concurrency): this checkout is shared by concurrent Claude sessions.
#   State is keyed by the session_id from the hook's stdin JSON and stored under
#   $GIT_DIR/claude-session-state/<sid>.* — a second session's SessionStart no longer
#   clobbers the first session's baseline (the old single uncommitted-baseline.txt did
#   exactly that, corrupting everyone's delta). --snapshot also records the session-start
#   HEAD (<sid>.head), which the companion require-pr-before-stop.sh reads to attribute
#   commits to sessions. Stale state files are pruned after 7 days.
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

input="$(cat 2>/dev/null || true)"

gitdir="$(git rev-parse --git-dir 2>/dev/null)" || exit 0
state_dir="$gitdir/claude-session-state"
legacy_baseline="$gitdir/uncommitted-baseline.txt"

# Session id from the hook's stdin JSON (python; sed fallback). Empty → legacy shared file.
PY="$(command -v python 2>/dev/null || command -v python3 2>/dev/null || true)"
if [ -n "$PY" ]; then
  sid="$(printf '%s' "$input" | "$PY" -c 'import json,sys
try: print(json.load(sys.stdin).get("session_id","") or "")
except Exception: pass' 2>/dev/null)"
else
  sid="$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
fi
sid="${sid//[^a-zA-Z0-9_-]/}"

if [ -n "$sid" ]; then
  baseline="$state_dir/$sid.uncommitted-baseline"
else
  baseline="$legacy_baseline"
fi

# --snapshot: record the session-start baseline of already-dirty tracked files + the
# session-start HEAD (for require-pr-before-stop.sh attribution), then exit.
if [ "${1:-}" = "--snapshot" ]; then
  mkdir -p "$state_dir" 2>/dev/null || true
  find "$state_dir" -type f -mtime +7 -delete 2>/dev/null || true
  git status --porcelain=v1 --untracked-files=no 2>/dev/null | sort > "$baseline" 2>/dev/null || true
  [ -n "$sid" ] && git rev-parse HEAD > "$state_dir/$sid.head" 2>/dev/null || true
  exit 0
fi

# No per-session baseline (SessionStart predates the per-session upgrade, or no snapshot
# ran) → fall back to the legacy shared file; without either, stay quiet.
[ -f "$baseline" ] || baseline="$legacy_baseline"
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
