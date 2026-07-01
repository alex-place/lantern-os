#!/usr/bin/env bash
# Sync the gitignored media content dir to Cloudflare R2.
#
# Media bytes live OUT of git (manifest.json is the tracked source of truth) and
# are served from R2 (zero egress). This uploads only changed files.
#
# Prereqs:
#   1. rclone installed            (https://rclone.org/downloads/)
#   2. An R2 bucket + API token     (see docs/MEDIA-HOSTING-R2.md)
#   3. These env vars set:
#        R2_ACCOUNT_ID   — Cloudflare account id
#        R2_ACCESS_KEY   — R2 API token access key id
#        R2_SECRET_KEY   — R2 API token secret
#        R2_BUCKET       — bucket name (e.g. keystone-media)
#
# Usage:
#   scripts/sync-media-r2.sh            # dry-run (shows what would upload)
#   scripts/sync-media-r2.sh --go       # actually upload
set -euo pipefail

: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID}"
: "${R2_ACCESS_KEY:?set R2_ACCESS_KEY}"
: "${R2_SECRET_KEY:?set R2_SECRET_KEY}"
: "${R2_BUCKET:?set R2_BUCKET}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/apps/lantern-garage/public/assets/content"   # contains koh/, etc.
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

# Resolve rclone — fall back to the winget shim/package path if PATH isn't refreshed yet.
RCLONE="$(command -v rclone || true)"
if [ -z "$RCLONE" ]; then
  for c in \
    "$LOCALAPPDATA/Microsoft/WinGet/Links/rclone.exe" \
    "$HOME/AppData/Local/Microsoft/WinGet/Links/rclone.exe" \
    "$HOME"/AppData/Local/Microsoft/WinGet/Packages/Rclone.Rclone_*/rclone-*/rclone.exe; do
    [ -x "$c" ] && RCLONE="$c" && break
  done
fi
[ -n "$RCLONE" ] || { echo "rclone not found — install it (winget install Rclone.Rclone)"; exit 1; }

# rclone flags configure an S3-compatible remote inline (no rclone.conf needed).
RCLONE_S3=(
  --s3-provider Cloudflare
  --s3-access-key-id "$R2_ACCESS_KEY"
  --s3-secret-access-key "$R2_SECRET_KEY"
  --s3-endpoint "$ENDPOINT"
  --s3-region auto
  --s3-no-check-bucket
)

MODE="--dry-run"
[ "${1:-}" = "--go" ] && MODE=""

echo "Syncing $SRC  →  r2://$R2_BUCKET   ${MODE:-(LIVE)}"
# webp/mp4 are already compressed; set a long cache header and skip re-checks by size+mtime.
"$RCLONE" sync "$SRC" ":s3:$R2_BUCKET" \
  "${RCLONE_S3[@]}" \
  --header-upload "Cache-Control: public, max-age=31536000, immutable" \
  --transfers 8 --checkers 16 --fast-list $MODE -P

echo
echo "Done. If LIVE: set manifest \"base\" to your R2 public URL, e.g."
echo "  https://media.lantern-os.net/koh/   (custom domain)"
echo "  or  https://<bucket>.<account>.r2.dev/koh/   (r2.dev dev URL)"
