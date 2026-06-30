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
 * Env: AUTO_DISPATCH=1 (enable default), AUTO_DISPATCH_INTERVAL_MS (default 300000 = 5 min).
 *
 * Runtime control: the orchestration dashboard can flip the kill switch live
 * (setEnabled) without a restart — the timer always runs; tick() honors the
 * current enabled state. A runtime toggle is persisted so it survives restarts
 * and overrides the env default. setEnabled(false) stops NEW pickups; an
 * already in-flight run finishes (a worktree run can't be safely aborted mid-way).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

// Operational logger for the autonomous loop (daemon lifecycle + decisions —
// not debug output; routed through one helper so the loop's logging is uniform).
const _c = console;
const log = (...a) => _c.log(...a);
const logErr = (...a) => _c.error(...a);

const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const STATE_FILE = () => path.join(DEFAULT_REPO_ROOT, "data", "agent-work-queue", "auto-dispatch-state.json");

let inFlight = false;
let inFlightSince = 0;   // epoch ms the current run took the lock (0 = not in flight)
let timer = null;

// Runtime status (truthful, in-memory; persisted bits reload on boot).
const status = {
  enabledOverride: null,   // null = follow env; true/false = runtime override
  lastTickAt: null,
  pauseReason: null,       // why the last tick did NOT dispatch (cloud/lane/empty/disabled) — visibility
  lastPick: null,          // { issueNumber, title, at }
  lastResult: null,        // { issueNumber, ok, prUrl|stoppedAt, at }
  history: [],             // recent results, newest first (cap 20)
};

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8"));
    if (typeof s.enabledOverride === "boolean") status.enabledOverride = s.enabledOverride;
    if (Array.isArray(s.history)) status.history = s.history.slice(0, 20);
    if (s.lastResult) status.lastResult = s.lastResult;
    if (s.lastPick) status.lastPick = s.lastPick;
    if (s.lastTickAt) status.lastTickAt = s.lastTickAt;
    if (s.pauseReason) status.pauseReason = s.pauseReason;
  } catch { /* no state yet */ }
}
loadState();

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
    fs.writeFileSync(STATE_FILE(), JSON.stringify({
      enabledOverride: status.enabledOverride,
      lastTickAt: status.lastTickAt,
      pauseReason: status.pauseReason,
      lastPick: status.lastPick,
      lastResult: status.lastResult,
      history: status.history.slice(0, 20),
    }, null, 2));
  } catch { /* best-effort */ }
}

function envEnabled() {
  return process.env.AUTO_DISPATCH === "1";
}
function enabled() {
  return status.enabledOverride === null ? envEnabled() : status.enabledOverride;
}
function setEnabled(on) {
  status.enabledOverride = !!on;
  saveState();
  log(`[auto-dispatch] runtime ${on ? "ENABLED" : "DISABLED"} via dashboard kill switch`);
  return enabled();
}
function intervalMs() {
  const n = Number(process.env.AUTO_DISPATCH_INTERVAL_MS);
  return Number.isFinite(n) && n >= 30000 ? n : 5 * 60 * 1000;
}
// Hard wall-clock ceiling on a single in-flight run. The 20-min dispatch budget is a
// SOCKET-INACTIVITY timeout, not a wall clock: a slow-but-active autonomous-work stream
// (data trickling, never a `done`) keeps the socket alive past 20 min and never settles,
// pinning inFlight=true and blocking every future tick for the rest of the process
// lifetime (sustained-work wedge). This ceiling lets the next tick force-release the lock.
function staleMs() {
  const n = Number(process.env.AUTO_DISPATCH_STALE_MS);
  return Number.isFinite(n) && n >= 60000 ? n : 40 * 60 * 1000; // default 2× the 20-min budget
}
// Has the in-flight lock been held past the wall-clock ceiling? (wedge-recovery predicate)
function inFlightStale(now = Date.now()) {
  return inFlight && inFlightSince > 0 && now - inFlightSince > staleMs();
}

function getStatus() {
  return {
    enabled: enabled(),
    source: status.enabledOverride === null ? "env" : "runtime",
    inFlight,
    intervalMs: intervalMs(),
    lastTickAt: status.lastTickAt,
    pauseReason: status.pauseReason,
    nextRunAt: timer && status.lastTickAt ? new Date(new Date(status.lastTickAt).getTime() + intervalMs()).toISOString() : null,
    lastPick: status.lastPick,
    lastResult: status.lastResult,
    history: status.history.slice(0, 10),
    // surfaced guardrails (all enforced in tick)
    guardrails: ["serialized (1 in flight)", "cloud-paused", "draft PRs only", "one PR per lane", "assigned-tracked"],
  };
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
  // Require POSITIVE evidence of a COMPLETED cloud answer: a `done` event AND no
  // degraded/local/offline marker. Absence of degraded markers is NOT enough — a
  // hung route-only response (#965 manifests as just a `route` event, no answer)
  // has none, and must be treated as unhealthy so the worker pauses.
  const completed = /"type"\s*:\s*"done"/.test(r.text);
  const bad = /cloud unreachable|degraded|"provider"\s*:\s*"ollama"|"online"\s*:\s*false/i.test(r.text);
  return completed && !bad;
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

// One-PR-per-lane guard: autonomous-work opens PRs on the **auto/** lane
// (autowork-worktree creates `auto/issue-*` branches; openDraftPr requires the
// `auto/` prefix). The guard must check the AUTO lane, not claude — checking
// `claude` was a bug: that lane is constantly occupied by other claude work
// (automation, agents, manual PRs), so the fleet was perpetually false-paused
// while its own `auto/` lane sat empty and it never dispatched.
function autoLaneOccupied(repoRoot) {
  try {
    const queue = require("../routes/queue");
    if (typeof queue.loadPrLanes !== "function") return false;
    const data = queue.loadPrLanes(repoRoot);
    if (!data || !Array.isArray(data.lanes)) return false;
    const lane = data.lanes.find((l) => l.prefix === "auto");
    return !!(lane && lane.pr);
  } catch { return false; }
}

async function tick(ctx) {
  if (!enabled()) { status.pauseReason = "disabled (kill switch off)"; return; }
  if (inFlight) {
    if (inFlightStale()) {
      // The prior run blew past the wall-clock ceiling without settling — force-release
      // the lock so the loop resumes (the abandoned worktree run finishes orphaned/GC'd).
      // Record it as a failed result so the wedge is visible in history, not silent.
      logErr(`[auto-dispatch] wedge recovery — in-flight run exceeded the ${Math.round(staleMs() / 60000)}m wall-clock ceiling; force-releasing the lock`);
      const rec = {
        issueNumber: status.lastPick && status.lastPick.issueNumber,
        title: status.lastPick && status.lastPick.title,
        at: new Date().toISOString(),
        ok: false,
        stoppedAt: "wedge_recovered: in-flight run exceeded the wall-clock ceiling",
      };
      status.lastResult = rec;
      status.history.unshift(rec);
      status.history = status.history.slice(0, 20);
      inFlight = false;
      inFlightSince = 0;
      saveState();
      // fall through: this tick dispatches fresh
    } else {
      status.pauseReason = "a run is already in flight (serialized)";
      return;
    }
  }
  status.lastTickAt = new Date().toISOString();
  const port = ctx.port;
  if (!(await cloudHealthy(port))) {
    status.pauseReason = "cloud unreachable — chat degraded to the local model";
    saveState();
    log("[auto-dispatch] paused — cloud is unreachable (chat degraded to local); retrying next tick");
    return;
  }
  if (autoLaneOccupied(ctx.repoRoot)) {
    status.pauseReason = "the fleet's auto/ lane already has an open PR (one PR per lane)";
    saveState();
    log("[auto-dispatch] paused — auto/ lane already has an open PR (one PR per lane); retrying next tick");
    return;
  }
  const issue = pickTopIssue(ctx.repoRoot);
  if (!issue) { status.pauseReason = "backlog empty — no unclaimed open issues"; saveState(); return; }
  inFlight = true;
  inFlightSince = Date.now();
  status.pauseReason = null;
  status.lastPick = { issueNumber: issue.issueNumber, title: issue.title, at: new Date().toISOString() };
  saveState();
  log(`[auto-dispatch] working top issue #${issue.issueNumber} — ${String(issue.title || "").slice(0, 60)}`);
  try {
    // Draft PR via the verified autonomous-work pipeline (research→plan→patch→test→openDraftPr).
    const r = await post(port, "/api/convergence/autonomous-work",
      { issue: issue.issueNumber, push: true, commit: true }, 20 * 60 * 1000);
    let result = null;
    try { result = r && r.text ? JSON.parse(r.text) : null; } catch { /* non-JSON */ }
    const rec = { issueNumber: issue.issueNumber, title: issue.title, at: new Date().toISOString() };
    if (result && result.prUrl) {
      markAssigned(ctx.repoRoot, issue); // opened a draft PR → don't re-pick
      rec.ok = true; rec.prUrl = result.prUrl;
      log(`[auto-dispatch] ✓ #${issue.issueNumber} → draft PR ${result.prUrl}`);
    } else {
      rec.ok = false;
      // Categorize the failure honestly instead of a generic "no PR produced":
      // a null response = the 20-min dispatch timed out / connection dropped; a
      // parsed error/stoppedAt = the pipeline aborted (e.g. patch_did_not_apply,
      // tests_failed); ok-but-no-url = PR creation returned nothing.
      if (!r) rec.stoppedAt = "dispatch timed out or connection dropped (20m budget)";
      else if (result && (result.error || result.stoppedAt)) rec.stoppedAt = result.error || result.stoppedAt;
      else rec.stoppedAt = `pipeline returned no PR url (HTTP ${r.status})`;
      if (r && r.status) rec.httpStatus = r.status;
      log(`[auto-dispatch] #${issue.issueNumber} produced no PR (${rec.stoppedAt}) — leaving in queue for retry`);
    }
    status.lastResult = rec;
    status.history.unshift(rec);
    status.history = status.history.slice(0, 20);
    saveState();
  } catch (e) {
    logErr("[auto-dispatch] error (non-fatal):", e && e.message);
  } finally {
    inFlight = false;
    inFlightSince = 0;
  }
}

function start(ctx) {
  // The timer ALWAYS runs so the dashboard kill switch can flip the loop on/off
  // live without a restart; tick() is a no-op while disabled.
  log(
    enabled()
      ? `[auto-dispatch] ENABLED — gated worker every ${Math.round(intervalMs() / 1000)}s · serialized · draft PRs · cloud-paused · one-PR-per-lane`
      : `[auto-dispatch] standby — loop armed, disabled (toggle on from the orchestration dashboard, or set AUTO_DISPATCH=1)`
  );
  if (timer) return timer;
  timer = setInterval(() => { tick(ctx).catch(() => {}); }, intervalMs());
  if (timer.unref) timer.unref();
  return timer;
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  start, stop, tick, enabled, setEnabled, getStatus, intervalMs,
  cloudHealthy, pickTopIssue, staleMs, inFlightStale,
  _inFlight: () => inFlight,
  _inFlightSince: () => inFlightSince,
  // test hook: simulate an in-flight run (optionally taken `ageMs` ago) without a real dispatch.
  _setInFlight: (v, ageMs) => { inFlight = !!v; inFlightSince = v ? Date.now() - (ageMs || 0) : 0; },
};
