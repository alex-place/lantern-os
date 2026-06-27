const { spawn } = require("child_process");
const { isOperatorRequest } = require("../lib/request-auth");

// Operator notes, conversation log, action triggers
module.exports = async function operatorRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody, appendJsonlQueued, operatorNotesPath,
    conversationLogPath, path, repoRoot,
    readConversationLog, normalizeConversationEntry, appendConversationEntry,
    runPowerShell, flatRagHousePath, writeFlatRagHouse } = deps;

  // #838: the privileged server-control actions below (run-loop, inspect, update→git pull+npm+
  // restart, local-controls→PowerShell, flat-rag-ingest) are operator-only. The local operator
  // dashboard hits loopback un-proxied; remote callers must present the OPERATOR_TOKEN header.
  // Previously these routes had NO auth check at all.
  if (url.pathname.startsWith("/api/actions/") && !isOperatorRequest(req)) {
    sendJson(res, { error: "operator auth required" }, 403);
    return true;
  }

  if (url.pathname === "/api/operator-notes" && req.method === "POST") {
    try {
      const body = await collectRequestBody(req);
      const input = JSON.parse(body || "{}");
      const text = String(input.text || "").trim().slice(0, 500);
      const priority = ["P0", "P1", "P2"].includes(input.priority) ? input.priority : "P1";
      if (!text) throw new Error("note_text_required");
      const record = { createdAt: new Date().toISOString(), text, priority, done: false };
      await appendJsonlQueued(operatorNotesPath, record);
      sendJson(res, { ok: true, record }, 201);
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }
  if (url.pathname === "/api/conversations" && req.method === "GET") {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 50)));
    const sessionId = String(url.searchParams.get("sessionId") || "").trim().slice(0, 64) || null;
    // #770: the un-scoped global (cross-session) read is operator-only. Never return the
    // whole log to anonymous/public callers — require a sessionId or operator auth.
    if (!sessionId && !isOperatorRequest(req)) {
      sendJson(res, {
        path: path.relative(repoRoot, conversationLogPath),
        sessionId: null,
        conversations: [],
        note: "cross-session read requires a sessionId or operator auth",
      });
      return true;
    }
    sendJson(res, {
      path: path.relative(repoRoot, conversationLogPath),
      sessionId,
      conversations: readConversationLog(limit, sessionId),
    });
    return true;
  }
  // List distinct chat sessions for the session switcher (#773). Title = the
  // session's opening user message; sorted most-recent first. `operator` tells
  // the UI whether to surface the gated "clear all history" control.
  if (url.pathname === "/api/conversations/sessions" && req.method === "GET") {
    const rows = readConversationLog(2000); // newest window, all sessions
    const byId = new Map();
    const customTitles = new Map(); // sessionId -> latest user-assigned name
    for (const r of rows) {
      if (!r || !r.sessionId) continue; // skip legacy untagged turns
      // A "session-title" turn is a rename overlay, not a chat turn: latest one
      // wins (rows are chronological) and it never counts toward turnCount.
      if (r.role === "session-title") {
        const name = String(r.text || "").replace(/\s+/g, " ").trim().slice(0, 80);
        if (name) customTitles.set(r.sessionId, name);
        else customTitles.delete(r.sessionId); // empty rename clears back to derived title
        continue;
      }
      let s = byId.get(r.sessionId);
      if (!s) { s = { sessionId: r.sessionId, title: "", lastActivity: "", turnCount: 0 }; byId.set(r.sessionId, s); }
      s.turnCount += 1;
      if (r.recordedAt && r.recordedAt > s.lastActivity) s.lastActivity = r.recordedAt;
      // rows are chronological within the window, so the first operator turn seen
      // for a session is its opening message — the natural title.
      if (!s.title && r.role === "operator" && r.text) s.title = String(r.text).replace(/\s+/g, " ").trim().slice(0, 80);
    }
    const sessions = [...byId.values()]
      .map((s) => ({ ...s, title: customTitles.get(s.sessionId) || s.title || "(untitled session)" }))
      .sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""))
      .slice(0, 50);
    sendJson(res, { sessions, operator: isOperatorRequest(req) });
    return true;
  }
  if (url.pathname === "/api/conversations" && req.method === "DELETE") {
    // Clear conversation history. Without ?sessionId, clears everything (admin reset);
    // with ?sessionId=X, removes only that session's turns. Always archives first.
    try {
      const fs = require("fs");
      const sessionId = String(url.searchParams.get("sessionId") || "").trim().slice(0, 64) || null;
      // #770: clearing ALL sessions is an operator-only admin reset; per-session clears
      // (?sessionId=) are self-service and allowed.
      if (!sessionId && !isOperatorRequest(req)) {
        sendJson(res, { error: "clear-all requires operator auth; pass ?sessionId to clear one session" }, 403);
        return true;
      }
      let lines = [];
      try {
        lines = fs.readFileSync(conversationLogPath, "utf8").split(/\r?\n/).filter(Boolean);
      } catch { /* missing file == already empty */ }

      if (lines.length) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const bak = path.join(path.dirname(conversationLogPath), `garage-conversations.cleared-${stamp}.jsonl.bak`);
        try { fs.copyFileSync(conversationLogPath, bak); } catch { /* best-effort archive */ }
      }

      let removed = 0;
      if (sessionId) {
        const kept = [];
        for (const line of lines) {
          let obj = null;
          try { obj = JSON.parse(line); } catch { kept.push(line); continue; }
          if (obj && obj.sessionId === sessionId) removed += 1;
          else kept.push(line);
        }
        fs.writeFileSync(conversationLogPath, kept.length ? kept.join("\n") + "\n" : "");
      } else {
        removed = lines.length;
        fs.writeFileSync(conversationLogPath, "");
      }
      sendJson(res, { ok: true, removed, scope: sessionId ? "session" : "all" });
    } catch (error) {
      sendJson(res, { error: error.message }, 500);
    }
    return true;
  }
  if (url.pathname === "/api/conversations" && req.method === "POST") {
    try {
      const body = await collectRequestBody(req);
      const entry = normalizeConversationEntry(JSON.parse(body || "{}"));
      await appendConversationEntry(entry);
      sendJson(res, { ok: true, entry }, 201);
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }
  if (url.pathname === "/api/actions/run-loop" && req.method === "POST") {
    try {
      const py = process.platform === "win32" ? "python" : "python3";
      const proc = spawn(py, [path.join(repoRoot, "src", "convergence_io_engine.py"), "loop"], {
        cwd: repoRoot,
        timeout: 60000,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (data) => { stdout += data; });
      proc.stderr.on("data", (data) => { stderr += data; });
      const result = await new Promise((resolve, reject) => {
        proc.on("close", (code) => {
          resolve({ ok: code === 0, code, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 1000) });
        });
        proc.on("error", (err) => reject(err));
      });
      sendJson(res, result, result.ok ? 200 : 500);
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500);
    }
    return true;
  }
  if (url.pathname === "/api/actions/inspect" && req.method === "GET") {
    try {
      const py = process.platform === "win32" ? "python" : "python3";
      const proc = spawn(py, [path.join(repoRoot, "src", "convergence_io_engine.py"), "inspect"], {
        cwd: repoRoot,
        timeout: 15000,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
      let stdout = "";
      proc.stdout.on("data", (d) => { stdout += d; });
      await new Promise((resolve) => proc.on("close", resolve));
      try {
        sendJson(res, JSON.parse(stdout));
      } catch {
        sendJson(res, { error: "parse_failed", raw: stdout.slice(0, 500) }, 500);
      }
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
    return true;
  }
  if (url.pathname === "/api/actions/local-controls" && req.method === "POST") {
    const result = await runPowerShell("scripts/Start-LanternLocalControls.ps1");
    sendJson(res, result, result.code === 0 ? 200 : 500);
    return true;
  }
  if (url.pathname === "/api/actions/flat-rag-ingest" && req.method === "POST") {
    const house = await writeFlatRagHouse();
    sendJson(res, {
      code: 0,
      stdout: `Flat RAG house updated: ${path.relative(repoRoot, flatRagHousePath)}`,
      stderr: "",
      house,
    });
    return true;
  }
  if (url.pathname === "/api/actions/update" && req.method === "POST") {
    try {
      const { execSync } = require("child_process");
      const steps = [];

      // Step 1: fetch origin/master and reset to it (works regardless of local branch name,
      // including worktrees where the branch has no upstream tracking configured).
      //
      // Guard: NEVER `reset --hard` over uncommitted work in the serving checkout.
      // A hard reset here silently destroys an in-progress interactive/agent edit
      // (this auto-update has clobbered live local changes — see autowork worktree
      // isolation). Mirror Invoke-OrchestratorRepoSync.ps1's policy and refuse on a
      // dirty tree; the operator can commit/stash, or update from a clean checkout.
      try {
        execSync("git fetch origin master --quiet", { cwd: repoRoot, encoding: "utf8", timeout: 30000 });
        const fetchedSha = execSync("git rev-parse origin/master", { cwd: repoRoot, encoding: "utf8" }).trim();
        const dirty = execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf8" }).trim();
        if (dirty) {
          const n = dirty.split("\n").filter(Boolean).length;
          steps.push({ step: "git_pull", ok: false,
            output: `Refusing to reset --hard origin/master: the serving checkout has ${n} uncommitted change(s). Local edits were preserved. Commit/stash them, or update from a clean checkout/worktree.` });
        } else {
          execSync("git reset --hard origin/master", { cwd: repoRoot, encoding: "utf8" });
          steps.push({ step: "git_pull", ok: true, output: `Reset to origin/master @ ${fetchedSha.slice(0, 8)}`, branch: "master" });
        }
      } catch (e) {
        steps.push({ step: "git_pull", ok: false, output: e.stdout?.trim() || e.message });
      }

      // Step 2: npm install
      try {
        const npm = execSync("npm install --prefix apps/lantern-garage", { cwd: repoRoot, encoding: "utf8", timeout: 60000 });
        steps.push({ step: "npm_install", ok: true, output: npm.trim() });
      } catch (e) {
        steps.push({ step: "npm_install", ok: false, output: e.stdout?.trim() || e.message });
      }

      // Step 3: auto-version and get new version info
      try {
        const autoVersionScript = path.join(repoRoot, "scripts/auto-version.js");
        if (require("fs").existsSync(autoVersionScript)) {
          require("child_process").execSync(`node ${autoVersionScript}`, { cwd: repoRoot, encoding: "utf8" });
        }
      } catch (e) {
        console.error("[Auto-version] Error:", e.message);
      }

      let newVersion = { commit: "unknown", tag: "unknown", semver: "unknown", buildId: "unknown", timestamp: "unknown" };
      try {
        const commit = execSync("git rev-parse --short HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
        const tag = execSync("git describe --tags --always", { cwd: repoRoot, encoding: "utf8" }).trim();
        newVersion = { commit, tag };
        try {
          // Read from public/version.json to match status.js endpoint
          const vjPath = path.join(repoRoot, "apps/lantern-garage/public/version.json");
          const vj = JSON.parse(require("fs").readFileSync(vjPath, "utf8"));
          if (vj.version) newVersion.semver = vj.version;
          if (vj.buildId) newVersion.buildId = vj.buildId;
          if (vj.timestamp) newVersion.timestamp = vj.timestamp;
        } catch {}
      } catch {}

      const allOk = steps.every(s => s.ok);
      const pullOutput = steps.find(s => s.step === "git_pull")?.output || "";
      const codeChanged = allOk && !pullOutput.includes("Already up to date");

      // Step 4: schedule restart only if new code was actually pulled
      if (codeChanged) {
        setTimeout(() => {
          try {
            const { execSync } = require("child_process");
            // Try PM2 first (if globally installed and ecosystem.config.js exists)
            const pm2Config = require("path").join(repoRoot, "apps/lantern-garage/ecosystem.config.js");
            try {
              execSync("pm2 restart lantern-garage", { cwd: repoRoot, encoding: "utf8", timeout: 15000, stdio: "pipe" });
              process.exit(0);
            } catch {
              // PM2 not available, try watchdog
            }
            // Fallback: watchdog.js (pure Node.js supervisor)
            try {
              execSync("node apps/lantern-garage/watchdog.js", { cwd: repoRoot, encoding: "utf8", timeout: 5000, stdio: "pipe" });
              process.exit(0);
            } catch {
              // Watchdog failed, final fallback
            }
            // Final fallback: detached spawn (old behavior)
            // Use server-dev.js when running on dev port 4178, otherwise server.js
            const serverScript = (process.env.LANTERN_GARAGE_PORT === "4178")
              ? "apps/lantern-garage/server-dev.js"
              : "apps/lantern-garage/server.js";
            const restartScript = process.platform === "win32"
              ? `Start-Sleep -Seconds 2; Start-Process node -ArgumentList "${serverScript}" -WindowStyle Hidden`
              : `sleep 2 && node ${serverScript}`;
            const shell = process.platform === "win32" ? "powershell.exe" : "sh";
            const args = process.platform === "win32" ? ["-Command", restartScript] : ["-c", restartScript];
            spawn(shell, args, { detached: true, stdio: "ignore", cwd: repoRoot });
            process.exit(0);
          } catch (restartErr) {
            console.error("Restart failed:", restartErr.message);
            process.exit(1);
          }
        }, 1000);
      }

      sendJson(res, { ok: allOk, steps, version: newVersion, restart_scheduled: codeChanged }, allOk ? 200 : 500);
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500);
    }
    return true;
  }
};
