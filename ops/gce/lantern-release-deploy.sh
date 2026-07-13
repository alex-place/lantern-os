#!/usr/bin/env bash
#
# lantern-release-deploy.sh — release-gated self-update for the GCE cloud VM
# (unisona.ai). Polls GitHub for the latest *published* release and, when the tag
# changes, checks it out, installs prod deps, and restarts the app. This is the
# "update on release only" mechanism: master merges do NOT move the box — only a
# published GitHub Release does.
#
# Installed on the VM as a systemd oneshot + timer (see the sibling unit files and
# docs/ops/gce-cloud-deploy-runbook.md). The canonical copy lives here in the repo;
# the live copy runs from /usr/local/bin so a `git checkout` of a tag can't yank the
# script out from under its own run.
#
# State file records the last-deployed tag. SEED IT with the current latest tag at
# install time so the box doesn't roll back to an older release on first tick.
set -euo pipefail

# A systemd oneshot starts with an empty environment; git needs HOME for its global
# config (`git config --global` writes ~/.gitconfig). Without it every roll dies with
# "fatal: $HOME not set" (exit 128) — the bug that froze the box at v1.8.0 (2026-07-10).
export HOME="${HOME:-/root}"

REPO="${LANTERN_REPO:-alex-place/lantern-os}"
CHECKOUT="${LANTERN_CHECKOUT:-/opt/lantern-os}"
STATE="${LANTERN_RELEASE_STATE:-/var/lib/lantern/deployed-release.tag}"
APP_DIR="$CHECKOUT/apps/lantern-garage"

mkdir -p "$(dirname "$STATE")"

latest="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -oP '"tag_name":\s*"\K[^"]+' || true)"
if [ -z "$latest" ]; then
  echo "no latest release resolved (rate-limited or none); skipping"; exit 0
fi

current="$(cat "$STATE" 2>/dev/null || echo none)"
if [ "$latest" = "$current" ]; then
  echo "already on $latest; nothing to do"; exit 0
fi

echo "deploying release $latest (was: $current)"
git config --global --add safe.directory "$CHECKOUT"
cd "$CHECKOUT"
# Shallow-fetch just this tag, then hard-checkout (discards the live hotfix drift,
# which by design is already folded into the release).
git fetch --tags --depth 1 origin "refs/tags/${latest}:refs/tags/${latest}"
git checkout -f "$latest"

npm install --omit=dev --prefix "$APP_DIR"

systemctl restart lantern.service
echo "$latest" > "$STATE"
logger -t lantern-deploy "deployed release $latest"

# Best-effort readiness probe (non-fatal).
sleep 5
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8080/ || echo 000)"
echo "post-deploy HTTP $code — now on $latest"
