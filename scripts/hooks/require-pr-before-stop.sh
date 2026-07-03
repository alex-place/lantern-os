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
# SESSION ATTRIBUTION + CONCURRENCY (this checkout is shared by concurrent sessions):
#   • The fleet squash-merges, so a fully-landed branch keeps commits "beyond origin/master"
#     forever. If HEAD equals the head SHA of a MERGED PR for this branch, the branch is
#     SPENT — everything landed — and the gate passes silently instead of demanding a
#     duplicate PR whose only effect would be reverting newer master work.
#   • If the session-start snapshot (written by stop-warn-uncommitted.sh --snapshot at
#     SessionStart) shows THIS session created no commits, the gate never blocks: the
#     un-PR'd commits predate the session or belong to a concurrent session working the
#     same checkout, and blocking this session just drives it to interfere with theirs.
#   • Each gate blocks at most ONCE per (session, gate, HEAD): after one forceful nudge the
#     agent can explain why the branch stays PR-less and actually stop, instead of being
#     re-blocked every turn with no new information.
#
# SAFETY (never traps):
#   • Loop guard — stop_hook_active means it blocks at most ONCE per stop cycle, so an
#     offline push / genuinely-unfinishable state gets one forceful nudge, never a loop.
#   • Fail-open — gh/network errors never block (can't open a PR offline → don't trap);
#     gh calls are wrapped in `timeout` when available so a hung network never hangs a stop.
#   • Protected branches (master/main/dev/gh-pages) skip the PR gate.
#
# WIRING: "Stop": [{ "hooks": [{ "type": "command",
#            "command": "bash scripts/hooks/require-pr-before-stop.sh" }]}]
# Companion: stop-warn-uncommitted.sh (soft lister) + its --snapshot at SessionStart, which
# also records the session-start HEAD this gate reads for attribution.
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
head_sha="$(git rev-parse HEAD 2>/dev/null || echo '')"

PY="$(command -v python 2>/dev/null || command -v python3 2>/dev/null || true)"
TIMEOUT=""; command -v timeout >/dev/null 2>&1 && TIMEOUT="timeout 8"

# Extract a string field from the hook's stdin JSON (python; sed fallback).
json_get() {
  if [ -n "$PY" ]; then
    printf '%s' "$input" | "$PY" -c 'import json,sys
try: print(json.load(sys.stdin).get(sys.argv[1],"") or "")
except Exception: pass' "$1" 2>/dev/null
  else
    printf '%s' "$input" | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
  fi
}

sid="$(json_get session_id)"; sid="${sid//[^a-zA-Z0-9_-]/}"
[ -n "$sid" ] || sid="nosession"
state_dir="$(git rev-parse --git-dir 2>/dev/null)/claude-session-state"
snap_file="$state_dir/$sid.head"
nag_file="$state_dir/$sid.nagged"

# Did THIS session create any commits? "no" only when the SessionStart snapshot proves it.
session_committed="assume-yes"
if [ -f "$snap_file" ]; then
  snap_head="$(tr -d '[:space:]' < "$snap_file" 2>/dev/null)"
  if [ -n "$snap_head" ] && git cat-file -e "${snap_head}^{commit}" 2>/dev/null; then
    n="$(git rev-list --count "${snap_head}..HEAD" 2>/dev/null || echo '')"
    [ "$n" = "0" ] && session_committed="no"
  fi
fi

# Block at most once per (session, gate, HEAD): first offense blocks, repeats soft-warn.
already_nagged() { [ -f "$nag_file" ] && grep -qx "$1:$head_sha" "$nag_file" 2>/dev/null; }
record_nag()     { mkdir -p "$state_dir" 2>/dev/null; echo "$1:$head_sha" >> "$nag_file" 2>/dev/null; }

# Emit a decision:block with the given reason, then exit. JSON via python, sed fallback.
block() {
  local reason="$1"
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
  # Soft paths exit here: while commits are unpushed, that is THE state to report — letting
  # Gate 2 also fire for the same commits would double-nag one underlying problem.
  if [ "$session_committed" = "no" ]; then
    echo "ℹ️  ${unpushed} unpushed commit(s) on '${branch}' predate this session or belong to a concurrent session — not blocking this session for them. Their owner lands them." >&2
    exit 0
  elif already_nagged unpushed; then
    echo "ℹ️  Still ${unpushed} unpushed commit(s) on '${branch}' (already flagged once this session — not re-blocking)." >&2
    exit 0
  else
    record_nag unpushed
    reason="Don't stop yet — ${unpushed} local commit(s) on '${branch}' are on no remote (unpushed). Land them as a PR before finishing: push the lane branch and open or append a PR (git push + gh). If a PR for this branch already exists, just push to it. If this is genuinely throwaway, or these are a concurrent session's in-flight commits, say so to the user explicitly instead of leaving it unspoken. (AGENTS.md monoworkstream.)"
    [ "${stashes:-0}" != "0" ] && reason="$reason Also: ${stashes} stash(es) parked locally — recover & land them, or drop them (git stash list)."
    block "$reason"
  fi
fi

# Protected branches: don't gate on PR-existence or working-tree edits (master auto-deploys).
case "$branch" in
  master|main|dev|gh-pages|HEAD|'?')
    [ "${stashes:-0}" != "0" ] && echo "⚠️  ${stashes} git stash(es) parked locally — land or drop them (reminder only)." >&2
    exit 0 ;;
esac

# ── Gate 2: pushed (no unpushed commits) but NO open PR for a lane branch ────────────
# Has this branch any commits beyond origin/master? If so it's real work that must be a PR —
# unless the branch is SPENT (its PR already squash-merged; see header).
base="$(git merge-base HEAD origin/master 2>/dev/null || true)"
ahead="$(git rev-list --count ${base:+${base}..}HEAD 2>/dev/null || echo 0)"
if [ "${ahead:-0}" -gt 0 ]; then
  # ONE gh call answers both "is there an open PR?" and "did this tip already merge?".
  # Fail-open: any gh error (offline, not authed) yields a non-verdict → no false block.
  prs_json="$($TIMEOUT gh pr list --head "$branch" --state all --limit 50 --json state,headRefOid 2>/dev/null || echo 'err')"
  verdict="err"
  if [ "$prs_json" != "err" ] && [ -n "$prs_json" ]; then
    if [ -n "$PY" ]; then
      verdict="$(printf '%s' "$prs_json" | HEAD_SHA="$head_sha" "$PY" -c 'import json,os,sys
try:
    prs=json.load(sys.stdin); head=os.environ["HEAD_SHA"]
    if any(p.get("state")=="OPEN" for p in prs): print("open")
    elif any(p.get("state")=="MERGED" and p.get("headRefOid")==head for p in prs): print("spent")
    else: print("unlanded")
except Exception: print("err")' 2>/dev/null || echo 'err')"
    else
      case "$prs_json" in
        *'"state":"OPEN"'*|*'"state": "OPEN"'*) verdict="open" ;;
        *"$head_sha"*) verdict="spent" ;;
        *) verdict="unlanded" ;;
      esac
    fi
  fi
  if [ "$verdict" = "unlanded" ]; then
    if [ "$session_committed" = "no" ]; then
      echo "ℹ️  Branch '${branch}' is ${ahead} commit(s) beyond origin/master with no open PR, but this session created none of them (pre-session or concurrent work) — not blocking." >&2
    elif already_nagged nopr; then
      echo "ℹ️  Branch '${branch}' still has no open PR (already flagged once this session — not re-blocking)." >&2
    else
      record_nag nopr
      block "Don't stop yet — branch '${branch}' has ${ahead} commit(s) beyond origin/master but NO open PR. Pushing isn't finishing: open a PR (gh pr create, or gh api if blocked). The standing rule is that finished work lands on a PR. If you truly mean to leave this branch PR-less, tell the user why. (Already-merged squash PRs and concurrent sessions' commits are auto-detected and would not trigger this — seeing it means this tip is genuinely unlanded.)"
    fi
  fi
  # "open" → PR exists; "spent" → tip already merged (squash); "err" → fail-open. All pass.
fi

# Uncommitted working-tree edits are handled by stop-warn-uncommitted.sh (soft reminder),
# NOT here — see header. Hard-gating them false-positives on this checkout's ambient churn.

# Nothing un-PR'd. Soft stash reminder only.
[ "${stashes:-0}" != "0" ] && echo "⚠️  ${stashes} git stash(es) parked locally — land or drop them (reminder only)." >&2
exit 0
