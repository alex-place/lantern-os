#!/usr/bin/env bash
# _lane-map.sh — the ONE source of truth for lane -> GitHub login.
#
# The lane *label* short-name is NOT the person's GitHub handle. Burn this in:
#   lane:kriskin -> kriskin9-hash
#   lane:mookman -> Mookman11
#   lane:alex    -> alex-place
# Getting this wrong invites/assigns unrelated strangers (it has happened).
# Source this file; do not duplicate the mapping anywhere else.

lane_login() {
  case "$1" in
    kriskin|lane:kriskin) echo "kriskin9-hash" ;;
    mookman|lane:mookman) echo "Mookman11" ;;
    alex|lane:alex)       echo "alex-place" ;;
    *) echo "lane_login: unknown lane '$1'" >&2; return 1 ;;
  esac
}

# All lane logins, space-separated (for membership checks).
lane_logins() { echo "kriskin9-hash Mookman11 alex-place"; }
