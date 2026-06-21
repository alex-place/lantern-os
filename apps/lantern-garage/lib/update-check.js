"use strict";

// Server-side update checker (#879). The browser used to poll api.github.com every
// 60s from update-checker.js — at 1-2 unauth calls/min a single open tab exhausts the
// 60 req/hr/IP limit in ~30-60 min (self-DoS + 403), and it's a local-first/privacy
// violation to have every visitor phone GitHub on a timer. This caches the remote
// master SHA + compare server-side on a long interval, with 403 backoff, so the
// client reads a LOCAL endpoint and the server makes at most ~4 GitHub calls/hour.
const https = require("https");
const { execSync } = require("child_process");
// On Windows, AV/TLS interception makes Node's https reject api.github.com's cert
// ("unable to verify the first certificate") even though the browser reaches it fine.
// Reuse the repo's centralized, platform-gated TLS workaround (#869) — this fetch only
// reads a public commit SHA, so it's low-stakes. #879
const { llmAgent } = require("./insecure-tls");

const REPO = process.env.UPDATE_CHECK_REPO || "alex-place/lantern-os";
const REFRESH_MS = Number(process.env.UPDATE_CHECK_INTERVAL_MS) || 15 * 60_000; // 15 min
const BACKOFF_MS = Number(process.env.UPDATE_CHECK_BACKOFF_MS) || 60 * 60_000;  // 1 h after a 403
const UA = "lantern-os-update-check";

let cache = { local: null, remote: null, behind: 0, ahead: 0, updateAvailable: false, checkedAt: 0, error: null };
let inflight = null;

// Pure: an update is available only when the remote differs AND local is strictly
// behind (not ahead — unpushed local commits are not an "update"). Exported for tests.
function computeUpdate(local, remote, behind, ahead) {
  if (!local || !remote || local === remote) return false;
  return Number(behind) > 0 && Number(ahead) === 0;
}

function ghGet(apiPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: "api.github.com", path: apiPath, method: "GET", agent: llmAgent,
        headers: { "User-Agent": UA, Accept: "application/vnd.github+json" } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode === 200) {
            try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
          } else {
            reject(Object.assign(new Error("github_http_" + res.statusCode), { status: res.statusCode }));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

function localCommit(repoRoot) {
  try { return execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8", timeout: 5000 }).trim(); }
  catch { return null; }
}

async function refresh(repoRoot) {
  const local = localCommit(repoRoot);
  try {
    const head = await ghGet(`/repos/${REPO}/commits/master`);
    const remote = head.sha || null;
    let behind = 0, ahead = 0;
    if (local && remote && local !== remote) {
      try {
        const cmp = await ghGet(`/repos/${REPO}/compare/${local}...master`);
        // base=local, head=master. ahead_by = commits master is ahead of local
        // (= how far local is BEHIND, i.e. updates available); behind_by = commits
        // local has that master doesn't (unpushed / local is ahead).
        behind = cmp.ahead_by || 0;
        ahead = cmp.behind_by || 0;
      } catch { /* compare failed (e.g. local commit unknown to remote) → leave 0/0 */ }
    }
    cache = { local, remote, behind, ahead,
      updateAvailable: computeUpdate(local, remote, behind, ahead),
      checkedAt: Date.now(), error: null };
  } catch (e) {
    // Rate-limit / network error: keep the last good data, flag it, and back off.
    cache = { ...cache, local, checkedAt: Date.now(),
      error: e && e.status === 403 ? "rate_limited" : (e && e.message) || "error" };
  }
  return cache;
}

// Non-blocking: always returns the cached snapshot immediately, lazily kicking off a
// background refresh when the cache is older than the (backoff-aware) interval.
function getUpdateStatus(repoRoot) {
  const now = Date.now();
  // UPDATE_CHECK_DISABLE=1 → fully local-first: never contact GitHub at all.
  if (process.env.UPDATE_CHECK_DISABLE === "1") {
    return { ...cache, disabled: true, stale: false };
  }
  const interval = cache.error === "rate_limited" ? BACKOFF_MS : REFRESH_MS;
  const stale = now - cache.checkedAt > interval;
  if (stale && !inflight) {
    inflight = refresh(repoRoot).catch(() => {}).finally(() => { inflight = null; });
  }
  return { ...cache, stale };
}

module.exports = { getUpdateStatus, computeUpdate, REFRESH_MS };
