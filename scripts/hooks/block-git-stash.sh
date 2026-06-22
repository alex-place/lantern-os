#!/usr/bin/env bash
# PreToolUse(Bash) hook — block `git stash` (create) commands.
#
# WHY: Parking work in a stash hides it from the remote, and it gets lost. The repo
# rule (AGENTS.md monoworkstream) is: land work as a PR on a claude/ lane branch.
# Recovering/clearing EXISTING stashes stays allowed:
#   git stash {list,show,pop,apply,drop,clear,branch,create,store}
# Only stash *creation* is blocked: bare `git stash`, `git stash push|save`, `git stash -<flag>`.
#
# Emits a PreToolUse deny decision (JSON on stdout) when a stash-create is detected;
# otherwise exits 0 and the command proceeds. Fail-open on parse errors.
#
# WIRING (local; .claude/settings.json is gitignored):
#   "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command",
#       "command": "bash scripts/hooks/block-git-stash.sh" }]}]
set -uo pipefail

input="$(cat)"

# Fast early-out: the vast majority of Bash calls never mention "stash" — skip all work
# (and the python startup cost) unless the payload could possibly contain a stash command.
case "$input" in *stash*) : ;; *) exit 0 ;; esac

PY="$(command -v python 2>/dev/null || command -v python3 2>/dev/null || true)"

# Extract the proposed command string (robust JSON parse via python; fail-open to raw).
if [ -n "$PY" ]; then
  cmd="$("$PY" -c 'import sys,json
try: print(json.load(sys.stdin).get("tool_input",{}).get("command",""))
except Exception: pass' <<<"$input" 2>/dev/null || true)"
else
  cmd="$input"
fi

# Walk each "git stash <sub>" occurrence; block unless <sub> is a recover/manage subcommand.
blocked=0
while IFS= read -r sub; do
  case "$sub" in
    list|show|pop|apply|drop|clear|branch|create|store) : ;;
    *) blocked=1 ;;
  esac
done < <(printf '%s\n' "$cmd" \
  | grep -oE 'git[[:space:]]+stash([[:space:]]+[^[:space:];&|<>()]+)?' \
  | sed -E 's/^git[[:space:]]+stash[[:space:]]*//')

[ "$blocked" = "0" ] && exit 0

reason='git stash is blocked in this repo. Parking work in a stash hides it from the remote and it gets lost. Commit the work to a claude/ lane branch and open a PR instead (see AGENTS.md monoworkstream rules). Recovering an existing stash is fine — git stash list/show/pop/apply/drop are allowed.'

if [ -n "$PY" ]; then
  REASON="$reason" "$PY" -c 'import json,os
print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":os.environ["REASON"]}}))'
else
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
fi
exit 0
