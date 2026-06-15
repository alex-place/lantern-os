/**
 * Agent Queue & Orchestration Routes
 * Exposes queue and slot manager operations via REST API
 */

module.exports = async function queueRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody, repoRoot } = deps;
  const fs = require("fs");
  const path = require("path");

  // ── GET /api/queue/status ── (minimal test endpoint)
  if (url.pathname === "/api/queue/status" && req.method === "GET") {
    sendJson(res, {
      ok: true,
      message: "Queue system online",
      queue: {
        pending: 0,
        assigned: 0,
        completed: 0,
        failed: 0,
      },
      agents: {
        totalSlots: 4,
        enabledSlots: 1,
        activeCount: 0,
        idleCount: 1,
        totalCompleted: 0,
        totalFailed: 0,
        successRate: 0,
      },
      timestamp: new Date().toISOString(),
    });
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
  // Returns agent slot status specific to queue management (not Tesseract fleet data)
  if (url.pathname === "/api/queue/agents" && req.method === "GET") {
    sendJson(res, {
      slots: [
        { id: "claude", status: "idle", currentWork: null, completedCount: 0, failedCount: 0 },
      ],
      health: [{ slot: "claude", status: "idle", healthy: true, message: "Healthy" }],
      stats: {
        totalSlots: 4,
        enabledSlots: 1,
        activeCount: 0,
        idleCount: 1,
        totalCompleted: 0,
        totalFailed: 0,
        successRate: 0,
      },
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  return false;
};
