#!/usr/bin/env bash
# Stop hook — DON'T STOP until finished work is on a PR. ("like Keystone would.")
#
# WHY: The repo rule is that work lands as a PR on the remote — not as local commits or
# pushed-but-PR-less branches. At stop time this gate blocks (decision:block) on the two
# states that RELIABLY mean "my finished work isn't on a PR yet":
#
#   1. UNPUSHED COMMITS — commits on HEAD that are on no remote. Push + open/append a PR.
#   2. PUSHED, NO PR — a lane branch with commits beyond origin/master but no OPEN PR.
#      Pushing isn't finishing; the work must be a PR. Open one (gh pr create / gh api).
#
# Uncommitted *working-tree* edits are intentionally NOT a hard gate: this shared checkout's
# background automation continuously dirties tracked source files (server.js, libs, …), so
# blocking on them produces false positives that cite files the agent never touched. The
# companion stop-warn-uncommitted.sh handles that as a SOFT, session-delta reminder instead.
#
# SAFETY (never traps):
#   • Loop guard — stop_hook_active means it blocks at most ONCE per stop cycle, so an
#     offline push / genuinely-unfinishable state gets one forceful nudge, never a loop.
#   • Fail-open — gh/network errors never block (can't open a PR offline → don't trap).
#   • Protected branches (master/main/dev/gh-pages) skip the PR gate.
#
# WIRING: "Stop": [{ "hooks": [{ "type": "command",
#            "command": "bash scripts/hooks/require-pr-before-stop.sh" }]}]
# Companion: stop-warn-uncommitted.sh (soft lister) + its --snapshot at SessionStart.
# See AGENTS.md monoworkstream rules.
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

# Emit a decision:block with the given reason, then exit. JSON via python, sed fallback.
block() {
  local reason="$1"
  local PY; PY="$(command -v python 2>/dev/null || command -v python3 2>/dev/null || true)"
  if [ -n "$PY" ]; then
    REASON="$reason" "$PY" -c 'import json,os; print(json.dumps({"decision":"block","reason":os.environ["REASON"]}))'
  else
    local esc; esc="$(printf '%s' "$reason" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    printf '{"decision":"block","reason":"%s"}\n' "$esc"
  fi
  exit 0
}

# ── Gate 1: unpushed commits (applies on every branch) ──────────────────────────────
unpushed="$(git log --oneline HEAD --not --remotes 2>/dev/null | wc -l | tr -d ' ')"
stashes="$(git stash list 2>/dev/null | wc -l | tr -d ' ')"
if [ "${unpushed:-0}" != "0" ]; then
  reason="Don't stop yet — ${unpushed} local commit(s) on '${branch}' are on no remote (unpushed). Land them as a PR before finishing: push the lane branch and open or append a PR (git push + gh). If a PR for this branch already exists, just push to it. If this is genuinely throwaway, say so to the user explicitly instead of leaving it local-only. (AGENTS.md monoworkstream.)"
  [ "${stashes:-0}" != "0" ] && reason="$reason Also: ${stashes} stash(es) parked locally — recover & land them, or drop them (git stash list)."
  block "$reason"
fi

# Protected branches: don't gate on PR-existence or working-tree edits (master auto-deploys).
case "$branch" in
  master|main|dev|gh-pages|HEAD|'?')
    [ "${stashes:-0}" != "0" ] && echo "⚠️  ${stashes} git stash(es) parked locally — land or drop them (reminder only)." >&2
    exit 0 ;;
esac

# ── Gate 2: pushed (no unpushed commits) but NO open PR for a lane branch ────────────
# Has this branch any commits beyond origin/master? If so it's real work that must be a PR.
base="$(git merge-base HEAD origin/master 2>/dev/null || true)"
ahead="$(git rev-list --count ${base:+${base}..}HEAD 2>/dev/null || echo 0)"
if [ "${ahead:-0}" -gt 0 ]; then
  # Fail-open: any gh error (offline, not authed) yields a non-"0" value → no false block.
  has_pr="$(gh pr list --head "$branch" --state open --json number --jq 'length' 2>/dev/null || echo 'err')"
  if [ "$has_pr" = "0" ]; then
    block "Don't stop yet — branch '${branch}' has ${ahead} commit(s) beyond origin/master but NO open PR. Pushing isn't finishing: open a PR (gh pr create, or gh api if blocked). The standing rule is that finished work lands on a PR. If you truly mean to leave this branch PR-less, tell the user why."
  fi
fi

# Uncommitted working-tree edits are handled by stop-warn-uncommitted.sh (soft reminder),
# NOT here — see header. Hard-gating them false-positives on this checkout's ambient churn.

# Nothing un-PR'd. Soft stash reminder only.
[ "${stashes:-0}" != "0" ] && echo "⚠️  ${stashes} git stash(es) parked locally — land or drop them (reminder only)." >&2
exit 0
