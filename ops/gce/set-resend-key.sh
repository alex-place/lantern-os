#!/usr/bin/env bash
#
# set-stripe-key.sh — install the Stripe API key on the prod VM as a systemd
# drop-in, then restart the app and verify billing came up configured.
#
# Run ON the VM (or: gcloud compute ssh <vm> --zone <zone> -- 'sudo bash -s' < this file):
#
#   sudo bash ops/gce/set-resend-key.sh              # prompts for the key, echo off
#   RESEND_API_KEY=sk_live_... sudo -E bash ops/gce/set-stripe-key.sh
#   sudo bash ops/gce/set-resend-key.sh --file /root/resend.key
#   sudo bash ops/gce/set-resend-key.sh --env-file  # EnvironmentFile mode (see below)
#   sudo bash ops/gce/set-resend-key.sh --remove    # tear the key back out
#
# The key is NEVER accepted as a positional argument: argv is world-readable via
# /proc and `ps`, so a key passed that way leaks to every local user for the life
# of the process. Prompt / env / file only, and it is never echoed or logged.
#
# Secrets live in /etc/systemd/system/lantern.service.d/ by convention — outside
# the git checkout, so the release deploy's `git checkout -f <tag>` cannot touch
# them. Set once; it survives every future release.
# See docs/ops/gce-cloud-deploy-runbook.md § Environment (systemd drop-ins).
set -euo pipefail

DROPIN_DIR="/etc/systemd/system/lantern.service.d"
DROPIN="$DROPIN_DIR/mail.conf"
ENVFILE="/etc/lantern/mail.env"
SERVICE="lantern.service"
# MAIL_FROM must be on a domain verified in Resend or sends fail silently.
# PUBLIC_BASE_URL is required: without it lib/base-url.js builds confirmation
# links from the spoofable Host header (#2604).
MAIL_FROM="${MAIL_FROM:-unisona.ai <no-reply@unisona.ai>}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://unisona.ai}"

MODE="environment"   # or "envfile"
ACTION="install"
KEY_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file)  MODE="envfile" ;;
    --remove)    ACTION="remove" ;;
    --file)      KEY_FILE="${2:?--file needs a path}"; shift ;;
    -h|--help)   sed -n '2,26p' "$0"; exit 0 ;;
    re_*)
      echo "refusing a key on the command line: argv is visible to every local user via ps/proc." >&2
      echo "run with no arguments and paste it at the prompt instead." >&2
      exit 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || { echo "must run as root (sudo)." >&2; exit 1; }

if [ "$ACTION" = "remove" ]; then
  rm -f "$DROPIN" "$ENVFILE"
  systemctl daemon-reload
  systemctl restart "$SERVICE"
  echo "removed the Stripe drop-in and restarted $SERVICE."
  exit 0
fi

# ── Obtain the key: env, file, or a silent prompt. Never argv. ────────────────
KEY="${RESEND_API_KEY:-}"
if [ -n "$KEY_FILE" ]; then
  [ -r "$KEY_FILE" ] || { echo "cannot read $KEY_FILE" >&2; exit 1; }
  KEY="$(tr -d ' \t\r\n' < "$KEY_FILE")"
fi
if [ -z "$KEY" ]; then
  if [ ! -t 0 ]; then
    echo "no key: stdin is not a terminal and neither RESEND_API_KEY nor --file was given." >&2
    exit 1
  fi
  printf 'Paste the Stripe secret key (input hidden, nothing is echoed): ' >&2
  read -rs KEY
  printf '\n' >&2
fi

# ── Validate shape before touching anything. ─────────────────────────────────
case "$KEY" in
  re_*) LABEL="Resend API key" ;;
  "")   echo "empty key; nothing written." >&2; exit 1 ;;
  *)    echo "that does not look like a Resend API key (expected re_ prefix); nothing written." >&2; exit 1 ;;
esac
SCOPE="from $MAIL_FROM / base-url $PUBLIC_BASE_URL"
# Length sanity only; never print the key or any part of it.
[ "${#KEY}" -ge 20 ] || { echo "key is implausibly short (${#KEY} chars); nothing written." >&2; exit 1; }

echo "key accepted: $LABEL"
echo "scope:        $SCOPE"

umask 077   # anything created below is 0600 from birth, never briefly world-readable
mkdir -p "$DROPIN_DIR"

if [ "$MODE" = "envfile" ]; then
  # EnvironmentFile keeps the value out of `systemctl show`, which any local user
  # can read. The file itself is root-only 0600.
  mkdir -p "$(dirname "$ENVFILE")"
  printf 'RESEND_API_KEY=%s\n' "$KEY" > "$ENVFILE"
  chmod 600 "$ENVFILE"; chown root:root "$ENVFILE"
  printf '[Service]\nEnvironmentFile=%s\n' "$ENVFILE" > "$DROPIN"
else
  printf '[Service]\nEnvironment="RESEND_API_KEY=%s"\n' "$KEY" > "$DROPIN"
fi
chmod 600 "$DROPIN"; chown root:root "$DROPIN"
unset KEY

echo "wrote $DROPIN (0600, root)"

systemctl daemon-reload
systemctl restart "$SERVICE"
echo "restarted $SERVICE"

# Verify. "no mail provider is configured" in the journal means the drop-in did
# not take; silence means the mailer picked the key up.
sleep 6
if journalctl -u "$SERVICE" -n 80 --no-pager 2>/dev/null | grep -qi "no mail provider"; then
  echo "the app still reports NO MAIL PROVIDER - the drop-in did not take." >&2
  journalctl -u "$SERVICE" -n 20 --no-pager >&2
  exit 1
fi

echo "mailer is configured (no 'no mail provider' warning in the journal)."
echo
echo "Sender domain must be verified in Resend or sends fail silently:"
echo "  curl -H \"Authorization: Bearer <key>\" https://api.resend.com/domains"
echo "Then register a throwaway address on $PUBLIC_BASE_URL and confirm a code arrives."
