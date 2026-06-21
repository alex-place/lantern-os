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

  const { safeExec } = require(require("path").join(repoRoot, "apps", "lantern-garage", "lib", "safe-exec"));
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

  const { safeExec } = require(path.join(repoRoot, "apps", "lantern-garage", "lib", "safe-exec"));
  let issues = [];
  try {
    const out = safeExec(
      ["gh", "issue", "list", "--repo", "alex-place/lantern-os", "--state", "open",
       "--json", "number,title,labels,updatedAt,url", "--limit", "100"],
      { cwd: repoRoot, timeout: 15000 }
    );
    issues = JSON.parse(out || "[]");
  } catch (err) {
    const data = { items: [], source: "github", error: "gh_unavailable", message: String(err.message || err).slice(0, 200) };
    _openIssuesCache = { ts: now, data };
    return data;
  }

  // Exclude issues already claimed by an agent (tracked locally in assigned/).
  const claimed = new Set();
  try {
    const assignedDir = path.join(repoRoot, "data", "agent-work-queue", "assigned");
    if (fs.existsSync(assignedDir)) {
      for (const f of fs.readdirSync(assignedDir).filter((x) => x.endsWith(".json"))) {
        try { claimed.add(JSON.parse(fs.readFileSync(path.join(assignedDir, f), "utf8")).issueNumber); } catch { /* skip */ }
      }
    }
  } catch { /* no assigned dir */ }

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

  const data = { items, source: "github", generatedAt: new Date().toISOString() };
  _openIssuesCache = { ts: now, data };
  return data;
}

module.exports = async function queueRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody, repoRoot } = deps;
  const fs = require("fs");
  const path = require("path");

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
      // assigned/completed/failed remain local in-flight execution state.
      const pending = (loadOpenIssues(repoRoot).items || []).length;
      const assigned = countJson("assigned") + countJson("in_progress");
      const completed = countJson("completed");
      const failed = countJson("failed");
      const total = pending + assigned + completed + failed;
      const settled = completed + failed;

      sendJson(res, {
        ok: true,
        message: "Queue system online",
        queue: { pending, assigned, completed, failed, total },
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

  return false;
};

// Exposed for the auto-dispatch worker — single source of truth for the backlog queue.
module.exports.loadOpenIssues = loadOpenIssues;
module.exports.priorityFromLabels = priorityFromLabels;
