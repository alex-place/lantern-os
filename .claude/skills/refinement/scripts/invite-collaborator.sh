#!/usr/bin/env bash
# invite-collaborator.sh — send a repo collaborator invite (OUTWARD-FACING: emails the user).
#
# Only run this after the user has explicitly confirmed the invite. The refinement
# skill never calls this silently — inviting a real person is a one-time, hard-to-undo
# action, so it stays behind a human yes.
#
# Usage: invite-collaborator.sh <login> [permission]
#   permission defaults to "push" (write access — needed to be an assignee + work a lane).
#
# After this, the invitee must ACCEPT before they can be set as an assignee. Until then
# they show as "invited" in check-collaborators.sh and assignee-setting will be deferred.
set -euo pipefail

USER="${1:?usage: invite-collaborator.sh <login> [permission]}"
PERM="${2:-push}"
OR=$(gh repo view --json nameWithOwner --jq .nameWithOwner)

gh api -X PUT "repos/$OR/collaborators/$USER" -f permission="$PERM" >/dev/null
echo "invited $USER ($PERM) to $OR — pending their acceptance"
