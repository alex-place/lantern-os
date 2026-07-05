#!/usr/bin/env bash
# apply-refinement.sh — groom ONE issue to the agile "Definition of Ready" bar:
#   lane label · milestone · priority · type · readiness flag · assignee.
#
# Usage:
#   apply-refinement.sh <issue#> <lane> [flags]
#     lane  = kriskin | mookman | alex            (lane suffix, NOT a login)
#   flags (all optional):
#     --milestone <title>     set milestone (omit / "-" to leave it)
#     --priority p0|p1|p2     set priority, exclusive — swaps any other p-level
#     --type <label>          set a type label (bug|enhancement|documentation|refactor)
#                             FILL-GAP only: skipped if the issue already has any of those
#     --triage                mark needs-triage (fails Definition of Ready) AND skip assignee
#                             — you don't put un-ready work on someone's plate
#     --ready                 remove needs-triage if present (issue now meets DoR)
#     --no-assignee           set labels/milestone only; don't touch assignees
#
# Assignee login is derived from the lane via _lane-map.sh (kriskin->kriskin9-hash,
# mookman->Mookman11, alex->alex-place) so the wrong person can't be assigned.
#
# All label + milestone edits go in ONE `gh issue edit` call (fast, atomic). The
# assignee is a SEPARATE call that re-reads to confirm it stuck — GitHub silently
# drops an assignee whose invite isn't accepted while `gh` still exits 0, so we
# report "deferred" honestly. Idempotent: already-correct fields are skipped.
#
# Why these fields: a backlog item is "Ready" (DEEP / Definition of Ready) when it's
# Detailed, Estimated/typed, Prioritized, and owned. Refinement makes each issue meet
# that bar so the lane can pull from the top of the queue without re-litigating scope.
set -euo pipefail
SD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lane-map.sh
. "$SD/_lane-map.sh"

ISSUE="${1:?usage: apply-refinement.sh <issue#> <lane> [flags]}"
LANE_SUFFIX="${2:?lane required (kriskin|mookman|alex)}"
shift 2
LANE="lane:${LANE_SUFFIX}"
ASG="$(lane_login "$LANE_SUFFIX")"

MS=""; PRIO=""; TYPE=""; TRIAGE=0; READY=0; NOASG=0
while [ $# -gt 0 ]; do
  case "$1" in
    --milestone) MS="$2"; shift 2;;
    --priority)  PRIO="$2"; shift 2;;
    --type)      TYPE="$2"; shift 2;;
    --triage)    TRIAGE=1; shift;;
    --ready)     READY=1; shift;;
    --no-assignee) NOASG=1; shift;;
    *) echo "apply-refinement: unknown flag '$1'" >&2; exit 2;;
  esac
done
[ "$TRIAGE" -eq 1 ] && NOASG=1   # un-ready issues are not assigned

CUR=$(gh issue view "$ISSUE" --json labels --jq '[.labels[].name] | join(",")')
has() { printf ',%s,' "$1" | grep -qi ",$2,"; }

EDIT=(issue edit "$ISSUE"); changed=0
add() { EDIT+=(--add-label "$1"); changed=1; }
rm()  { EDIT+=(--remove-label "$1"); changed=1; }

# lane (exclusive)
has "$CUR" "$LANE" || add "$LANE"
for r in lane:kriskin lane:mookman lane:alex; do
  [ "$r" != "$LANE" ] && has "$CUR" "$r" && rm "$r"
done
# priority (exclusive)
if [ -n "$PRIO" ]; then
  has "$CUR" "$PRIO" || add "$PRIO"
  for p in p0 p1 p2; do [ "$p" != "$PRIO" ] && has "$CUR" "$p" && rm "$p"; done
fi
# type (fill-gap: only if no known type present)
if [ -n "$TYPE" ] && [ "$TYPE" != "-" ]; then
  if ! has "$CUR" bug && ! has "$CUR" enhancement && ! has "$CUR" documentation && ! has "$CUR" refactor; then
    add "$TYPE"
  fi
fi
# readiness flag
if [ "$TRIAGE" -eq 1 ]; then has "$CUR" needs-triage || add needs-triage; fi
if [ "$READY"  -eq 1 ]; then has "$CUR" needs-triage && rm needs-triage; fi
# milestone
ms_report="skip"
if [ -n "$MS" ] && [ "$MS" != "-" ]; then EDIT+=(--milestone "$MS"); changed=1; ms_report="$MS"; fi

[ "$changed" -eq 1 ] && gh "${EDIT[@]}" >/dev/null

# assignee — attempt, then VERIFY it landed
asg_report="skip"
if [ "$NOASG" -eq 0 ] && [ -n "$ASG" ]; then
  CURA=$(gh issue view "$ISSUE" --json assignees --jq '[.assignees[].login] | join(",")')
  if has "$CURA" "$ASG"; then
    asg_report="$ASG"
  else
    gh issue edit "$ISSUE" --add-assignee "$ASG" >/dev/null 2>&1 || true
    NEW=$(gh issue view "$ISSUE" --json assignees --jq '[.assignees[].login] | join(",")')
    has "$NEW" "$ASG" && asg_report="$ASG" || asg_report="$ASG (deferred — invite not accepted)"
  fi
fi

printf '#%s lane=%s ms=%s prio=%s type=%s%s assignee=%s\n' \
  "$ISSUE" "$LANE" "$ms_report" "${PRIO:-skip}" "${TYPE:-skip}" \
  "$([ "$TRIAGE" -eq 1 ] && echo ' needs-triage' || true)" "$asg_report"
