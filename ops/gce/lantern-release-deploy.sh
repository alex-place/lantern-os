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
#
# MARKET-HOURS GUARD (#3524). The app this restarts is also the users' trader, so a
# release published at 11:00 ET restarted every autopilot mid-session. During the US
# regular session -- Mon-Fri 09:25-16:05 ET, the 09:30-16:00 bell plus 5 min either
# side -- the WHOLE deploy waits, checkout and npm install included: the running app
# require()s modules lazily, so new files under the old process would be a
# mixed-version app. The timer fires every 15 min, so the first tick after 16:05 ET
# ships it. Holidays and early closes aren't modeled; they only delay a deploy to
# 16:05. To ship during the session anyway (an urgent fix):
#   sudo touch /var/lib/lantern/deploy-now && sudo systemctl start lantern-release-deploy.service
# The flag is one-shot: the next run consumes it. LANTERN_DEPLOY_FORCE=1 does the
# same for a hand run of this script.
set -euo pipefail

# Prints "yes" while the session (with its margins) is on, "no" otherwise, nothing if
# node is unavailable. Node's Intl does the Eastern-time conversion, DST included;
# node is on the box because the app runs on it. LANTERN_NOW (ISO time) pins the
# clock for tests.
market_session() {
  node -e '
    const t = process.env.LANTERN_NOW ? new Date(process.env.LANTERN_NOW) : new Date();
    const p = {};
    for (const x of new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York",
      weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(t)) p[x.type] = x.value;
    const m = Number(p.hour) * 60 + Number(p.minute);
    process.stdout.write(p.weekday !== "Sat" && p.weekday !== "Sun" && m >= 565 && m < 965 ? "yes" : "no");
  ' 2>/dev/null || true
}
if [ "${1:-}" = "--session" ]; then market_session; echo; exit 0; fi

# A systemd oneshot starts with an empty environment; git needs HOME for its global
# config (`git config --global` writes ~/.gitconfig). Without it every roll dies with
# "fatal: $HOME not set" (exit 128) — the bug that froze the box at v1.8.0 (2026-07-10).
export HOME="${HOME:-/root}"

REPO="${LANTERN_REPO:-alex-place/lantern-os}"
CHECKOUT="${LANTERN_CHECKOUT:-/opt/lantern-os}"
STATE="${LANTERN_RELEASE_STATE:-/var/lib/lantern/deployed-release.tag}"
FORCE_FLAG="${LANTERN_DEPLOY_FORCE_FLAG:-/var/lib/lantern/deploy-now}"
APP_DIR="$CHECKOUT/apps/lantern-garage"

mkdir -p "$(dirname "$STATE")"

forced=""
if [ "${LANTERN_DEPLOY_FORCE:-}" = "1" ]; then forced="LANTERN_DEPLOY_FORCE=1"; fi
if [ -e "$FORCE_FLAG" ]; then forced="$FORCE_FLAG"; rm -f "$FORCE_FLAG"; fi

latest="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -oP '"tag_name":\s*"\K[^"]+' || true)"
if [ -z "$latest" ]; then
  echo "no latest release resolved (rate-limited or none); skipping"; exit 0
fi

current="$(cat "$STATE" 2>/dev/null || echo none)"
if [ "$latest" = "$current" ]; then
  echo "already on $latest; nothing to do"; exit 0
fi

session="$(market_session)"
if [ "$session" = "yes" ]; then
  if [ -z "$forced" ]; then
    echo "release $latest waits for the close: the US session is open (still on $current). To ship now: sudo touch $FORCE_FLAG, then start this service"
    logger -t lantern-deploy "release $latest deferred until the close (session open)" || true
    exit 0
  fi
  echo "in-session deploy forced ($forced)"
elif [ -z "$session" ]; then
  echo "market-hours check unavailable (node missing?); deploying without it"
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
