#!/usr/bin/env bash
# fetch-backlog.sh — emit the issues that still need grooming, as JSON (read-only).
#
# An issue is "groomed" when it has a lane:* label AND a milestone AND an assignee.
# By default this prints only the un-groomed ones (the work a refinement run targets).
#
# Usage:
#   fetch-backlog.sh                # un-groomed open issues
#   fetch-backlog.sh --all          # every open issue (re-evaluate, e.g. fix a misroute)
#   fetch-backlog.sh --limit 500    # raise the page size (default 300)
#   fetch-backlog.sh 1712 1711      # only these specific issue numbers
#
# Output: a JSON array. Each element:
#   { number, title, labels:[...], milestone, assignees:[...], lane, body }
# body is truncated to 400 chars — enough to route on, small enough to scan.
set -euo pipefail

MODE=ungroomed
LIMIT=300
NUMS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --all)   MODE=all; shift;;
    --limit) LIMIT="$2"; shift 2;;
    [0-9]*)  NUMS+=("$1"); shift;;
    *) echo "fetch-backlog: unknown arg '$1'" >&2; exit 2;;
  esac
done

SHAPE='map({
  number,
  title,
  labels: [.labels[].name],
  milestone: (.milestone.title // null),
  assignees: [.assignees[].login],
  lane: ([.labels[].name | select(startswith("lane:"))] | first // null),
  body: ((.body // "") | gsub("\r";" ") | gsub("\n";" ") | .[0:400])
})'

FILTER="$SHAPE"
if [ "$MODE" = "ungroomed" ] && [ "${#NUMS[@]}" -eq 0 ]; then
  FILTER="$FILTER | map(select((.lane == null) or (.milestone == null) or ((.assignees | length) == 0)))"
fi
if [ "${#NUMS[@]}" -gt 0 ]; then
  WANT=$(printf '%s\n' "${NUMS[@]}" | paste -sd, -)
  FILTER="$FILTER | map(select(.number as \$n | [$WANT] | index(\$n)))"
fi

gh issue list --state open --limit "$LIMIT" \
  --json number,title,labels,milestone,assignees,body \
  --jq "$FILTER"
