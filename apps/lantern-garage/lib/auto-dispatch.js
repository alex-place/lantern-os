"use strict";
/**
 * auto-dispatch.js — gated auto-dispatch of the backlog to autowork.
 *
 * When enabled, a scheduled worker pulls the **top-priority open issue** from the
 * queue (the same `loadOpenIssues` backlog the orchestration dashboard shows),
 * works it via the verified autonomous-work pipeline (`/api/convergence/autonomous-work`
 * → research → plan → patch → test → **draft PR**), one at a time, then picks the next.
 *
 * Safety gates (all on by design — this turns issues into PRs unattended):
 *   1. OFF by default — set `AUTO_DISPATCH=1` to enable (so dev/preview never auto-run).
 *   2. Serialized — one issue in flight at a time (`inFlight` lock).
 *   3. Cloud-paused — before dispatching, probes the live chat path; if it's degraded
 *      to the local model (the #965 "cloud unreachable" state), it PAUSES so it can't
 *      churn out low-quality local-model work. (getProviderStatus can't be used here:
 *      the chat path doesn't record cloud failures, so it wouldn't reflect the outage.)
 *   4. Draft PRs only — the pipeline opens draft PRs for human review; nothing auto-merges.
 *   5. Assigned-tracking — a dispatched issue is marked in data/agent-work-queue/assigned/
 *      so `loadOpenIssues` excludes it and it isn't re-picked.
 *
 * Env: AUTO_DISPATCH=1 (enable), AUTO_DISPATCH_INTERVAL_MS (default 300000 = 5 min).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

let inFlight = false;
let timer = null;

function enabled() {
  return process.env.AUTO_DISPATCH === "1";
}
function intervalMs() {
  const n = Number(process.env.AUTO_DISPATCH_INTERVAL_MS);
  return Number.isFinite(n) && n >= 30000 ? n : 5 * 60 * 1000;
}

// Small loopback POST helper returning the parsed body (or null).
function post(port, pathname, payload, timeoutMs) {
  return new Promise((resolve) => {
    let body;
    try { body = JSON.stringify(payload); } catch { return resolve(null); }
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: timeoutMs },
      (res) => {
        let buf = "";
        res.on("data", (c) => { buf += c; });
        res.on("end", () => resolve({ status: res.statusCode, text: buf }));
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

/**
 * Probe the live chat path; healthy iff it answered from a cloud provider (not the
 * degraded local fallback). Conservative: any error / no answer → treat as unhealthy.
 */
async function cloudHealthy(port) {
  const r = await post(port, "/api/dream/chat/stream",
    { message: "ping", sessionId: "auto-dispatch-cloud-probe" }, 30000);
  if (!r || !r.text) return false;
  const degraded = /cloud unreachable|⚠\s*degraded|"degraded"\s*:\s*true|"provider"\s*:\s*"ollama"/i.test(r.text);
  return !degraded;
}

function pickTopIssue(repoRoot) {
  try {
    const queue = require("../routes/queue");
    if (typeof queue.loadOpenIssues !== "function") return null;
    const items = (queue.loadOpenIssues(repoRoot).items) || [];
    // items are pre-sorted by priority desc, recency desc; already exclude assigned/.
    return items[0] || null;
  } catch (_e) {
    return null;
  }
}

function markAssigned(repoRoot, issue) {
  try {
    const dir = path.join(repoRoot, "data", "agent-work-queue", "assigned");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `issue-${issue.issueNumber}.json`),
      JSON.stringify(
        { issueNumber: issue.issueNumber, title: issue.title, assignedAt: new Date().toISOString(), by: "auto-dispatch" },
        null, 2
      )
    );
  } catch (_e) { /* best-effort */ }
}

async function tick(ctx) {
  if (!enabled() || inFlight) return;
  const port = ctx.port;
  if (!(await cloudHealthy(port))) {
    console.log("[auto-dispatch] paused — cloud is unreachable (chat degraded to local); retrying next tick");
    return;
  }
  const issue = pickTopIssue(ctx.repoRoot);
  if (!issue) return; // empty backlog
  inFlight = true;
  console.log(`[auto-dispatch] working top issue #${issue.issueNumber} — ${String(issue.title || "").slice(0, 60)}`);
  try {
    // Draft PR via the verified autonomous-work pipeline (research→plan→patch→test→openDraftPr).
    const r = await post(port, "/api/convergence/autonomous-work",
      { issue: issue.issueNumber, push: true, commit: true }, 20 * 60 * 1000);
    let result = null;
    try { result = r && r.text ? JSON.parse(r.text) : null; } catch { /* non-JSON */ }
    if (result && result.prUrl) {
      markAssigned(ctx.repoRoot, issue); // opened a draft PR → don't re-pick
      console.log(`[auto-dispatch] ✓ #${issue.issueNumber} → draft PR ${result.prUrl}`);
    } else {
      const why = (result && (result.stoppedAt || result.error)) || "no PR produced";
      console.log(`[auto-dispatch] #${issue.issueNumber} produced no PR (${why}) — leaving in queue for retry`);
    }
  } catch (e) {
    console.error("[auto-dispatch] error (non-fatal):", e && e.message);
  } finally {
    inFlight = false;
  }
}

function start(ctx) {
  if (!enabled()) {
    console.log("[auto-dispatch] disabled (set AUTO_DISPATCH=1 to auto-work the backlog into draft PRs)");
    return null;
  }
  console.log(`[auto-dispatch] ENABLED — gated worker every ${Math.round(intervalMs() / 1000)}s · serialized · draft PRs · cloud-paused`);
  timer = setInterval(() => { tick(ctx).catch(() => {}); }, intervalMs());
  if (timer.unref) timer.unref();
  return timer;
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, tick, enabled, intervalMs, cloudHealthy, pickTopIssue, _inFlight: () => inFlight };
