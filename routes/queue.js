/**
 * Agent Queue & Orchestration Routes
 * Exposes queue and slot manager operations via REST API
 */

/**
 * Read the real agent slot roster from .claude/agent-slots.json and
 * cross-reference the assigned queue so each slot reports working/idle truth.
 * Falls back to an empty roster (not a fake "claude" slot) if config is missing.
 */
function loadAgentSlots(repoRoot) {
  const fs = require("fs");
  const path = require("path");

  let configSlots = [];
  try {
    const cfgPath = path.join(repoRoot, ".claude", "agent-slots.json");
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      configSlots = Array.isArray(cfg.slots) ? cfg.slots : [];
    }
  } catch (e) {
    console.warn("[Queue] agent-slots.json unreadable:", e.message);
  }

  // Map assigned work items by the slot/agent they're assigned to.
  const assignedByAgent = {};
  try {
    const assignedDir = path.join(repoRoot, "data", "agent-work-queue", "assigned");
    if (fs.existsSync(assignedDir)) {
      for (const f of fs.readdirSync(assignedDir).filter((x) => x.endsWith(".json"))) {
        try {
          const item = JSON.parse(fs.readFileSync(path.join(assignedDir, f), "utf8"));
          if (item.assignedTo) (assignedByAgent[item.assignedTo] ||= []).push(item);
        } catch { /* skip unparseable */ }
      }
    }
  } catch { /* no assigned dir */ }

  const slots = configSlots.map((s) => {
    const work = assignedByAgent[s.id] || assignedByAgent[s.agent] || [];
    const working = work.length > 0;
    return {
      id: s.id,
      agent: s.agent || null,
      model: s.model || null,
      tier: s.tier || null,
      status: working ? "working" : (s.status === "disabled" ? "disabled" : "idle"),
      currentWork: working ? work[0].issueNumber : null,
      responsibilities: s.responsibilities || [],
    };
  });

  const activeCount = slots.filter((s) => s.status === "working").length;
  const disabledCount = slots.filter((s) => s.status === "disabled").length;
  const idleCount = slots.length - activeCount - disabledCount;

  return {
    slots,
    stats: {
      totalSlots: slots.length,
      enabledSlots: slots.length - disabledCount,
      activeCount,
      idleCount,
    },
  };
}

// A claim in assigned/ (or in_progress/) is considered genuinely in-flight only
// while it is fresh AND its issue is still open. Autowork is chat-only + serialized
// with a ~20-min budget, so nothing legitimately holds a claim for hours — a claim
// older than this whose issue is still open means the claiming run died mid-flight.
// Closed-issue claims are stale regardless of age (the work merged or was abandoned).
const ASSIGNED_STALE_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Read the local assigned/ + in_progress/ claim files and classify each as a
 * genuinely in-flight claim ("live") or stale cruft ("stale").
 *
 * These files leak: auto-dispatch's markAssigned() writes one per issue it opens a
 * draft PR for and never removes it, so when the issue later closes the claim
 * lingers forever and inflates the dashboard's "In Progress" count. External
 * reality (the open-issue backlog) beats the local claim file.
 *
 * A claim is STALE when either:
 *   - its issue is no longer open (merged/closed/deleted), or
 *   - it is older than `staleAfterMs` (the claiming run died mid-flight).
 *
 * `openIssueNumbers` is a Set of currently-open issue numbers, or null when the
 * GitHub backlog is unavailable (gh missing/not authed). When null we cannot prove
 * an issue closed, so only the age gate applies — a conservative choice that never
 * hides real in-flight work during a gh outage. Unparseable / in-flight-write files
 * are skipped entirely (neither counted nor swept) to avoid deleting a partial write.
 *
 * @returns {{ live: Array, stale: Array }} each entry:
 *   { file, dir, path, issueNumber, assignedAt, ageMs, reason }
 */
function loadAssignedClaims(repoRoot, { openIssueNumbers = null, staleAfterMs = ASSIGNED_STALE_MS } = {}) {
  const fs = require("fs");
  const path = require("path");
  const now = Date.now();
  const live = [];
  const stale = [];

  for (const dir of ["assigned", "in_progress"]) {
    const dirPath = path.join(repoRoot, "data", "agent-work-queue", dir);
    let files = [];
    try {
      if (!fs.existsSync(dirPath)) continue;
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".json"));
    } catch { continue; }

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      let item;
      try { item = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { continue; } // partial write / corrupt → leave it
      const issueNumber = item.issueNumber ?? null;
      const assignedAt = item.assignedAt || null;
      const ageMs = assignedAt ? (now - new Date(assignedAt).getTime()) : Infinity;

      let reason = null;
      if (openIssueNumbers && issueNumber != null && !openIssueNumbers.has(issueNumber)) {
        reason = "issue_not_open";           // external reality: the issue merged/closed
      } else if (ageMs > staleAfterMs) {
        reason = "stale_ttl";                // claiming run died mid-flight
      }

      const rec = { file, dir, path: filePath, issueNumber, assignedAt, ageMs, reason };
      if (reason) stale.push(rec); else live.push(rec);
    }
  }
  return { live, stale };
}

/**
 * Garbage-collect stale assigned/in_progress claim files (see loadAssignedClaims).
 * Deletes each stale file and appends an append-only audit record to
 * data/agent-work-queue/reconcile-log.jsonl (nothing silently vanishes). Best-effort:
 * a file that races away / is locked is skipped, never fatal. `dryRun` reports what
 * WOULD be swept without touching disk. @returns {Array} the swept records.
 */
function sweepStaleAssigned(repoRoot, { openIssueNumbers = null, staleAfterMs = ASSIGNED_STALE_MS, dryRun = false } = {}) {
  const fs = require("fs");
  const path = require("path");
  const { stale } = loadAssignedClaims(repoRoot, { openIssueNumbers, staleAfterMs });
  const logPath = path.join(repoRoot, "data", "agent-work-queue", "reconcile-log.jsonl");
  const swept = [];
  for (const c of stale) {
    const rec = {
      sweptAt: new Date().toISOString(),
      issueNumber: c.issueNumber,
      dir: c.dir,
      reason: c.reason,
      assignedAt: c.assignedAt,
      ageHours: c.ageMs === Infinity ? null : Math.round((c.ageMs / 3.6e6) * 10) / 10,
      ...(dryRun ? { dryRun: true } : {}),
    };
    if (dryRun) { swept.push(rec); continue; }
    try {
      fs.unlinkSync(c.path);
      try { fs.appendFileSync(logPath, JSON.stringify(rec) + "\n"); } catch { /* audit best-effort */ }
      swept.push(rec);
    } catch { /* vanished / locked — skip */ }
  }
  return swept;
}

// CLAUDE.md monoworkstream lanes — one open PR lane per agent prefix.
const LANE_PREFIXES = ["claude", "gemini", "codex", "devin", "grok", "openai", "sigma0"];

// Short-lived cache so a 5s dashboard poll doesn't spawn a `gh` subprocess
// every tick. { ts, data }.
let _prLaneCache = null;
const PR_LANE_TTL_MS = 20_000;

/**
 * Live PR-lane (Verify-stage) view: open PRs grouped by agent-prefix lane, each
 * with its CI check rollup. Real `gh` data, shell-free via safeExec. Returns
 * { lanes:[{prefix, pr|null, checks}], openCount, generatedAt } — or an
 * { error } shape the UI degrades gracefully on (gh missing / not authed).
 */
function loadPrLanes(repoRoot) {
  const now = Date.now();
  if (_prLaneCache && now - _prLaneCache.ts < PR_LANE_TTL_MS) return _prLaneCache.data;

  const { safeExec } = require(require("path").join(repoRoot, "lib", "safe-exec"));
  let prs = [];
  try {
    const out = safeExec(
      ["gh", "pr", "list", "--repo", "alex-place/lantern-os", "--state", "open",
       "--json", "number,title,headRefName,statusCheckRollup,mergeable,isDraft,url",
       "--limit", "50"],
      { cwd: repoRoot, timeout: 15000 }
    );
    prs = JSON.parse(out || "[]");
  } catch (err) {
    const data = { error: "gh_unavailable", message: String(err.message || err).slice(0, 200), lanes: [], openCount: 0 };
    _prLaneCache = { ts: now, data };
    return data;
  }

  const rollup = (pr) => {
    const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
    if (!checks.length) return "none";
    const norm = checks.map((c) => (c.conclusion || c.state || c.status || "").toUpperCase());
    if (norm.some((s) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT"].includes(s))) return "failing";
    if (norm.some((s) => ["IN_PROGRESS", "QUEUED", "PENDING", "WAITING"].includes(s))) return "pending";
    if (norm.every((s) => ["SUCCESS", "COMPLETED", "NEUTRAL", "SKIPPED"].includes(s))) return "passing";
    return "pending";
  };

  const laneFor = (branch) => {
    const prefix = String(branch || "").split("/")[0].toLowerCase();
    return LANE_PREFIXES.includes(prefix) ? prefix : null;
  };

  const lanes = LANE_PREFIXES.map((prefix) => {
    const pr = prs.find((p) => laneFor(p.headRefName) === prefix);
    return {
      prefix,
      pr: pr ? {
        number: pr.number, title: pr.title, branch: pr.headRefName, url: pr.url,
        draft: !!pr.isDraft, mergeable: pr.mergeable, checks: rollup(pr),
      } : null,
    };
  });

  const data = { lanes, openCount: prs.length, generatedAt: new Date().toISOString() };
  _prLaneCache = { ts: now, data };
  return data;
}

// Pending work is NOT a hand-maintained file store — it IS the open GitHub
// issue backlog (single source of truth). Cached so a 5s dashboard poll doesn't
// spawn a `gh` subprocess each tick.
let _openIssuesCache = null;
const OPEN_ISSUES_TTL_MS = 60_000;

function priorityFromLabels(labels) {
  const names = (labels || []).map((l) => (l.name || l).toLowerCase());
  if (names.includes("p0")) return 3;
  if (names.includes("p1")) return 2;
  if (names.includes("p2")) return 1;
  return 0;
}

/**
 * Pending queue = open GitHub issues (never stale). Returns work-item-shaped
 * rows, highest priority first. Issues already claimed locally (a file in
 * assigned/) are dropped so they don't double-count. { items, source, error? }.
 */
function loadOpenIssues(repoRoot) {
  const path = require("path");
  const fs = require("fs");
  const now = Date.now();
  if (_openIssuesCache && now - _openIssuesCache.ts < OPEN_ISSUES_TTL_MS) return _openIssuesCache.data;

  const { safeExec } = require(path.join(repoRoot, "lib", "safe-exec"));
  let issues = [];
  try {
    const out = safeExec(
      ["gh", "issue", "list", "--repo", "alex-place/lantern-os", "--state", "open",
       "--json", "number,title,labels,updatedAt,url", "--limit", "100"],
      { cwd: repoRoot, timeout: 15000 }
    );
    issues = JSON.parse(out || "[]");
  } catch (err) {
    const data = { items: [], openNumbers: null, source: "github", error: "gh_unavailable", message: String(err.message || err).slice(0, 200) };
    _openIssuesCache = { ts: now, data };
    return data;
  }

  const openNumbers = issues.map((i) => i.number);

  // Exclude issues with a *live* claim in assigned/ (tracked locally). Only live
  // claims count — a stale claim (issue closed, or the run died) must NOT hide an
  // open issue from the backlog forever (the "failed never de-queue" starvation jam).
  const openSet = new Set(openNumbers);
  const claimed = new Set(
    loadAssignedClaims(repoRoot, { openIssueNumbers: openSet }).live.map((c) => c.issueNumber)
  );

  const items = issues
    .filter((i) => !claimed.has(i.number))
    .map((i) => ({
      id: `issue-${i.number}`,
      issueNumber: i.number,
      title: i.title,
      labels: (i.labels || []).map((l) => l.name),
      priority: priorityFromLabels(i.labels),
      status: "pending",
      url: i.url,
      updatedAt: i.updatedAt,
      source: "github",
    }))
    .sort((a, b) => (b.priority - a.priority) || (new Date(b.updatedAt) - new Date(a.updatedAt)));

  const data = { items, openNumbers, source: "github", generatedAt: new Date().toISOString() };
  _openIssuesCache = { ts: now, data };
  return data;
}

// Recently landed work = merged PRs (Converge stage, real-time "what we shipped").
// Short cache so a dashboard poll doesn't spawn a `gh` subprocess each tick.
let _mergesCache = null;
const MERGES_TTL_MS = 30_000;

/**
 * Live "recently landed" view: the last N merged PRs straight from `gh`, shell-free
 * via safeExec. Returns { merges:[{number,title,url,branch,lane,author,mergedAt}],
 * count, generatedAt } — or an honest { error, merges:[] } shape (gh missing /
 * not authed). Never fabricates rows.
 */
function loadRecentMerges(repoRoot, limit = 15) {
  const now = Date.now();
  if (_mergesCache && _mergesCache.limit === limit && now - _mergesCache.ts < MERGES_TTL_MS) return _mergesCache.data;

  const { safeExec } = require(require("path").join(repoRoot, "lib", "safe-exec"));
  let prs = [];
  try {
    const out = safeExec(
      ["gh", "pr", "list", "--repo", "alex-place/lantern-os", "--state", "merged",
       "--json", "number,title,headRefName,url,mergedAt,author",
       "--limit", String(limit)],
      { cwd: repoRoot, timeout: 15000 }
    );
    prs = JSON.parse(out || "[]");
  } catch (err) {
    const data = { error: "gh_unavailable", message: String(err.message || err).slice(0, 200), merges: [], count: 0 };
    _mergesCache = { ts: now, limit, data };
    return data;
  }

  const laneFor = (branch) => {
    const prefix = String(branch || "").split("/")[0].toLowerCase();
    return LANE_PREFIXES.includes(prefix) ? prefix : (prefix.startsWith("auto") ? "auto" : "human");
  };

  const merges = prs
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      branch: pr.headRefName,
      lane: laneFor(pr.headRefName),
      author: pr.author?.login || pr.author?.name || "unknown",
      mergedAt: pr.mergedAt || null,
    }))
    .sort((a, b) => new Date(b.mergedAt || 0) - new Date(a.mergedAt || 0));

  const data = { merges, count: merges.length, generatedAt: new Date().toISOString() };
  _mergesCache = { ts: now, limit, data };
  return data;
}

module.exports = async function queueRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody, repoRoot } = deps;
  const fs = require("fs");
  const path = require("path");

  // ── GET /api/queue/recent-merges ── (Converge stage: recently landed PRs)
  if (url.pathname === "/api/queue/recent-merges" && req.method === "GET") {
    try {
      const limit = Math.min(parseInt(url.searchParams.get("limit"), 10) || 15, 50);
      sendJson(res, loadRecentMerges(repoRoot, limit));
    } catch (err) {
      console.error("[Queue] recent-merges error:", err);
      sendJson(res, { error: err.message, merges: [], count: 0 }, 500);
    }
    return true;
  }

  // ── GET /api/queue/pr-lanes ── (Verify stage: CI status per agent lane)
  if (url.pathname === "/api/queue/pr-lanes" && req.method === "GET") {
    try {
      sendJson(res, loadPrLanes(repoRoot));
    } catch (err) {
      console.error("[Queue] PR-lanes error:", err);
      sendJson(res, { error: err.message, lanes: [], openCount: 0 }, 500);
    }
    return true;
  }

  // ── GET /api/queue/status ──
  // Real counts derived from the on-disk queue dirs (no hardcoded stub).
  if (url.pathname === "/api/queue/status" && req.method === "GET") {
    try {
      const queueRoot = path.join(repoRoot, "data", "agent-work-queue");
      const countJson = (dir) => {
        const d = path.join(queueRoot, dir);
        if (!fs.existsSync(d)) return 0;
        return fs.readdirSync(d).filter((f) => f.endsWith(".json")).length;
      };
      // Pending = open GitHub issues (source of truth), not local files.
      // "In Progress" (assigned) is reconciled against that same reality: a claim
      // file whose issue has closed — or that has gone stale — is cruft, not
      // in-flight work, so it is excluded from the count (and surfaced separately
      // as staleAssigned). This stops closed-issue claim leaks from inflating the
      // dashboard's "In Progress" stat. completed/failed remain raw local counts.
      const open = loadOpenIssues(repoRoot);
      const pending = (open.items || []).length;
      const openIssueNumbers = open.openNumbers ? new Set(open.openNumbers) : null;
      const { live, stale } = loadAssignedClaims(repoRoot, { openIssueNumbers });
      const assigned = live.length;
      const staleAssigned = stale.length;
      const completed = countJson("completed");
      const failed = countJson("failed");
      const total = pending + assigned + completed + failed;
      const settled = completed + failed;

      sendJson(res, {
        ok: true,
        message: "Queue system online",
        queue: { pending, assigned, staleAssigned, completed, failed, total },
        agents: loadAgentSlots(repoRoot).stats,
        successRate: settled > 0 ? Math.round((completed / settled) * 100) : 0,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[Queue] Status error:", err);
      sendJson(res, { error: err.message }, 500);
    }
    return true;
  }

  // ── POST /api/queue/reconcile ── (garbage-collect stale assigned claims)
  // Deletes claim files whose issue has closed/merged or that have gone stale, and
  // appends an audit record per sweep to reconcile-log.jsonl. Pass ?dryRun=1 to see
  // what WOULD be swept without deleting. Complements the read-time reconciliation in
  // /api/queue/status — this one actually reclaims the disk + bounds unbounded growth.
  if (url.pathname === "/api/queue/reconcile" && req.method === "POST") {
    try {
      const open = loadOpenIssues(repoRoot);
      const openIssueNumbers = open.openNumbers ? new Set(open.openNumbers) : null;
      const dryRun = url.searchParams.get("dryRun") === "1";
      const swept = sweepStaleAssigned(repoRoot, { openIssueNumbers, dryRun });
      // Bust the open-issues cache so a just-unblocked open issue reappears in pending.
      if (!dryRun && swept.length) _openIssuesCache = null;
      sendJson(res, {
        ok: true,
        dryRun,
        swept: swept.length,
        ghAvailable: !!openIssueNumbers,
        items: swept,
        message: `${dryRun ? "Would sweep" : "Swept"} ${swept.length} stale assigned claim(s)`,
      });
    } catch (err) {
      console.error("[Queue] Reconcile error:", err);
      sendJson(res, { error: err.message }, 500);
    }
    return true;
  }

  // ── POST /api/queue/enqueue ──
  if (url.pathname === "/api/queue/enqueue" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const payload = JSON.parse(raw);

      // If only issueNumber provided, fetch from GitHub
      let title = payload.title;
      let description = payload.description || "";
      let labels = payload.labels || [];

      if (payload.issueNumber && !title) {
        try {
          const { execSync } = require("child_process");
          const ghData = execSync(
            `gh issue view ${payload.issueNumber} --repo alex-place/lantern-os --json title,body,labels`,
            { encoding: "utf8", timeout: 10000 }
          );
          const issue = JSON.parse(ghData);
          title = issue.title;
          description = issue.body || "";
          labels = issue.labels?.map(l => l.name) || [];
        } catch (ghErr) {
          console.warn("[Queue] GitHub fetch failed, using minimal data:", ghErr.message);
          title = title || `Issue #${payload.issueNumber}`;
        }
      }

      // Ensure queue directory exists
      const queuePath = path.join(repoRoot, "data", "agent-work-queue", "pending");
      if (!fs.existsSync(queuePath)) {
        fs.mkdirSync(queuePath, { recursive: true });
      }

      const work = {
        id: `issue-${payload.issueNumber}`,
        issueNumber: payload.issueNumber,
        title,
        description,
        labels,
        priority: payload.priority || 0,
        assignedTo: null,
        assignedAt: null,
        status: "pending",
        branch: null,
        targetDate: payload.targetDate || null,
        retries: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Save to pending queue
      const workFile = path.join(queuePath, `${work.id}.json`);
      fs.writeFileSync(workFile, JSON.stringify(work, null, 2));

      sendJson(res, {
        ok: true,
        work,
        message: `Enqueued issue #${work.issueNumber}`,
      });
      return true;
    } catch (err) {
      console.error("[Queue] Enqueue error:", err);
      sendJson(res, { error: err.message }, 400);
      return true;
    }
  }

  // ── GET /api/queue/list ──
  if (url.pathname === "/api/queue/list" && req.method === "GET") {
    try {
      const status = url.searchParams.get("status") || "pending";

      // Pending work IS the open GitHub issue backlog (single source of truth),
      // not a local file store. assigned/completed/failed stay file-based —
      // they're in-flight execution state GitHub doesn't track.
      if (status === "pending") {
        const open = loadOpenIssues(repoRoot);
        sendJson(res, {
          status,
          source: "github",
          count: (open.items || []).length,
          items: open.items || [],
          ...(open.error ? { error: open.error, message: open.message } : {}),
        });
        return true;
      }

      const queuePath = path.join(repoRoot, "data", "agent-work-queue", status);

      let items = [];
      if (fs.existsSync(queuePath)) {
        // Read JSON files (not JSONL)
        const files = fs.readdirSync(queuePath).filter((f) => f.endsWith(".json"));
        files.forEach((f) => {
          try {
            const content = fs.readFileSync(path.join(queuePath, f), "utf8");
            items.push(JSON.parse(content));
          } catch (e) {
            console.warn(`[Queue] Failed to parse ${f}:`, e.message);
          }
        });
      }

      // Sort by priority (descending) and creation time (ascending)
      items.sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return new Date(a.createdAt) - new Date(b.createdAt);
      });

      sendJson(res, {
        status,
        count: items.length,
        items,
      });
      return true;
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
      return true;
    }
  }

  // ── DELETE /api/queue/item/:id ──
  if (url.pathname.startsWith("/api/queue/item/") && req.method === "DELETE") {
    try {
      const id = url.pathname.replace("/api/queue/item/", "");
      const status = url.searchParams.get("status") || "pending";
      const queuePath = path.join(repoRoot, "data", "agent-work-queue", status);
      const itemPath = path.join(queuePath, `${id}.json`);

      if (!fs.existsSync(itemPath)) {
        sendJson(res, { error: `Item ${id} not found in ${status}` }, 404);
        return true;
      }

      // Safety check: don't allow deleting assigned items
      if (status === "assigned") {
        sendJson(res, { error: "Cannot delete assigned items - use recover instead" }, 400);
        return true;
      }

      fs.unlinkSync(itemPath);
      sendJson(res, {
        ok: true,
        message: `Deleted item ${id} from ${status}`,
      });
      return true;
    } catch (err) {
      console.error("[Queue] Delete error:", err);
      sendJson(res, { error: err.message }, 500);
      return true;
    }
  }

  // ── POST /api/queue/recover ──
  if (url.pathname === "/api/queue/recover" && req.method === "POST") {
    try {
      const QueueManager = require(path.join(repoRoot, "src", "queue-manager"));
      const queueManager = new QueueManager(path.join(repoRoot, "data", "agent-work-queue"));
      const recovered = queueManager.recoverStaleAssigned();

      sendJson(res, {
        ok: true,
        recovered: recovered.length,
        items: recovered,
        message: `Recovered ${recovered.length} stale assigned items`,
      });
      return true;
    } catch (err) {
      console.error("[Queue] Recover error:", err);
      sendJson(res, { error: err.message }, 500);
      return true;
    }
  }

  // ── POST /api/queue/prioritize/:id ──
  if (url.pathname.startsWith("/api/queue/prioritize/") && req.method === "POST") {
    try {
      const id = url.pathname.replace("/api/queue/prioritize/", "");
      const queuePath = path.join(repoRoot, "data", "agent-work-queue", "pending");
      const itemPath = path.join(queuePath, `${id}.json`);

      if (!fs.existsSync(itemPath)) {
        sendJson(res, { error: `Item ${id} not found in pending` }, 404);
        return true;
      }

      const item = JSON.parse(fs.readFileSync(itemPath, "utf8"));
      // Boost priority to max + 1
      item.priority = 9999;
      item.updatedAt = new Date().toISOString();
      fs.writeFileSync(itemPath, JSON.stringify(item, null, 2));

      sendJson(res, {
        ok: true,
        item,
        message: `Prioritized item ${id}`,
      });
      return true;
    } catch (err) {
      console.error("[Queue] Prioritize error:", err);
      sendJson(res, { error: err.message }, 500);
      return true;
    }
  }

  // ── GET /api/queue/agents ──
  // Real agent roster from .claude/agent-slots.json + assigned-work cross-ref.
  if (url.pathname === "/api/queue/agents" && req.method === "GET") {
    try {
      const { slots, stats } = loadAgentSlots(repoRoot);
      sendJson(res, { slots, stats, timestamp: new Date().toISOString() });
    } catch (err) {
      console.error("[Queue] Agents error:", err);
      sendJson(res, { error: err.message }, 500);
    }
    return true;
  }

  // ── POST /api/queue/assign ──
  // Assign the highest-priority pending issue to the best-fit idle agent slot.
  // Body (optional): { issueNumber } — pin a specific issue; omit to pick top of queue.
  // Writes an assignment record to data/agent-work-queue/assigned/issue-<N>.json
  // and invalidates the open-issues cache so the item is excluded from pending.
  if (url.pathname === "/api/queue/assign" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = raw ? JSON.parse(raw) : {};

      const open = loadOpenIssues(repoRoot);
      if (open.error) {
        sendJson(res, { ok: false, error: open.error, message: open.message }, 503);
        return true;
      }

      let issue = null;
      if (body.issueNumber) {
        issue = (open.items || []).find((i) => i.issueNumber === body.issueNumber) || null;
        if (!issue) {
          sendJson(res, { ok: false, error: `issue #${body.issueNumber} not found in pending queue` }, 404);
          return true;
        }
      } else {
        issue = (open.items || [])[0] || null;
      }

      if (!issue) {
        sendJson(res, { ok: false, error: "no_pending_issues", message: "Queue is empty" });
        return true;
      }

      const { slots } = loadAgentSlots(repoRoot);
      const slot = pickBestFitSlot(issue, slots);

      if (!slot) {
        sendJson(res, { ok: false, error: "no_idle_agents", message: "All agent slots are busy" });
        return true;
      }

      // Write assignment record.
      const assignedDir = path.join(repoRoot, "data", "agent-work-queue", "assigned");
      if (!fs.existsSync(assignedDir)) fs.mkdirSync(assignedDir, { recursive: true });

      const assignment = {
        ...issue,
        status: "assigned",
        assignedTo: slot.id,
        assignedAgent: slot.agent,
        assignedAt: new Date().toISOString(),
        fitScore: scoreFitness(issue.labels || [], slot.responsibilities || []),
      };

      fs.writeFileSync(
        path.join(assignedDir, `issue-${issue.issueNumber}.json`),
        JSON.stringify(assignment, null, 2)
      );

      // Bust cache so the next pending-queue fetch reflects the new assignment.
      _openIssuesCache = null;

      console.log(`[Queue] Assigned #${issue.issueNumber} → ${slot.id} (fit=${assignment.fitScore})`);
      sendJson(res, { ok: true, assignment });
      return true;
    } catch (err) {
      console.error("[Queue] Assign error:", err);
      sendJson(res, { error: err.message }, 500);
      return true;
    }
  }

  // ── POST /api/queue/dispatch-all ──
  // Greedily assign pending issues to all idle agents until queue or slots are exhausted.
  // Returns a list of all assignments made in this run.
  if (url.pathname === "/api/queue/dispatch-all" && req.method === "POST") {
    try {
      const assignedDir = path.join(repoRoot, "data", "agent-work-queue", "assigned");
      if (!fs.existsSync(assignedDir)) fs.mkdirSync(assignedDir, { recursive: true });

      const assignments = [];
      let iterations = 0;
      const MAX_ITERATIONS = 50;

      while (iterations++ < MAX_ITERATIONS) {
        // Re-read queue + slots each iteration (assignments from prior loop bust caches).
        const open = loadOpenIssues(repoRoot);
        if (open.error || !(open.items || []).length) break;

        const { slots } = loadAgentSlots(repoRoot);
        const issue = open.items[0];
        const slot = pickBestFitSlot(issue, slots);
        if (!slot) break; // no more idle slots

        const assignment = {
          ...issue,
          status: "assigned",
          assignedTo: slot.id,
          assignedAgent: slot.agent,
          assignedAt: new Date().toISOString(),
          fitScore: scoreFitness(issue.labels || [], slot.responsibilities || []),
        };

        fs.writeFileSync(
          path.join(assignedDir, `issue-${issue.issueNumber}.json`),
          JSON.stringify(assignment, null, 2)
        );

        _openIssuesCache = null; // bust so next iteration sees updated claimed set
        assignments.push({ issueNumber: issue.issueNumber, title: issue.title, slot: slot.id, fitScore: assignment.fitScore });
        console.log(`[Queue] dispatch-all: #${issue.issueNumber} → ${slot.id} (fit=${assignment.fitScore})`);
      }

      sendJson(res, { ok: true, dispatched: assignments.length, assignments });
      return true;
    } catch (err) {
      console.error("[Queue] Dispatch-all error:", err);
      sendJson(res, { error: err.message }, 500);
      return true;
    }
  }

  return false;
};

// Exposed for the auto-dispatch worker — single source of truth for the backlog queue.
module.exports.loadOpenIssues = loadOpenIssues;
module.exports.priorityFromLabels = priorityFromLabels;
// Exposed for the auto-pull loop's one-PR-per-lane guard (lib/auto-dispatch.js).
module.exports.loadPrLanes = loadPrLanes;
// Exposed for the boot-time queue reconcile (server.js) + tests: classify/GC stale
// assigned claims so the "In Progress" stat and pending backlog reflect reality.
module.exports.loadAssignedClaims = loadAssignedClaims;
module.exports.sweepStaleAssigned = sweepStaleAssigned;
