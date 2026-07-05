#!/usr/bin/env bash
# check-collaborators.sh — can each lane's GitHub user be an assignee right now? (read-only)
#
# GitHub only lets you assign people who are collaborators AND have accepted the invite.
# Logins come from _lane-map.sh (lane:kriskin->kriskin9-hash, lane:mookman->Mookman11,
# lane:alex->alex-place) — never assume the login equals the lane name.
#
# Output (one line per lane):
#   kriskin   kriskin9-hash   collaborator | invited | none
#   mookman   Mookman11       collaborator | invited | none
#   alex      alex-place      collaborator | invited | none
#
#   collaborator = accepted, assignable now
#   invited      = invite pending, NOT assignable until they accept
#   none         = not a collaborator and not invited
set -euo pipefail
SD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lane-map.sh
. "$SD/_lane-map.sh"

OR=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
INVITED=$(gh api "repos/$OR/invitations" --jq '.[].invitee.login' 2>/dev/null || true)

for lane in kriskin mookman alex; do
  u="$(lane_login "$lane")"
  if gh api "repos/$OR/collaborators/$u" --silent >/dev/null 2>&1; then
    state=collaborator
  elif printf '%s\n' "$INVITED" | grep -qix "$u"; then
    state=invited
  else
    state=none
  fi
  printf '%-9s %-14s %s\n' "$lane" "$u" "$state"
done
