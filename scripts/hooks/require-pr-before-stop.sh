#!/usr/bin/env bash
# Stop hook — block stopping while work is unpushed (not tracked in the remote).
#
# WHY: The repo rule is that work lands as a PR on the remote, not as local commits or
# stashes that sprawl and never get tracked. At stop time:
#   • Unpushed commits (reachable from HEAD, on no remote) → HARD BLOCK (decision:block):
#     finished work must not be left out of the remote. Actionable: push + open/append a PR.
#   • Parked git stashes → SOFT REMINDER on stderr only. Blocking every stop on a
#     pre-existing stash backlog would be a trap; new stashes are already blocked at
#     creation by block-git-stash.sh, so this just surfaces the standing pile.
#
# The block is a one-shot nudge: the stop_hook_active guard means it blocks at most once
# per stop cycle, so the agent gets a forceful reminder but can never be trapped in a loop
# (e.g. when offline and a push genuinely can't happen).
#
# No-ops (exit 0) outside a git repo, when no remote is configured, or when nothing is
# parked. Uncommitted *working-tree* changes are intentionally NOT covered here — the
# companion reminder stop-warn-uncommitted.sh handles those. See AGENTS.md monoworkstream.
#
# WIRING (local; .claude/settings.json is gitignored):
#   "Stop": [{ "hooks": [{ "type": "command",
#       "command": "bash scripts/hooks/require-pr-before-stop.sh" }]}]
set -uo pipefail

input="$(cat)"

# Loop guard: if this stop is already a continuation of a prior stop-hook block, allow it.
case "$input" in
  *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;;
esac

# Only meaningful inside a git repo that has a remote to push to.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
[ -n "$(git remote 2>/dev/null)" ] || exit 0

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
unpushed="$(git log --oneline HEAD --not --remotes 2>/dev/null | wc -l | tr -d ' ')"
stashes="$(git stash list 2>/dev/null | wc -l | tr -d ' ')"

PY="$(command -v python 2>/dev/null || command -v python3 2>/dev/null || true)"

# HARD GATE: never finish with unpushed commits — that is finished work missing from the
# remote. This is the actionable case (usually a handful of commits on a lane branch).
if [ "${unpushed:-0}" != "0" ]; then
  reason="Don't stop yet — ${unpushed} local commit(s) on '${branch}' are on no remote (unpushed). Land them as a PR before finishing: push the lane branch and open or append a PR (git push + gh). If a PR for this branch already exists, just push to it. Then stopping is fine. If this is genuinely throwaway, say so to the user explicitly instead of leaving it local-only. (See AGENTS.md monoworkstream rules.)"
  [ "${stashes:-0}" != "0" ] && reason="$reason Also: ${stashes} stash(es) are parked locally — recover and land them too, or drop them (git stash list)."
  if [ -n "$PY" ]; then
    REASON="$reason" "$PY" -c 'import json,os
print(json.dumps({"decision":"block","reason":os.environ["REASON"]}))'
  else
    esc="$(printf '%s' "$reason" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    printf '{"decision":"block","reason":"%s"}\n' "$esc"
  fi
  exit 0
fi

# SOFT REMINDER: parked stashes are sprawl, but blocking every stop on a pre-existing
# backlog would be a trap (and new stashes are already blocked at creation by
# block-git-stash.sh). Nudge on stderr; never gate.
if [ "${stashes:-0}" != "0" ]; then
  echo "⚠️  ${stashes} git stash(es) parked locally — work hidden from the remote. Recover & land them as PRs, or drop them: git stash list / pop / drop. (Reminder only.)" >&2
fi
exit 0
