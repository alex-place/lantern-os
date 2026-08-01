#!/usr/bin/env bash
#
# set-stripe-key.sh — install the Stripe API key on the prod VM as a systemd
# drop-in, then restart the app and verify billing came up configured.
#
# Run ON the VM (or: gcloud compute ssh <vm> --zone <zone> -- 'sudo bash -s' < this file):
#
#   sudo bash ops/gce/set-stripe-key.sh              # prompts for the key, echo off
#   STRIPE_SECRET_KEY=sk_live_... sudo -E bash ops/gce/set-stripe-key.sh
#   sudo bash ops/gce/set-stripe-key.sh --file /root/stripe.key
#   sudo bash ops/gce/set-stripe-key.sh --env-file  # EnvironmentFile mode (see below)
#   sudo bash ops/gce/set-stripe-key.sh --remove    # tear the key back out
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
DROPIN="$DROPIN_DIR/stripe.conf"
ENVFILE="/etc/lantern/stripe.env"
SERVICE="lantern.service"
HEALTH_URL="${LANTERN_HEALTH_URL:-http://127.0.0.1:8080/api/billing/config}"

MODE="environment"   # or "envfile"
ACTION="install"
KEY_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file)  MODE="envfile" ;;
    --remove)    ACTION="remove" ;;
    --file)      KEY_FILE="${2:?--file needs a path}"; shift ;;
    -h|--help)   sed -n '2,26p' "$0"; exit 0 ;;
    sk_*|rk_*)
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
KEY="${STRIPE_SECRET_KEY:-}"
if [ -n "$KEY_FILE" ]; then
  [ -r "$KEY_FILE" ] || { echo "cannot read $KEY_FILE" >&2; exit 1; }
  KEY="$(tr -d ' \t\r\n' < "$KEY_FILE")"
fi
if [ -z "$KEY" ]; then
  if [ ! -t 0 ]; then
    echo "no key: stdin is not a terminal and neither STRIPE_SECRET_KEY nor --file was given." >&2
    exit 1
  fi
  printf 'Paste the Stripe secret key (input hidden, nothing is echoed): ' >&2
  read -rs KEY
  printf '\n' >&2
fi

# ── Validate shape before touching anything. ─────────────────────────────────
case "$KEY" in
  sk_live_*|rk_live_*) LABEL="LIVE — real money" ;;
  sk_test_*|rk_test_*) LABEL="test mode — no real charges" ;;
  "")  echo "empty key; nothing written." >&2; exit 1 ;;
  *)   echo "that does not look like a Stripe secret key (expected sk_/rk_ prefix); nothing written." >&2; exit 1 ;;
esac
case "$KEY" in
  rk_*) SCOPE="restricted key (good — least privilege)" ;;
  *)    SCOPE="FULL-ACCESS secret key — a restricted key scoped to Checkout + Billing would be safer" ;;
esac
# Length sanity only; never print the key or any part of it.
[ "${#KEY}" -ge 20 ] || { echo "key is implausibly short (${#KEY} chars); nothing written." >&2; exit 1; }

# The webhook signing secret is what applies entitlements. Without it
# /api/billing/webhook 503s: the customer pays and never receives their role.
WHSEC="${STRIPE_WEBHOOK_SECRET:-}"
if [ -z "$WHSEC" ] && [ -t 0 ]; then
  printf 'Paste the Stripe WEBHOOK signing secret (whsec_..., blank to skip): ' >&2
  read -rs WHSEC
  printf '
' >&2
fi
case "$WHSEC" in
  "")       echo "WARNING: no webhook secret - checkout will work but entitlements will NOT apply." >&2 ;;
  whsec_*)  : ;;
  *)        echo "that does not look like a webhook signing secret (expected whsec_ prefix); nothing written." >&2; exit 1 ;;
esac

echo "key accepted: $LABEL"
echo "scope:        $SCOPE"

umask 077   # anything created below is 0600 from birth, never briefly world-readable
mkdir -p "$DROPIN_DIR"

if [ "$MODE" = "envfile" ]; then
  # EnvironmentFile keeps the value out of `systemctl show`, which any local user
  # can read. The file itself is root-only 0600.
  mkdir -p "$(dirname "$ENVFILE")"
  printf 'STRIPE_SECRET_KEY=%s\n' "$KEY" > "$ENVFILE"
  chmod 600 "$ENVFILE"; chown root:root "$ENVFILE"
  printf '[Service]\nEnvironmentFile=%s\n' "$ENVFILE" > "$DROPIN"
else
  printf '[Service]\nEnvironment="STRIPE_SECRET_KEY=%s"\n' "$KEY" > "$DROPIN"
fi
chmod 600 "$DROPIN"; chown root:root "$DROPIN"
unset KEY WHSEC

echo "wrote $DROPIN (0600, root)"

systemctl daemon-reload
systemctl restart "$SERVICE"
echo "restarted $SERVICE"

# ── Verify: the app must actually report billing configured. ─────────────────
echo -n "waiting for the app to come back"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then break; fi
  echo -n "."; sleep 2
done
echo

BODY="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || true)"
if [ -z "$BODY" ]; then
  echo "could not reach $HEALTH_URL — check: journalctl -u $SERVICE -n 50" >&2
  exit 1
fi
case "$BODY" in
  *'"configured":true'*|*'"configured": true'*)
    echo "billing is CONFIGURED. Tier availability:"
    echo "$BODY" | tr ',' '\n' | grep -E '"(pro|pilot|member)"' | sed 's/^/  /'
    echo
    echo "Check https://unisona.ai/pricing.html — the Patreon fallback should now be"
    echo "replaced by Subscribe to Pro / Subscribe to Pilot."
    ;;
  *)
    echo "app is up but billing still reports NOT configured:" >&2
    echo "$BODY" >&2
    echo "check: journalctl -u $SERVICE -n 50" >&2
    exit 1
    ;;
esac
