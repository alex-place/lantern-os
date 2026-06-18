  const messagesEl = document.getElementById("messages");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send-btn");
  const statusDot = document.getElementById("status-dot");
  const statusLabel = document.getElementById("status-label");
  const emptyState = document.getElementById("empty-state");
  const providerSelect = document.getElementById("provider-select");
  const mcpToggle = document.getElementById("mcp-toggle");
  let directModeEnabled = false;
  let keystoneMcpEnabled = false; // legacy compat
  let originalAgents = [];
  // ── ROUTE INTENT DETECTION ────────────────────────────────────────────────
  // Returns a route intent string used to select the backend agent/surface.
  // RP is opt-in only — general chat, code work, and GitHub work use the router.
  const RP_OPT_IN_RE = /open.*three[-_]?doors|roleplay|role[-\s]?play|continue the scene|\bas (lantern|blinkbug|waterfall|xenon|founder)\b/i;
  const CODING_TRIGGERS = [
    "make changes", "make a change", "change the code", "edit the code",
    "modify the code", "integrate this", "wire this", "wire into",
    "add to repo", "add to the repo", "commit to", "push to",
    "prep a pr", "prepare a pr", "create a pr", "open a pr", "fix the pr",
    "fix latest pr", "scan the pr", "scan latest pr", "review the pr",
    "merge the pr", "handoff to claude code", "handoff to claude",
    "make a handoff", "claude code", "use claude code", "coding agent",
    "code change", "code changes", "repo change", "repo changes",
    "git change", "github change", "bug fix", "fix the bug", "fix bug",
    "fix this bug", "refactor", "improve the code", "add tests",
    "add a test", "fix the test", "implement", "implementation",
    "deploy", "deployment", "pull request", "open pr", "create pr",
  ];

  function detectRouteIntent(msg) {
    const lower = (msg || "").toLowerCase().trim();
    if (RP_OPT_IN_RE.test(msg)) return "dream_chat";
    if (CODING_TRIGGERS.some(t => lower.includes(t))) return "coding_change";
    if (/\b(debug|error|broken|crash|not working|not responding)\b/i.test(lower)) return "technical_debug";
    if (/\b(buy|sell|trade|trading|position|portfolio|market|ticker|stock|kalshi|prediction market|should i (buy|sell|hold))\b/i.test(lower)) return "trading";
    if (/\b(remember (this|that)|save (this|that)|log (this|that)|add to (my )?(journal|memory|notes?))\b/i.test(lower)) return "memory";
    if (/\b(show me a? ?(video|clip|youtube)|play a? ?video|find a? ?video)\b/i.test(lower)) return "media";
    return "general";
  }

  // Map intent → subtle UI label shown below input on auto-detect
  const INTENT_LABELS = {
    trading: "📈 Trading context",
    memory: "💾 Saving to journal",
    media: "🎬 Media search",
  };

  // Agent is contextual — Lantern is default, others triggered by name in message
  function detectAgent(msg) {
    const lower = (msg || "").toLowerCase();
    if (lower.includes("keystone") || lower.includes("debug")) return "keystone";
    if (lower.includes("blinkbug") || lower.includes("glitch")) return "blinkbug";
    if (lower.includes("waterfall") || lower.includes("gentle")) return "waterfall";
    if (lower.includes("xenon") || lower.includes("navigate")) return "xenon";
    if (lower.includes("founder") || lower.includes("wish")) return "founder";
    return "lantern";
  }

  // Telemetry shim (logs to console; replace with real telemetry if needed)
  const TELEMETRY = {
    log(scope, msg) { console.log(`[${scope}]`, msg); },
    warn(scope, msg) { console.warn(`[${scope}]`, msg); },
    error(scope, msg, extra) { console.error(`[${scope}]`, msg, extra || ""); }
  };

  let isStreaming = false;
  // Conversation history for multi-turn context — [{role:"user"|"assistant", text:"..."}]
  const conversationHistory = [];

  // ── Analytics / Debug collector ─────────────────────────────────────────────────────
  const analytics = {
    sessionStart: Date.now(),
    messagesSent: 0,
    tokensReceived: 0,
    errors: 0,
    fallbacks: 0,
    latencies: [], // ms per response
    lastProvider: null,
    lastAgent: null,
    log: [],
    record(type, detail) {
      const entry = { t: Date.now(), type, detail };
      this.log.push(entry);
      const logEl = document.getElementById("debug-log");
      if (logEl) {
        const line = document.createElement("div");
        line.className = "debug-log-entry";
        const time = new Date(entry.t).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
        line.textContent = `${time}  ${type}: ${detail}`;
        logEl.prepend(line);
        while (logEl.children.length > 50) logEl.lastChild.remove();
      }
      this.render();
    },
    render() {
      const elapsed = Math.round((Date.now() - this.sessionStart) / 1000);
      const mins = Math.floor(elapsed / 60).toString().padStart(2, "0");
      const secs = (elapsed % 60).toString().padStart(2, "0");
      const sessionEl = document.getElementById("dbg-session");
      if (sessionEl) sessionEl.textContent = `${mins}:${secs}`;
      const msgEl = document.getElementById("dbg-messages");
      if (msgEl) msgEl.textContent = this.messagesSent;
      const tokenEl = document.getElementById("dbg-tokens");
      if (tokenEl) tokenEl.textContent = this.tokensReceived;
      const errEl = document.getElementById("dbg-errors");
      if (errEl) {
        errEl.textContent = this.errors;
        errEl.className = "debug-val " + (this.errors > 0 ? "err" : "ok");
      }
      const fbEl = document.getElementById("dbg-fallbacks");
      if (fbEl) {
        fbEl.textContent = this.fallbacks;
        fbEl.className = "debug-val " + (this.fallbacks > 0 ? "warn" : "ok");
      }
      const avg = this.latencies.length > 0
        ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length) + " ms"
        : "—";
      const latEl = document.getElementById("dbg-latency");
      if (latEl) latEl.textContent = avg;
      const provEl = document.getElementById("dbg-provider");
      if (provEl) provEl.textContent = this.lastProvider || "—";
      const agentEl = document.getElementById("dbg-agent");
      if (agentEl) agentEl.textContent = this.lastAgent || "—";
    },
  };
  setInterval(() => analytics.render(), 1000);
  function toggleDebug() {
    const panel = document.getElementById("debug-panel");
    if (panel) panel.classList.toggle("open");
  }

  function toggleKeystoneMcp() {
    directModeEnabled = !directModeEnabled;
    keystoneMcpEnabled = directModeEnabled; // legacy compat
    if (mcpToggle) mcpToggle.classList.toggle("active", directModeEnabled);
    const appEl = document.querySelector(".app");
    if (appEl) appEl.classList.toggle("mcp-mode", directModeEnabled);
    const inputArea = document.querySelector(".input-area");
    if (inputArea) inputArea.classList.toggle("mcp-mode", directModeEnabled);
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "d" && !e.ctrlKey && !e.metaKey && !e.altKey && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "INPUT") {
      toggleDebug();
    }
  });

  // On static hosts (GitHub Pages, file://) the API server isn't running.
  // Point at the expected local address and surface a clear banner if unreachable.
  const isStaticHost = window.location.hostname !== "127.0.0.1" && window.location.hostname !== "localhost";
  let serverBase = isStaticHost ? "http://127.0.0.1:4177" : window.location.origin;

  // Load version badge from version.json (bump minor in each PR)
  fetch(`${serverBase}/version.json?t=${Date.now()}`, { cache: "no-store" })
    .then(r => r.ok ? r.json() : null)
    .then(v => {
      if (v?.version) {
        const el = document.getElementById("app-version");
        if (el) el.textContent = `Lantern OS v${v.version} · private · local`;
      }
    })
    .catch(() => {});

  if (isStaticHost) {
    const banner = document.createElement("div");
    banner.style.cssText = "position:fixed;top:0;left:0;right:0;background:#1a1a2e;color:#e2c97e;padding:10px 16px;font-size:0.85rem;text-align:center;z-index:9999;border-bottom:1px solid #e2c97e44;";
    banner.innerHTML = 'Dream Chat requires the local server. Run <code style="background:#0d0d1a;padding:2px 6px;border-radius:3px;">npm start --prefix apps/lantern-garage</code> then open <a href="http://127.0.0.1:4177/dream-chat.html" style="color:#e2c97e;">http://127.0.0.1:4177/dream-chat.html</a>';
    document.body.prepend(banner);
  }

  let agents = [];

  // ── Load agents ────────────────────────────────────────────────────────
  async function loadAgents() {
    try {
      TELEMETRY.log("agents", "Fetching /api/agents");
      const r = await fetch(`${serverBase}/api/agents`, { signal: AbortSignal.timeout(3000) });
      TELEMETRY.log("agents", `/api/agents response`, { ok: r.ok, status: r.status });
      if (r.ok) {
        const data = await r.json();
        agents = data.agents || [];
        originalAgents = agents;
        if (statusDot) statusDot.className = "dot online";
        if (statusLabel) statusLabel.textContent = "online";
        TELEMETRY.log("agents", `Loaded ${agents.length} agents`);
        return;
      }
      TELEMETRY.warn("agents", `Non-OK response loading agents: ${r.status}`);
    } catch (err) {
      TELEMETRY.error("agents", `Failed to load agents: ${err.message}`, { serverBase });
    }
    if (statusDot) statusDot.className = "dot";
    if (statusLabel) statusLabel.textContent = "offline";
  }
  loadAgents();

  // ── Load conversation history (REMEMBER stage — issue #647) ───────────────
  async function loadConversationHistory() {
    try {
      const r = await fetch(`${serverBase}/api/conversations?limit=20`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return;
      const data = await r.json();
      const entries = (data.conversations || []).filter(e => e.role === "operator" || e.role === "lantern");
      if (entries.length === 0) return;

      if (emptyState) emptyState.style.display = "none";

      const fragment = document.createDocumentFragment();
      for (const entry of entries) {
        const isUser = entry.role === "operator";
        conversationHistory.push({ role: isUser ? "user" : "assistant", text: entry.text });
        const row = document.createElement("div");
        row.className = `msg-row ${isUser ? "user" : "agent"}`;
        const time = entry.recordedAt ? new Date(entry.recordedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
        row.innerHTML = `<div class="msg-label">${isUser ? "You" : "Lantern"}${time ? " · " + time : ""}</div><div class="bubble">${escapeHtml(entry.text)}</div>`;
        fragment.appendChild(row);
      }
      messagesEl.appendChild(fragment);
      scrollToBottom();
    } catch { /* non-critical — fresh session is fine */ }
  }
  loadConversationHistory();

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // ── Autoupdate helper ───────────────────────────────────────────────────
  function triggerAutoupdate(label) {
    const row = document.createElement("div");
    row.className = "msg-row agent";
    row.innerHTML = `<div class="msg-label">System</div><div class="bubble"><b>${label}</b> — checking for updates…</div>`;
    messagesEl.appendChild(row);
    scrollToBottom();
    fetch(`${serverBase}/api/actions/update`, { method: "POST" })
      .then(r => r.json())
      .then(d => {
        const ver = d.version?.semver || d.version?.tag || "?";
        const pullOutput = d.steps?.find(s => s.step === "git_pull")?.output || "";
        const alreadyUpToDate = pullOutput.includes("Already up to date");
        const status = alreadyUpToDate ? "Already up to date" : (d.ok ? "Updated" : "Failed");
        row.querySelector(".bubble").innerHTML =
          `<b>${status}</b> · v${ver}`;
        scrollToBottom();
      })
      .catch(e => {
        row.querySelector(".bubble").textContent = `${label} failed: ${e.message}`;
        scrollToBottom();
      });
  }

  // ── Send ────────────────────────────────────────────────────────────────
  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || isStreaming) return;
    // !debug toggles the analytics panel without sending a message
    if (text === "!debug") {
      inputEl.value = "";
      toggleDebug();
      return;
    }
    // !autoupdate pulls latest code, installs deps, and restarts server
    if (text === "!autoupdate") {
      inputEl.value = "";
      inputEl.style.height = "auto";
      const sysRow = document.createElement("div");
      sysRow.className = "msg-row agent";
      sysRow.innerHTML = `<div class="msg-label">System</div><div class="bubble">Auto-update: pulling latest code…</div>`;
      messagesEl.appendChild(sysRow);
      scrollToBottom();
      fetch(`${serverBase}/api/actions/update`, { method: "POST" })
        .then(async (r) => {
          const d = await r.json();
          const ver = d.version?.semver || d.version?.tag || "?";
          const pullOutput = (d.steps || []).find(s => s.step === "git_pull")?.output || "";
          const alreadyUpToDate = pullOutput.includes("Already up to date");
          const status = alreadyUpToDate ? "Already up to date" : (d.ok ? "Updated" : "Failed");
          const steps = (d.steps || []).map(s => `${s.ok ? "✓" : "✗"} ${s.step}`).join("\n");
          sysRow.querySelector(".bubble").innerHTML =
            `<b>${status}</b> · v${ver}<br><pre style="margin-top:6px;white-space:pre-wrap;font-size:12px;opacity:0.85;">${escapeHtml(steps)}${d.restart_scheduled ? "\n✓ restart_scheduled" : ""}</pre>`;
          scrollToBottom();
          if (d.ok && d.restart_scheduled) {
            const msg = document.createElement("div");
            msg.className = "msg-row agent";
            msg.innerHTML = `<div class="msg-label">System</div><div class="bubble">Restarting… hard reload in 3s</div>`;
            messagesEl.appendChild(msg);
            scrollToBottom();
            setTimeout(() => {
              if ('caches' in window) caches.keys().then(names => names.forEach(n => caches.delete(n)));
              if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister()));
              window.location.reload(true);
            }, 3000);
          }
        })
        .catch((e) => {
          sysRow.querySelector(".bubble").textContent = `Auto-update failed: ${e.message}`;
          scrollToBottom();
        });
      return;
    }
    // !convergence / !convergance — loop + agent status + inspect + version
    if (/^!converg(?:ence|ance)$/i.test(text)) {
      inputEl.value = "";
      const sysRow = document.createElement("div");
      sysRow.className = "msg-row agent";
      sysRow.innerHTML = `<div class="msg-label">Keystone</div><div class="bubble" style="font-size:13px">Running convergence loop…</div>`;
      messagesEl.appendChild(sysRow);
      scrollToBottom();

      const runLoop      = fetch(`${serverBase}/api/actions/run-loop`, { method: "POST" });
      const fetchVersion = fetch(`${serverBase}/api/version`).then(r => r.ok ? r.json() : null).catch(() => null);
      const fetchAgents  = fetch(`${serverBase}/api/dream/status/agents`).then(r => r.ok ? r.json() : null).catch(() => null);
      const fetchInspect = fetch(`${serverBase}/api/actions/inspect`).then(r => r.ok ? r.json() : null).catch(() => null);

      Promise.all([runLoop, fetchVersion, fetchAgents, fetchInspect])
        .then(async ([loopR, versionD, agentD, inspectD]) => {
          const d = await loopR.json();
          const rawOut = d.stdout || "";
          const tag    = versionD?.version?.semver || versionD?.version?.tag || "–";
          const commit = versionD?.version?.commit ? versionD.version.commit.slice(0, 7) : "?";

          // Parse convergence score + promotion from loop JSON output
          let score = null, promo = null;
          try {
            const m = rawOut.match(/\{[\s\S]*"promotion_ready"[\s\S]*?\}/);
            if (m) { const j = JSON.parse(m[0]); score = j.convergence_score; promo = j.promotion_ready; }
          } catch {}

          const scoreStr = score != null ? `score ${(score * 100).toFixed(0)}%` : "";
          const promoStr = promo === true ? "✓ promotion_ready" : promo === false ? "✗ not ready" : "";
          const header = `<b>Convergence</b> ${loopR.ok ? "✓" : "✗"} · <code>${tag}</code> <code>${commit}</code> ${scoreStr} ${promoStr}`.trim();

          // Agent fleet block
          let agentBlock = "";
          if (agentD?.text) {
            agentBlock = `<div style="margin-top:10px;padding:8px;background:var(--surface2);border-radius:6px;font-size:12px"><b>Agent Fleet</b><pre style="margin:4px 0 0;white-space:pre-wrap;color:var(--accent);opacity:0.9;">${escapeHtml(agentD.text)}</pre></div>`;
          } else if (agentD?.queue) {
            const q = agentD.queue;
            agentBlock = `<div style="margin-top:10px;padding:8px;background:var(--surface2);border-radius:6px;font-size:12px"><b>Queue</b> — ${q.pending} pending · ${q.working} working · ${q.completed} done</div>`;
          }

          // CSF-agent top issue from inspect
          let csfBlock = "";
          const csf = inspectD?.csf_agent;
          if (csf) {
            if (csf.pending_specs > 0) {
              csfBlock = `<div style="margin-top:8px;padding:8px;background:rgba(161,139,250,0.08);border-left:2px solid var(--accent);font-size:12px"><b>CSF Agent</b> · ${csf.pending_specs} spec${csf.pending_specs > 1 ? "s" : ""} awaiting review<br><span style="opacity:0.7">${(csf.specs || []).map(s => escapeHtml(s)).join(", ")}</span></div>`;
            } else if (csf.top_issue) {
              const t = csf.top_issue;
              csfBlock = `<div style="margin-top:8px;padding:8px;background:rgba(6,182,212,0.06);border-left:2px solid var(--accent);font-size:12px"><b>Top Issue</b> · #${t.number} <a href="https://github.com/alex-place/lantern-os/issues/${t.number}" target="_blank" style="color:var(--accent)">${escapeHtml(t.title)}</a><br><span style="opacity:0.6">score ${(t.score * 100).toFixed(0)}% · run loop.py --once to generate spec</span></div>`;
            }
          }

          const bubble = sysRow.querySelector(".bubble");
          bubble.innerHTML = header + agentBlock + csfBlock;
          scrollToBottom();
        })
        .catch((e) => {
          sysRow.querySelector(".bubble").textContent = `Convergence loop failed: ${e.message}`;
          scrollToBottom();
        });
      return;
    }
    // !comet-leap shows COMET-LEAP plan status + auto-update
    if (text === "!comet-leap") {
      inputEl.value = "";
      triggerAutoupdate("Auto-update");
      const sysRow = document.createElement("div");
      sysRow.className = "msg-row agent";
      sysRow.innerHTML = `<div class="msg-label">System</div><div class="bubble"><b>COMET LEAP</b> — Master Plan v1.0<br>Status: APPROVED FOR PRINTING · Confidence: 72%<br><a href="/view?path=lantern-discord/COMET-LEAP-MASTER-PLAN-v1.0.md" target="_blank" style="color:var(--accent);">Open full plan ↗</a></div>`;
      messagesEl.appendChild(sysRow);
      scrollToBottom();
      return;
    }
    // Special handling for Kingdome of Hearts game
    const kingdomeMatch = text.match(/^!(?:three-doors|threedoors|doors|kingdome|kingdome-of-hearts)\b/i);
    if (kingdomeMatch) {
      if (emptyState) emptyState.style.display = "none";
      inputEl.value = "";
      analytics.messagesSent++;
      analytics.record("send", "Kingdome of Hearts game started");
      startThreeDoors();
      return;
    }

    // !convergance log an issue <title> — POST to non-stream handler
    if (/^!converg(?:ence|ance)\s+log\s+an?\s+issue\s+/i.test(text)) {
      if (emptyState) emptyState.style.display = "none";
      appendUserBubble(text);
      inputEl.value = "";
      const sysRow = document.createElement("div");
      sysRow.className = "msg-row agent";
      sysRow.innerHTML = `<div class="msg-label">Keystone</div><div class="bubble">Logging issue…</div>`;
      messagesEl.appendChild(sysRow);
      scrollToBottom();
      fetch(`${serverBase}/api/dream/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      })
        .then(r => r.json())
        .then(d => { sysRow.querySelector(".bubble").textContent = d.reply || "Done."; scrollToBottom(); })
        .catch(e => { sysRow.querySelector(".bubble").textContent = `Failed: ${e.message}`; scrollToBottom(); });
      return;
    }

    // Allow backend-streaming bang commands through; reject truly unknown ones
    const STREAMING_BANGS = ["swarm", "converge", "convergance", "self-edit", "selfedit", "code", "review"];
    const bangMatch = text.match(/^!(\S+)/);
    if (bangMatch) {
      const cmdName = bangMatch[1].toLowerCase();
      if (!STREAMING_BANGS.includes(cmdName)) {
        inputEl.value = "";
        const errRow = document.createElement("div");
        errRow.className = "msg-row agent";
        errRow.innerHTML = `<div class="msg-label">System</div><div class="bubble" style="color:var(--danger);">Unsupported command: !${escapeHtml(cmdName)}</div>`;
        messagesEl.appendChild(errRow);
        scrollToBottom();
        return;
      }
    }
    if (emptyState) emptyState.style.display = "none";
    appendUserBubble(text);
    inputEl.dataset.lastMsg = text;
    inputEl.value = "";
    analytics.messagesSent++;
    analytics.lastAgent = directModeEnabled ? "Direct" : detectAgent(text);
    analytics.record("send", text.slice(0, 40));
    analytics._msgStart = Date.now();

    // Auto-detect intent and show context chip if non-default
    const autoIntent = detectRouteIntent(text);
    const intentLabel = INTENT_LABELS[autoIntent];
    if (intentLabel) {
      const chip = document.createElement("div");
      chip.className = "msg-row agent intent-chip";
      chip.innerHTML = `<div class="bubble" style="font-size:12px;opacity:0.7;padding:4px 10px;">${intentLabel} · auto-detected</div>`;
      messagesEl.appendChild(chip);
      scrollToBottom();
    }

    // "remember this" — auto-save to journal without full stream round-trip
    if (autoIntent === "memory") {
      const prevUser = conversationHistory.slice(-3).filter(e => e.role === "user").map(e => e.text).join(" / ");
      const saveText = prevUser || text;
      fetch(`${serverBase}/api/dream/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "note", text: saveText, tags: ["memory", "auto-saved"], source: "dream-chat" }),
      }).catch(() => {});
    }

    streamAgentResponse(text, autoIntent);
  }

  function appendUserBubble(text) {
    conversationHistory.push({ role: "user", text });
    const row = document.createElement("div");
    row.className = "msg-row user";
    row.innerHTML = `<div class="msg-label">You · ${fmtTime(new Date())}</div><div class="bubble">${escapeHtml(text)}</div>`;
    messagesEl.appendChild(row);
    scrollToBottom();
  }

  // ── Stream agent response ───────────────────────────────────────────────────
  async function streamAgentResponse(message, clientIntent) {
    stopSpeaking();
    isStreaming = true;
    sendBtn.disabled = true;
    setThinking(true);

    const agentName = directModeEnabled ? "Model" : (agents.find((a) => a.id === detectAgent(message))?.name || "Lantern");
    const msgTime = new Date();
    const row = document.createElement("div");
    row.className = "msg-row agent";

    const label = document.createElement("div");
    label.className = "msg-label";
    label.textContent = `${agentName} · ${fmtTime(msgTime)}`;

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    const cursor = document.createElement("span");
    cursor.className = "cursor";
    bubble.appendChild(cursor);

    row.appendChild(label);
    row.appendChild(bubble);
    messagesEl.appendChild(row);
    scrollToBottom();

    let fullText = "";
    let hasTokens = false;
    const provider = providerSelect.value;
    // POST with history for multi-turn context; history excludes current message (already appended)
    const historyToSend = conversationHistory.slice(0, -1).slice(-6); // last 6 turns before this message

    fetch(`${serverBase}/api/dream/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        provider: provider || undefined,
        history: historyToSend,
        mcp: directModeEnabled,
        routeIntent: clientIntent || undefined,
      }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.body;
      })
      .then((body) => {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        let streamFinished = false;
        let hadDoneEvent = false;
        let routeInfo = null;
        let receiptInfo = null;
        function processLines(lines) {
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw) continue;
            try {
              const evt = JSON.parse(raw);
              if (evt.type === "route") {
                routeInfo = evt;
                // Show routing card with info from actual server-side routing decision
                if (!document.querySelector(".route-card")) {
                  const rc = document.createElement("div");
                  rc.className = "route-card";
                  rc.textContent = evt.label || `${evt.agentName} · ${evt.surface}`;
                  bubble.insertBefore(rc, cursor);
                }
              }
              if (evt.type === "receipt") {
                receiptInfo = evt;
              }
              if (evt.type === "image" && evt.url) {
                // Display image in the message bubble
                cursor.remove();
                let imgContainer = bubble.querySelector(".bubble-images");
                if (!imgContainer) {
                  imgContainer = document.createElement("div");
                  imgContainer.className = "bubble-images";
                  bubble.appendChild(imgContainer);
                }
                const img = document.createElement("img");
                img.src = evt.url;
                img.alt = evt.alt || "Response image";
                img.className = "bubble-image";
                img.style.maxWidth = "100%";
                img.style.height = "auto";
                img.style.borderRadius = "6px";
                img.style.marginTop = "8px";
                img.style.cursor = "pointer";
                img.onclick = () => {
                  // Open image in modal on click
                  const modal = document.createElement("div");
                  modal.className = "image-modal-overlay";
                  modal.style.position = "fixed";
                  modal.style.top = "0";
                  modal.style.left = "0";
                  modal.style.width = "100%";
                  modal.style.height = "100%";
                  modal.style.background = "rgba(0,0,0,0.9)";
                  modal.style.display = "flex";
                  modal.style.justifyContent = "center";
                  modal.style.alignItems = "center";
                  modal.style.zIndex = "10000";
                  const closeBtn = document.createElement("button");
                  closeBtn.textContent = "✕";
                  closeBtn.style.position = "absolute";
                  closeBtn.style.top = "20px";
                  closeBtn.style.right = "20px";
                  closeBtn.style.background = "rgba(255,255,255,0.2)";
                  closeBtn.style.border = "1px solid white";
                  closeBtn.style.color = "white";
                  closeBtn.style.fontSize = "24px";
                  closeBtn.style.cursor = "pointer";
                  closeBtn.style.padding = "10px 16px";
                  closeBtn.style.borderRadius = "4px";
                  closeBtn.onclick = () => modal.remove();
                  const modalImg = document.createElement("img");
                  modalImg.src = evt.url;
                  modalImg.alt = evt.alt || "Expanded image";
                  modalImg.style.maxWidth = "90%";
                  modalImg.style.maxHeight = "90%";
                  modalImg.style.borderRadius = "8px";
                  modal.appendChild(closeBtn);
                  modal.appendChild(modalImg);
                  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
                  document.body.appendChild(modal);
                };
                imgContainer.appendChild(img);
                bubble.appendChild(cursor);
                scrollToBottom();
              }
              if (evt.type === "token" && evt.text) {
                if (!hasTokens) { hasTokens = true; setThinking(false); }
                fullText += evt.text;
                streamTtsBuf += evt.text;
                streamTtsFlush(false);
                analytics.tokensReceived++;
                cursor.remove();
                // Strip [DOORS:...] tag during streaming; chips rendered on done
                const visibleText = fullText.replace(/\[DOORS:[^\]]*\]?/i, "").replace(/\n{3,}/g, "\n\n").trimEnd();
                // Use a dedicated text node so the route-card child isn't wiped
                let textNode = bubble.querySelector(".bubble-text");
                if (!textNode) {
                  textNode = document.createElement("span");
                  textNode.className = "bubble-text";
                  bubble.appendChild(textNode);
                }
                textNode.textContent = visibleText;
                bubble.appendChild(cursor);
                scrollToBottom();
              }
              if (evt.type === "error" && evt.text) {
                analytics.errors++;
                analytics.record("error", evt.text);
                appendErrorNotice(row, evt.text);
              }
              if (evt.type === "done" && !streamFinished) {
                hadDoneEvent = true;
                streamFinished = true;
                const displayText = evt.cleanText || fullText;
                if (evt.cleanText && evt.cleanText !== fullText) {
                  bubble.textContent = evt.cleanText;
                }
                // Update Loop Depth observer panel (Ouro Σ₀ CDF exit)
                try {
                  const loopN = evt.loop_n ?? 1;
                  const conf = evt.confidence ?? (evt.sigma0?.claims ? Math.min(1, 0.5 + evt.sigma0.claims * 0.08) : 0.5);
                  const exitReason = evt.exit_reason ?? 'single_pass';
                  const loopEl = document.getElementById('obs-loop-depth');
                  const fillEl = document.getElementById('obs-loop-fill');
                  if (loopEl) loopEl.textContent = `⟳ ${loopN} loop${loopN !== 1 ? 's' : ''} · ${Math.round(conf * 100)}% conf · ${exitReason}`;
                  if (fillEl) fillEl.style.width = (conf * 100) + '%';
                } catch (_) {}

                // Parse [DOORS: A name | B name | C name] from full text if backend didn't extract
                let suggestions = evt.suggestions;
                if (!suggestions || suggestions.length === 0) {
                  const doorsMatch = fullText.match(/\[DOORS:\s*([^\]]+)\]/i);
                  if (doorsMatch) {
                    suggestions = doorsMatch[1].split("|").map(s => s.trim().replace(/^[ABC]\s+/i, "").trim()).filter(Boolean);
                  }
                }
                finishStream(row, bubble, cursor, displayText, evt.source, evt.error, suggestions, evt.image_prompt, evt.webSuggestions, evt.actions, evt.routeLabel);
              }
            } catch { /* skip malformed */ }
          }
        }
        function read() {
          reader.read().then(({ done, value }) => {
            if (done) {
              // flush any remaining buffer (handles partial last line)
              if (buf.trim()) processLines([buf]);
              if (!streamFinished) {
                if (!hasTokens) bubble.textContent = "No response received.";
                // Stream closed without a done event — response likely truncated
                if (!hadDoneEvent && hasTokens) {
                  const retryBadge = document.createElement("div");
                  retryBadge.style.cssText = "margin-top:6px;font-size:11px;opacity:0.7;cursor:pointer;color:var(--accent)";
                  retryBadge.textContent = "⟳ Response truncated — tap to retry";
                  retryBadge.onclick = () => { inputEl.value = inputEl.dataset.lastMsg || ""; sendMessage(); };
                  bubble.appendChild(retryBadge);
                }
                finishStream(row, bubble, cursor, fullText, "done", undefined, undefined, undefined, undefined, undefined);
              }
              return;
            }
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop();
            processLines(lines);
            read();
          }).catch(() => { if (!streamFinished) finishStream(row, bubble, cursor, fullText, "error", undefined, undefined, undefined, undefined, undefined); });
        }
        read();
      })
      .catch((err) => {
        setThinking(false);
        bubble.textContent = "Failed to reach the server.";
        cursor.remove();
        finishStream(row, bubble, cursor, "", "error", undefined, undefined, undefined, undefined, undefined);
      });
  }

  // ── Rich media rendering (#649) ──────────────────────────────────────────
  // Post-process bubble text: YouTube iframes, image tags, clickable URLs.
  // Called once streaming is done so we never corrupt in-progress text nodes.
  function renderRichMedia(bubble, text) {
    if (!text) return;
    const YT_RE = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/g;
    const IMG_MD_RE = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
    const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

    // Collect YouTube video IDs from raw text before escaping
    const ytIds = [];
    let ytMatch;
    while ((ytMatch = YT_RE.exec(text)) !== null) ytIds.push(ytMatch[1]);

    // Track image URLs to skip them in URL linkification
    const imgUrls = new Set();
    let t = text.replace(IMG_MD_RE, (_, alt, url) => { imgUrls.add(url); return `\x00IMG\x00${url}\x00${alt}\x00`; });

    // Linkify bare URLs (skip image URLs)
    t = t.replace(URL_RE, (url) => imgUrls.has(url) ? url : `\x00LINK\x00${url}\x00`);

    // Build HTML from segments
    const parts = t.split('\x00');
    let html = '';
    let i = 0;
    while (i < parts.length) {
      const seg = parts[i];
      if (seg === 'IMG') {
        const url = parts[i + 1], alt = parts[i + 2];
        html += `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt || '')}" style="max-width:100%;border-radius:6px;margin-top:6px;" loading="lazy">`;
        i += 3;
      } else if (seg === 'LINK') {
        const url = parts[i + 1];
        html += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">${escapeHtml(url)}</a>`;
        i += 2;
      } else {
        html += escapeHtml(seg).replace(/\n/g, '<br>');
        i++;
      }
    }

    bubble.innerHTML = html;

    // Append YouTube iframes
    ytIds.forEach(vid => {
      const iframe = document.createElement('iframe');
      iframe.src = `https://www.youtube-nocookie.com/embed/${vid}`;
      iframe.width = '100%';
      iframe.height = '220';
      iframe.style.cssText = 'border:0;border-radius:6px;margin-top:8px;display:block;max-width:480px;';
      iframe.allow = 'encrypted-media; picture-in-picture';
      iframe.allowFullscreen = true;
      iframe.loading = 'lazy';
      bubble.appendChild(iframe);
    });
  }

  function finishStream(row, bubble, cursor, text, source, error, suggestions, imagePrompt, webSuggestions, actions, routeLabel) {
    cursor.remove();
    if (!text && !error) {
      bubble.textContent = bubble.textContent || "…";
    }
    if (text) conversationHistory.push({ role: "assistant", text });

    // Render rich media (YouTube embeds, clickable links, images)
    if (text) renderRichMedia(bubble, text);

    // Analytics
    const latency = analytics._msgStart ? Date.now() - analytics._msgStart : null;
    if (latency) analytics.latencies.push(latency);
    analytics.lastProvider = source || "—";
    const isFallback = source === "offline" || source === "local_fallback" || source === "unavailable";
    if (isFallback) analytics.fallbacks++;
    analytics.record(isFallback ? "fallback" : "done", `${source}${latency ? " @ " + latency + "ms" : ""}`);

    {
      const provNames = { anthropic: "Claude", openai: "ChatGPT", gemini: "Gemini", grok: "Grok", ollama: "Ollama" };
      const turn = conversationHistory.filter(m => m.role === "assistant").length;
      const latStr = latency ? `${(latency / 1000).toFixed(1)}s` : null;
      const isErr = source === "failed" || source === "unavailable" || source === "error" || !!error;
      // Route signature — who/what the user is talking to
      if (routeLabel) {
        const sig = document.createElement("div");
        sig.className = "msg-route-sig";
        sig.setAttribute("aria-label", `Active route: ${routeLabel}`);
        sig.textContent = routeLabel;
        row.appendChild(sig);
      }
      const footer = document.createElement("div");
      footer.className = `msg-footer${isErr ? " offline" : source ? ` ${source}` : ""}`;
      const parts = [];
      if (isErr) parts.push(error || source || "error");
      else if (source) parts.push(`❆ ${provNames[source] || source}`);
      if (latStr) parts.push(latStr);
      if (turn) parts.push(`turn ${turn}`);
      footer.textContent = parts.join(" · ");
      row.appendChild(footer);
    }

    // Render contextual suggestion chips from dream memory
    if (Array.isArray(suggestions) && suggestions.length > 0) {
      const chips = document.createElement("div");
      chips.className = "suggestions";
      suggestions.forEach(s => {
        const btn = document.createElement("button");
        btn.className = "suggestion";
        btn.textContent = s;
        btn.onclick = () => {
          if (isStreaming) return;
          fetch(`${serverBase}/api/dream/door-choice`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ choice: s, doors: suggestions }),
          }).catch(() => {});
          inputEl.value = s;
          inputEl.dispatchEvent(new Event("input"));
          sendMessage();
        };
        chips.appendChild(btn);
      });
      row.appendChild(chips);
    }

    // Render web suggestions (3 clickable links to explore topics)
    if (Array.isArray(webSuggestions) && webSuggestions.length > 0) {
      const webChips = document.createElement("div");
      webChips.className = "web-suggestions";
      webChips.style.marginTop = "8px";
      webChips.style.display = "flex";
      webChips.style.gap = "6px";
      webChips.style.flexWrap = "wrap";
      webSuggestions.forEach(ws => {
        const link = document.createElement("a");
        link.href = ws.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.className = "web-suggestion";
        link.style.fontSize = "0.85em";
        link.style.padding = "4px 10px";
        link.style.borderRadius = "4px";
        link.style.backgroundColor = "#e8f4f8";
        link.style.color = "#0066cc";
        link.style.textDecoration = "none";
        link.style.border = "1px solid #b3d9e6";
        link.style.cursor = "pointer";
        link.textContent = `${ws.icon} ${ws.label}`;
        link.onmouseover = () => {
          link.style.backgroundColor = "#d0eaf0";
          link.style.borderColor = "#7db5cc";
        };
        link.onmouseout = () => {
          link.style.backgroundColor = "#e8f4f8";
          link.style.borderColor = "#b3d9e6";
        };
        webChips.appendChild(link);
      });
      row.appendChild(webChips);
    }

    // ── Three Doors banner (disabled — appendDoorsBanner not yet implemented) ──
    // Show image prompt when AI suggests SD generation for doors
    if (imagePrompt) {
      const imgNote = document.createElement("div");
      imgNote.className = "source-badge";
      imgNote.style.marginTop = "8px";
      imgNote.style.fontStyle = "italic";
      imgNote.textContent = `🎨 ${imagePrompt}`;
      row.appendChild(imgNote);
    }
    // ❆ Log dream button — lets user save conversation as a dream entry
    if (text && source !== "failed" && source !== "error") {
      const logBtn = document.createElement("button");
      logBtn.className = "suggestion";
      logBtn.style.cssText = "margin-top:6px;border-color:var(--accent-dim);color:var(--accent);";
      logBtn.textContent = "❆ Log this as a dream";
      logBtn.onclick = async () => {
        logBtn.disabled = true;
        logBtn.textContent = "Saving…";
        const fullConv = conversationHistory.map(h => `${h.role === "user" ? "You" : "Lantern"}: ${h.text}`).join("\n");
        try {
          const r = await fetch(`${serverBase}/api/dream/create`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "dream", text: fullConv, tags: ["chat-log"], source: "dream-chat", ctf_glyphs: extractCtfGlyphs(fullConv) }),
          });
          const d = await r.json();
          logBtn.textContent = d.saved ? "✓ Saved to journal" : "Save failed";
        } catch { logBtn.textContent = "Save failed"; }
      };
      row.appendChild(logBtn);
    }

    // Keystone MCP: extract code blocks as executable commands
    if (directModeEnabled && text) {
      const codeBlocks = text.match(/```(?:bash|powershell|sh)?\n([\s\S]*?)```/g) || [];
      codeBlocks.forEach(block => {
        const cmd = block.replace(/```(?:bash|powershell|sh)?\n?/, "").replace(/```$/, "").trim();
        if (!cmd || cmd.includes("\n")) return; // only single-line commands
        const execBtn = document.createElement("button");
        execBtn.className = "suggestion";
        execBtn.style.cssText = "margin-top:4px;border-color:#4caf82;color:#4caf82;font-family:monospace;font-size:0.78rem;";
        execBtn.textContent = `▶ ${cmd.slice(0, 60)}`;
        execBtn.onclick = async () => {
          execBtn.disabled = true;
          execBtn.textContent = "Running…";
          try {
            const r = await fetch(`${serverBase}/api/keystone/exec`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ command: cmd }),
            });
            const d = await r.json();
            // Show output as a new message
            const outRow = document.createElement("div");
            outRow.className = "msg-row agent";
            const isErr = !d.ok;
            const label = isErr ? "KEYSTONE EXEC ✗" : "KEYSTONE EXEC ✓";
            const color = isErr ? "#e05555" : "#4caf82";
            const bg = isErr ? "#1a0a0a" : "#0a1a0e";
            const border = isErr ? "#3d1a1a" : "#1a3d2a";
            const body = d.output || d.error || d.message || "no output";
            outRow.innerHTML = `<div class="msg-label" style="color:${color}">${label}</div><div class="bubble" style="font-family:monospace;font-size:0.78rem;white-space:pre-wrap;background:${bg};border-color:${border};">${escapeHtml(body)}</div>`;
            messagesEl.appendChild(outRow);
            execBtn.textContent = d.ok ? `✓ ${cmd.slice(0, 40)}` : `✗ exit ${d.exit_code}`;
            scrollToBottom();
          } catch (e) { execBtn.textContent = `✗ ${e.message}`; }
        };
        row.appendChild(execBtn);
      });
    }

    // Convergence / self-edit action buttons
    if (Array.isArray(actions) && actions.length > 0) {
      const actionRow = document.createElement("div");
      actionRow.className = "suggestions";
      actionRow.style.marginTop = "8px";
      actions.forEach((a) => {
        const btn = document.createElement("button");
        btn.className = "suggestion";
        btn.style.cssText = "margin-top:4px;border-color:#e2c97e;color:#e2c97e;";
        btn.textContent = `⚡ ${a.label}`;
        btn.onclick = async () => {
          if (isStreaming) return;
          btn.disabled = true;
          btn.textContent = "Working…";
          try {
            if (a.action === "self-edit-apply") {
              // Direct apply from !self-edit action
              const diffText = a.diffText;
              const testsToRun = (a.plan && a.plan.testsToRun) ? a.plan.testsToRun : [];
              const ar = await fetch(`${serverBase}/api/self-edit/apply`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ diffText, testsToRun }),
              });
              const ad = await ar.json();
              const applyRow = document.createElement("div");
              applyRow.className = "msg-row agent";
              const applyText = ad.ok
                ? `Applied: ${ad.applied.changed.join(", ")}\nTests: ${ad.tests.map(t => `${t.ok ? "✓" : "✗"} ${t.cmd}`).join("\n")}\nDiff stat:\n${ad.diffStat}`
                : `Apply failed: ${ad.error}`;
              applyRow.innerHTML = `<div class="msg-label">Self-Edit · Apply</div><div class="bubble" style="font-family:monospace;font-size:0.78rem;white-space:pre-wrap;">${escapeHtml(applyText)}</div>`;
              messagesEl.appendChild(applyRow);
              if (ad.ok && ad.allTestsOk) {
                const prBtn = document.createElement("button");
                prBtn.className = "suggestion";
                prBtn.style.cssText = "margin-top:4px;border-color:#e2c97e;color:#e2c97e;";
                prBtn.textContent = "Open draft PR";
                prBtn.onclick = async () => {
                  prBtn.disabled = true;
                  prBtn.textContent = "Opening…";
                  try {
                    const plan = a.plan;
                    const prr = await fetch(`${serverBase}/api/self-edit/pr`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ title: plan.summary, body: plan.summary, branch: plan.branchHint, diffText: a.diffText }),
                    });
                    const prd = await prr.json();
                    const prRow = document.createElement("div");
                    prRow.className = "msg-row agent";
                    const prText = prd.ok ? `Branch: ${prd.branch}\nPR: ${prd.prUrl || "created"}` : `PR failed: ${prd.error}`;
                    prRow.innerHTML = `<div class="msg-label">Self-Edit · PR</div><div class="bubble" style="font-family:monospace;font-size:0.78rem;white-space:pre-wrap;">${escapeHtml(prText)}</div>`;
                    messagesEl.appendChild(prRow);
                    scrollToBottom();
                  } catch (e) { prBtn.textContent = `✗ ${e.message}`; }
                };
                messagesEl.lastChild.appendChild(prBtn);
              }
              scrollToBottom();
              btn.textContent = `✓ ${a.label}`;
            } else if (a.action === "self-edit-plan") {
              // Trigger a plan via self-edit endpoint
              const r = await fetch(`${serverBase}/api/self-edit/plan`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ request: a.hint || a.label, history: conversationHistory.slice(-6) }),
              });
              const d = await r.json();
              const planText = d.ok ? `Plan: ${d.plan.summary}\nFiles: ${d.plan.affectedFiles.join(", ")}\nRisk: ${d.plan.riskLevel}` : `Plan failed: ${d.error}`;
              const outRow = document.createElement("div");
              outRow.className = "msg-row agent";
              outRow.innerHTML = `<div class="msg-label">Self-Edit · Plan</div><div class="bubble" style="font-family:monospace;font-size:0.78rem;white-space:pre-wrap;">${escapeHtml(planText)}</div>`;
              messagesEl.appendChild(outRow);
              // If plan succeeded, offer patch generation
              if (d.ok) {
                const patchBtn = document.createElement("button");
                patchBtn.className = "suggestion";
                patchBtn.style.cssText = "margin-top:4px;border-color:#4caf82;color:#4caf82;";
                patchBtn.textContent = "Generate patch";
                patchBtn.onclick = async () => {
                  patchBtn.disabled = true;
                  patchBtn.textContent = "Generating…";
                  try {
                    const pr = await fetch(`${serverBase}/api/self-edit/patch`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ plan: d.plan }),
                    });
                    const pd = await pr.json();
                    const patchRow = document.createElement("div");
                    patchRow.className = "msg-row agent";
                    const patchText = pd.ok ? `Changed: ${pd.changedFiles.join(", ")}\n\n${pd.diffText.slice(0, 1200)}${pd.diffText.length > 1200 ? "\n…(truncated)" : ""}` : `Patch failed: ${pd.error}`;
                    patchRow.innerHTML = `<div class="msg-label">Self-Edit · Patch</div><div class="bubble" style="font-family:monospace;font-size:0.78rem;white-space:pre-wrap;">${escapeHtml(patchText)}</div>`;
                    messagesEl.appendChild(patchRow);
                    if (pd.ok) {
                      const applyBtn = document.createElement("button");
                      applyBtn.className = "suggestion";
                      applyBtn.style.cssText = "margin-top:4px;border-color:#4caf82;color:#4caf82;";
                      applyBtn.textContent = "Apply patch + run tests";
                      applyBtn.onclick = async () => {
                        applyBtn.disabled = true;
                        applyBtn.textContent = "Applying…";
                        try {
                          const ar = await fetch(`${serverBase}/api/self-edit/apply`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ diffText: pd.diffText, testsToRun: d.plan.testsToRun }),
                          });
                          const ad = await ar.json();
                          const applyRow = document.createElement("div");
                          applyRow.className = "msg-row agent";
                          const applyText = ad.ok
                            ? `Applied: ${ad.applied.changed.join(", ")}\nTests: ${ad.tests.map(t => `${t.ok ? "✓" : "✗"} ${t.cmd}`).join("\n")}\nDiff stat:\n${ad.diffStat}`
                            : `Apply failed: ${ad.error}`;
                          applyRow.innerHTML = `<div class="msg-label">Self-Edit · Apply</div><div class="bubble" style="font-family:monospace;font-size:0.78rem;white-space:pre-wrap;">${escapeHtml(applyText)}</div>`;
                          messagesEl.appendChild(applyRow);
                          if (ad.ok && ad.allTestsOk) {
                            const prBtn = document.createElement("button");
                            prBtn.className = "suggestion";
                            prBtn.style.cssText = "margin-top:4px;border-color:#e2c97e;color:#e2c97e;";
                            prBtn.textContent = "Open draft PR";
                            prBtn.onclick = async () => {
                              prBtn.disabled = true;
                              prBtn.textContent = "Opening…";
                              try {
                                const prr = await fetch(`${serverBase}/api/self-edit/pr`, {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ title: d.plan.summary, body: d.plan.summary, branch: d.plan.branchHint, diffText: pd.diffText }),
                                });
                                const prd = await prr.json();
                                const prRow = document.createElement("div");
                                prRow.className = "msg-row agent";
                                const prText = prd.ok ? `Branch: ${prd.branch}\nPR: ${prd.prUrl || "created"}` : `PR failed: ${prd.error}`;
                                prRow.innerHTML = `<div class="msg-label">Self-Edit · PR</div><div class="bubble" style="font-family:monospace;font-size:0.78rem;white-space:pre-wrap;">${escapeHtml(prText)}</div>`;
                                messagesEl.appendChild(prRow);
                                scrollToBottom();
                              } catch (e) { prBtn.textContent = `✗ ${e.message}`; }
                            };
                            messagesEl.lastChild.appendChild(prBtn);
                          }
                          scrollToBottom();
                        } catch (e) { applyBtn.textContent = `✗ ${e.message}`; }
                      };
                      messagesEl.lastChild.appendChild(applyBtn);
                    }
                    scrollToBottom();
                  } catch (e) { patchBtn.textContent = `✗ ${e.message}`; }
                };
                outRow.appendChild(patchBtn);
              }
              scrollToBottom();
              btn.textContent = `✓ ${a.label}`;
            } else if (a.action === "self-edit-pr") {
              // Open draft PR — supports both convergence-derived and direct self-edit actions
              const hasPlan = !!(a.plan && a.plan.summary);
              const title = hasPlan ? a.plan.summary : (a.hint || "Auto PR");
              const branch = hasPlan ? a.plan.branchHint : undefined;
              const diffText = a.diffText || "";
              const r = await fetch(`${serverBase}/api/self-edit/status`, { method: "GET" });
              const sd = await r.json();
              if (sd.isMaster && !branch) {
                const outRow = document.createElement("div");
                outRow.className = "msg-row agent";
                outRow.innerHTML = `<div class="msg-label">Self-Edit</div><div class="bubble">Cannot open PR from master. Create a feature branch first.</div>`;
                messagesEl.appendChild(outRow);
                scrollToBottom();
                btn.textContent = `✗ ${a.label}`;
                return;
              }
              const prr = await fetch(`${serverBase}/api/self-edit/pr`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title, body: a.hint || "", branch: branch || sd.branch, diffText }),
              });
              const prd = await prr.json();
              const prRow = document.createElement("div");
              prRow.className = "msg-row agent";
              const prText = prd.ok ? `Branch: ${prd.branch}\nPR: ${prd.prUrl || "created"}` : `PR failed: ${prd.error}`;
              prRow.innerHTML = `<div class="msg-label">Self-Edit · PR</div><div class="bubble" style="font-family:monospace;font-size:0.78rem;white-space:pre-wrap;">${escapeHtml(prText)}</div>`;
              messagesEl.appendChild(prRow);
              scrollToBottom();
              btn.textContent = `✓ ${a.label}`;
            }
          } catch (e) {
            btn.textContent = `✗ ${a.label}`;
          }
        };
        actionRow.appendChild(btn);
      });
      row.appendChild(actionRow);
    }

    isStreaming = false;
    sendBtn.disabled = false;
    setThinking(false);
    scrollToBottom();
    // TTS — flush remainder and wrap bubble for word highlighting
    if (text && source !== "failed" && source !== "error") streamTtsFinish(text, bubble);
  }

  function appendErrorNotice(row, msg) {
    const n = document.createElement("div");
    n.className = "error-notice";
    n.textContent = `Note: ${msg}`;
    row.appendChild(n);
  }

  function setThinking(thinking) {
    if (thinking) {
      statusDot.className = "dot thinking";
      statusLabel.textContent = "thinking…";
    } else {
      statusDot.className = "dot online";
      statusLabel.textContent = "online";
    }
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function fmtTime(d) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  // ── Settings drawer ─────────────────────────────────────────────────────
  const PROVIDERS = [
    { id: "claude",  envKey: "ANTHROPIC_API_KEY" },
    { id: "gemini",  envKey: "GEMINI_API_KEY" },
    { id: "openai",  envKey: "OPENAI_API_KEY" },
    { id: "grok",    envKey: "XAI_API_KEY" },
    { id: "elevenlabs", envKey: "ELEVENLABS_API_KEY" },
  ];

  function openSettings() {
    document.getElementById("settings-overlay").classList.add("open");
    document.getElementById("settings-drawer").classList.add("open");
    loadProviderStatus();
    loadVoiceSettings();
  }

  function closeSettings() {
    document.getElementById("settings-overlay").classList.remove("open");
    document.getElementById("settings-drawer").classList.remove("open");
  }

  async function loadProviderStatus() {
    try {
      const r = await fetch(`${serverBase}/api/settings/providers`, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return;
      const data = await r.json();
      let anyMissing = false;
      for (const { id, envKey } of PROVIDERS) {
        const configured = !!(data[envKey]);
        const statusEl = document.getElementById(`status-${id}`);
        const cardEl = document.getElementById(`card-${id}`);
        const inputEl2 = document.getElementById(`key-${id}`);
        if (statusEl) {
          statusEl.textContent = configured ? "connected" : "not set";
          statusEl.className = `provider-status ${configured ? "ok" : "missing"}`;
        }
        if (cardEl) cardEl.classList.toggle("connected", configured);
        if (inputEl2 && configured) inputEl2.placeholder = "••••••••  (set — enter new key to replace)";
        if (!configured) anyMissing = true;
        // Sync connector-section badge (#conn-status-{id}) to match — single source of truth
        const connBadge = document.getElementById(`conn-status-${id}`);
        if (connBadge) {
          connBadge.textContent = configured ? "Connected" : "No key";
          connBadge.className = `connector-card-status ${configured ? "ok" : "err"}`;
        }
      }
      document.getElementById("settings-btn").classList.toggle("has-error", anyMissing && data._any === false);
      // Discord Bot status
      const discordToken = !!(data["DISCORD_BOT_TOKEN"]);
      const discordGuild = !!(data["LANTERN_DISCORD_GUILD_ID"]);
      const discordStatusEl = document.getElementById("status-discord-token");
      const discordCardEl = document.getElementById("card-discord");
      if (discordStatusEl) {
        discordStatusEl.textContent = (discordToken && discordGuild) ? "ready" : (discordToken ? "token only" : "not set");
        discordStatusEl.className = `provider-status ${(discordToken && discordGuild) ? "ok" : "missing"}`;
      }
      if (discordCardEl) discordCardEl.classList.toggle("connected", discordToken && discordGuild);
    } catch { /* non-critical */ }
  }

  async function saveKey(providerId, envKey, inputId) {
    const val = document.getElementById(inputId).value.trim();
    if (!val) return;
    const fb = document.getElementById(`fb-${providerId}`);
    try {
      const r = await fetch(`${serverBase}/api/settings/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: envKey, value: val }),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        fb.textContent = "✓ saved"; fb.className = "save-feedback ok";
        document.getElementById(inputId).value = "";
        setTimeout(() => { fb.textContent = ""; fb.className = "save-feedback"; }, 2500);
        loadProviderStatus();
      } else {
        fb.textContent = data.error || "error"; fb.className = "save-feedback err";
      }
    } catch (e) {
      fb.textContent = e.message; fb.className = "save-feedback err";
    }
  }

  async function clearKey(providerId, envKey) {
    const fb = document.getElementById(`fb-${providerId}`);
    try {
      const r = await fetch(`${serverBase}/api/settings/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: envKey, value: "" }),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        fb.textContent = "removed"; fb.className = "save-feedback ok";
        setTimeout(() => { fb.textContent = ""; fb.className = "save-feedback"; }, 2000);
        loadProviderStatus();
      }
    } catch (e) {
      fb.textContent = e.message; fb.className = "save-feedback err";
    }
  }

  // Load status badge on open if a provider was missing last time
  loadProviderStatus();

  // ════════════════════════════════════════════════════════════════
  //  Log Dream — structured capture drawer
  // ════════════════════════════════════════════════════════════════
  const logDreamTags = { emotions: [], tags: [], symbols: [] };

  function openLogDream() {
    document.getElementById("logdream-overlay").classList.add("open");
    document.getElementById("logdream-drawer").classList.add("open");
  }

  function closeLogDream() {
    document.getElementById("logdream-overlay").classList.remove("open");
    document.getElementById("logdream-drawer").classList.remove("open");
  }

  function addTagChip(category, value) {
    const v = value.trim().toLowerCase();
    if (!v || logDreamTags[category].includes(v)) return;
    logDreamTags[category].push(v);
    renderTagChips(category);
  }

  function removeTagChip(category, value) {
    logDreamTags[category] = logDreamTags[category].filter(x => x !== value);
    renderTagChips(category);
  }

  function renderTagChips(category) {
    const container = document.getElementById(`chips-${category}`);
    container.innerHTML = logDreamTags[category].map(v =>
      `<span class="tag-chip active" data-category="${escapeHtml(category)}" data-value="${escapeHtml(v)}">${escapeHtml(v)} ×</span>`
    ).join("");
    // Event delegation for tag removal (XSS fix: use data attributes instead of inline onclick)
    container.addEventListener('click', (e) => {
      if (e.target.classList.contains('tag-chip')) {
        const cat = e.target.dataset.category;
        const val = e.target.dataset.value;
        removeTagChip(cat, val);
      }
    });
  }

  function clearLogDream() {
    document.getElementById("ld-title").value = "";
    document.getElementById("ld-text").value = "";
    document.getElementById("ld-kind").value = "dream";
    document.getElementById("ld-mood").value = "";
    document.getElementById("ld-lucidity").value = 0;
    document.getElementById("ld-lucidity-val").textContent = "0%";
    document.getElementById("ld-clarity").value = 50;
    document.getElementById("ld-clarity-val").textContent = "50%";
    document.getElementById("ld-technique").value = "";
    document.getElementById("ld-window").value = "";
    document.getElementById("ld-dreamsign").checked = false;
    document.getElementById("ld-recurring").checked = false;
    logDreamTags.emotions = []; logDreamTags.tags = []; logDreamTags.symbols = [];
    renderTagChips("emotions"); renderTagChips("tags"); renderTagChips("symbols");
    document.getElementById("ld-feedback").textContent = "";
  }

  async function saveLogDream() {
    const text = document.getElementById("ld-text").value.trim();
    if (!text) {
      document.getElementById("ld-feedback").textContent = "Please enter a dream story.";
      document.getElementById("ld-feedback").style.color = "var(--danger)";
      return;
    }
    const payload = {
      kind: document.getElementById("ld-kind").value,
      name: document.getElementById("ld-title").value.trim(),
      text,
      lucidity: Number(document.getElementById("ld-lucidity").value) / 100,
      clarity: Number(document.getElementById("ld-clarity").value) / 100,
      mood: document.getElementById("ld-mood").value.trim(),
      technique: document.getElementById("ld-technique").value.trim(),
      sleep_window: document.getElementById("ld-window").value.trim(),
      dreamsign: document.getElementById("ld-dreamsign").checked,
      recurring: document.getElementById("ld-recurring").checked,
      emotions: logDreamTags.emotions,
      tags: logDreamTags.tags,
      symbols: logDreamTags.symbols,
      source: "dream-chat-ui",
    };
    const fb = document.getElementById("ld-feedback");
    try {
      const r = await fetch(`${serverBase}/api/dream/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (r.ok && d.saved) {
        fb.textContent = "✓ Saved to journal";
        fb.style.color = "var(--green)";
        setTimeout(() => { clearLogDream(); closeLogDream(); }, 900);
      } else {
        fb.textContent = d.error || "Save failed";
        fb.style.color = "var(--danger)";
      }
    } catch (e) {
      fb.textContent = "Network error: " + e.message;
      fb.style.color = "var(--danger)";
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  CTF — Convergence Text Format symbol dictionary
  // ════════════════════════════════════════════════════════════════
  const CTF = {
    "see":"👁","sight":"👁","vision":"🔭","hear":"👂","sound":"🎵","music":"🎵",
    "taste":"👅","smell":"🌸","touch":"🤲","feel":"💫","sense":"🌐",
    "fly":"🕊","flying":"🕊","float":"☁","fall":"⬇","run":"⚡","walk":"🚶",
    "door":"🚪","gate":"⛩","path":"🛤","bridge":"🌉","tunnel":"🕳",
    "light":"✨","glow":"🌟","fire":"🔥","flame":"🔥","water":"🌊","fog":"🌫",
    "earth":"🌍","air":"💨","void":"◻","dark":"🌑","shadow":"🌒",
    "lantern":"🏮","key":"🗝","mirror":"🪤","clock":"⏰","star":"⭐","moon":"🌙",
    "sun":"☀","eye":"👁","hand":"🤲","heart":"💜","anchor":"⚓","compass":"🧭",
    "tree":"🌲","forest":"🌿","flower":"🌸","crystal":"💎","stone":"🪨","seed":"🌱",
    "dream":"🌙","memory":"💭","thought":"💭","idea":"💡","pattern":"🌀","mesh":"⬡",
    "convergence":"◈","signal":"📡","noise":"〰","loop":"🔄","flow":"〜","layer":"⧖",
    "symbol":"❆","glyph":"⌖","code":"⌥","cipher":"⊛","rune":"ᚱ","sigil":"⛤",
    "peace":"🕊","wonder":"✨","fear":"⚡","joy":"☀","love":"💜","loss":"🌑","hope":"🌅",
    "curious":"🔭","aware":"👁","alive":"🌱","free":"🕊","safe":"⚓","home":"🏮",
    "past":"◀","future":"▶","now":"◎","moment":"⊙","night":"🌙","dawn":"🌅","cycle":"🔄",
    "city":"🏙","ocean":"🌊","sky":"🌌","cave":"🕳","mountain":"⛰","desert":"🏕",
    "color":"🎨","red":"🔴","blue":"🔵","green":"🟢","purple":"🟣","gold":"❆","white":"◯","black":"●",
    "voice":"🎤","speak":"🗣","listen":"👂","silence":"◻","word":"📝","story":"📖",
    "open":"◉","close":"●","enter":"→","exit":"←","return":"↩","begin":"▶","end":"■",
  };

  const CTF_WORDS = Object.keys(CTF).sort((a,b) => b.length - a.length);


  function extractCtfGlyphs(text) {
    const glyphs = new Set();
    const ctfValues = Object.values(CTF);
    for (const sym of ctfValues) {
      if (text.includes(sym)) glyphs.add(sym);
    }
    return Array.from(glyphs);
  }
  function ctfLookup(word) {
    const lower = word.toLowerCase().trim();
    if (CTF[lower]) return [{ word: lower, sym: CTF[lower] }];
    return CTF_WORDS.filter(k => k.startsWith(lower) && k.length > lower.length)
      .slice(0, 8).map(k => ({ word: k, sym: CTF[k] }));
  }

  const ctfPopup = document.getElementById("ctf-popup");
  let ctfPaletteOpen = false;

  function buildCtfPalette() {
    if (!ctfPopup) return;
    ctfPopup.innerHTML = "";
    for (const [word, sym] of Object.entries(CTF)) {
      const btn = document.createElement("button");
      btn.className = "ctf-sym";
      btn.textContent = sym;
      btn.title = word;
      btn.onclick = () => {
        const pos = inputEl.selectionStart;
        const v = inputEl.value;
        inputEl.value = v.slice(0, pos) + sym + v.slice(pos);
        inputEl.selectionStart = inputEl.selectionEnd = pos + sym.length;
        inputEl.focus();
        inputEl.dispatchEvent(new Event("input"));
      };
      ctfPopup.appendChild(btn);
    }
  }

  function toggleCtfPalette() {
    if (!ctfPopup) return;
    ctfPaletteOpen = !ctfPaletteOpen;
    ctfPopup.classList.toggle("hidden", !ctfPaletteOpen);
    if (ctfPaletteOpen && !ctfPopup.children.length) buildCtfPalette();
    const ctfBtn = document.getElementById("ctf-btn");
    if (ctfBtn) ctfBtn.style.color = ctfPaletteOpen ? "var(--accent)" : "";
  }

  // Auto-suggest CTF as you type
  if (ctfPopup) {
    inputEl.addEventListener("input", () => {
      const words = inputEl.value.split(/\s+/);
      const last = words[words.length - 1];
      if (last.length >= 3 && !ctfPaletteOpen) {
        const matches = ctfLookup(last);
        if (matches.length > 0) {
          ctfPopup.classList.remove("hidden");
          ctfPopup.innerHTML = "";
          matches.forEach(({ word, sym }) => {
            const btn = document.createElement("button");
            btn.className = "ctf-sym";
            btn.textContent = `${sym} ${word}`;
            btn.onclick = () => {
              const ws = inputEl.value.split(/\s+/);
              ws[ws.length - 1] = sym;
              inputEl.value = ws.join(" ") + " ";
              inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
              ctfPopup.classList.add("hidden");
              inputEl.focus();
            };
            ctfPopup.appendChild(btn);
          });
          return;
        }
      }
      if (!ctfPaletteOpen) ctfPopup.classList.add("hidden");
    });

    document.addEventListener("click", (e) => {
      if (!ctfPopup.contains(e.target) && e.target.id !== "ctf-btn" && e.target !== inputEl) {
        if (!ctfPaletteOpen) ctfPopup.classList.add("hidden");
      }
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  Voice — STT (Web Speech API) + TTS
  // ════════════════════════════════════════════════════════════════
  const voiceBtn = document.getElementById("voice-btn");
  let recognition = null;
  let isListening = false;

  function initVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { voiceBtn.title = "Voice not supported (use Chrome)"; voiceBtn.style.opacity = "0.4"; return; }
    recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    let accumulated = "";
    recognition.onresult = (e) => {
      let interim = "", final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      if (final) {
        accumulated += (accumulated ? " " : "") + final.trim();
        inputEl.value = accumulated;
        inputEl.dispatchEvent(new Event("input"));
      } else if (interim) {
        inputEl.placeholder = "🎤 " + interim;
      }
    };
    recognition.onend = () => {
      isListening = false;
      voiceBtn.classList.remove("listening");
      inputEl.placeholder = "Tell me a dream…";
      const toSend = accumulated.trim();
      accumulated = "";
      if (toSend) { inputEl.value = toSend; sendMessage(); }
    };
    recognition.onerror = () => {
      isListening = false; voiceBtn.classList.remove("listening");
      inputEl.placeholder = "Tell me a dream…";
    };
  }

  function toggleVoice() {
    if (!recognition) initVoice();
    if (!recognition) return;
    if (isListening) {
      recognition.stop();
    } else {
      isListening = true;
      voiceBtn.classList.add("listening");
      inputEl.placeholder = "🎤 Listening…";
      try { recognition.start(); } catch(e) { isListening = false; voiceBtn.classList.remove("listening"); inputEl.placeholder = "Tell me a dream…"; }
    }
  }

  let ttsAudio = null;

  // --- Streaming TTS state ---
  let streamTtsBuf = "";
  let streamTtsQueue = [];
  let streamTtsBusy = false;
  let ttsWordBubble = null;
  let streamTtsSentenceOffset = 0; // cumulative char offset into bubble text as sentences complete
  const SENT_RE = /[^.!?…\n]+(?:[.!?…]+\s*|\n{2,})/g;

  function streamTtsReset() {
    streamTtsBuf = "";
    streamTtsQueue = [];
    streamTtsBusy = false;
    ttsWordBubble = null;
    streamTtsSentenceOffset = 0;
    clearTtsHighlight();
  }

  function streamTtsFlush(force) {
    if (!window.speechSynthesis) return;
    const matches = streamTtsBuf.match(SENT_RE);
    if (!matches) return;
    const last = matches[matches.length - 1];
    const consumed = streamTtsBuf.lastIndexOf(last) + last.length;
    const sentences = force
      ? matches.concat(streamTtsBuf.slice(consumed).trim() ? [streamTtsBuf.slice(consumed).trim()] : [])
      : matches;
    streamTtsBuf = force ? "" : streamTtsBuf.slice(consumed);
    for (const s of sentences) {
      const t = s.trim().replace(/\[DOORS:[^\]]*\]?/gi, "").trim();
      if (t) streamTtsQueue.push(t);
    }
    streamTtsDrain();
  }

  function streamTtsDrain() {
    if (streamTtsBusy || streamTtsQueue.length === 0) return;
    const prefs = JSON.parse(localStorage.getItem("lantern_tts_prefs") || "{}");
    const text = streamTtsQueue.shift();
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = prefs.rate ?? 0.88;
    utt.pitch = prefs.pitch ?? 1.05;
    const voices = window.speechSynthesis.getVoices();
    if (prefs.voiceURI) {
      const pick = voices.find(v => v.voiceURI === prefs.voiceURI);
      if (pick) utt.voice = pick;
    } else {
      const fallback = voices.find(v => /samantha|karen|moira|fiona|victoria|female/i.test(v.name))
                  || voices.find(v => v.lang === "en-GB" || v.lang === "en-AU");
      if (fallback) utt.voice = fallback;
    }
    utt.onboundary = (e) => {
      if (e.name === "word" && ttsWordBubble) highlightTtsWord(streamTtsSentenceOffset + e.charIndex);
    };
    utt.onend = () => {
      streamTtsBusy = false;
      streamTtsSentenceOffset += text.length + 1;
      clearTtsHighlight();
      streamTtsDrain();
    };
    utt.onerror = () => { streamTtsBusy = false; streamTtsDrain(); };
    streamTtsBusy = true;
    window.speechSynthesis.speak(utt);
  }

  function wrapBubbleWords(bubble) {
    const text = bubble.textContent;
    bubble.textContent = "";
    for (const part of text.split(/(\s+)/)) {
      if (!part) continue;
      if (/\S/.test(part)) {
        const span = document.createElement("span");
        span.className = "tts-word";
        span.textContent = part;
        bubble.appendChild(span);
      } else {
        bubble.appendChild(document.createTextNode(part));
      }
    }
    ttsWordBubble = bubble;
  }

  function highlightTtsWord(charIndex) {
    if (!ttsWordBubble) return;
    const spans = ttsWordBubble.querySelectorAll(".tts-word");
    let pos = 0;
    for (const span of spans) {
      const len = span.textContent.length + 1; // +1 for space
      if (charIndex >= pos && charIndex < pos + len) {
        span.classList.add("tts-active");
      } else {
        span.classList.remove("tts-active");
      }
      pos += len;
    }
  }

  function clearTtsHighlight() {
    if (!ttsWordBubble) return;
    ttsWordBubble.querySelectorAll(".tts-active").forEach(s => s.classList.remove("tts-active"));
  }

  function streamTtsFinish(text, bubble) {
    if (!text || !window.speechSynthesis) return;
    // Flush any leftover buffer
    streamTtsFlush(true);
    // Wrap bubble words for highlighting of queued/remaining utterances
    if (bubble && !ttsWordBubble) wrapBubbleWords(bubble);
    streamTtsDrain();
  }

  function stopSpeaking() {
    if (ttsAudio) { ttsAudio.pause(); ttsAudio = null; }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    streamTtsReset();
  }

  async function speakText(text) {
    stopSpeaking();
    const clean = text.replace(/[❆◈⬡⛤⌖⊛ᚱ]/g, "").replace(/[^\x00-\x7F]/g, (c) => {
      return c.codePointAt(0) > 0x2FFF ? " " : c;
    }).trim();
    if (!clean) return;

    const prefs = JSON.parse(localStorage.getItem("lantern_tts_prefs") || "{}");
    const voiceId = prefs.ttsVoice || "";

    try {
      const r = await fetch(`${serverBase}/api/dream/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean, voice_id: voiceId }),
      });
      const ct = r.headers.get("content-type") || "";
      if (r.ok && ct.includes("audio")) {
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        ttsAudio = new Audio(url);
        ttsAudio.play();
        ttsAudio.onended = () => { URL.revokeObjectURL(url); ttsAudio = null; };
        return;
      }
      const d = await r.json().catch(() => ({}));
      if (d.fallback === "browser") {
        // fall through to browser TTS below
      } else if (d.error) {
        console.warn("TTS server error:", d.error);
      }
    } catch (e) {
      console.warn("TTS network error:", e.message);
    }

    // Browser fallback
    if (!window.speechSynthesis) return;
    const utt = new SpeechSynthesisUtterance(clean);
    utt.rate = prefs.rate ?? 0.88;
    utt.pitch = prefs.pitch ?? 1.05;
    const voices = window.speechSynthesis.getVoices();
    if (prefs.voiceURI) {
      const pick = voices.find(v => v.voiceURI === prefs.voiceURI);
      if (pick) utt.voice = pick;
    } else {
      const fallback = voices.find(v => /samantha|karen|moira|fiona|victoria|female/i.test(v.name))
                  || voices.find(v => v.lang === "en-GB" || v.lang === "en-AU");
      if (fallback) utt.voice = fallback;
    }
    window.speechSynthesis.speak(utt);
  }

  function populateVoiceList() {
    const select = document.getElementById("voice-select");
    if (!select || !window.speechSynthesis) return;
    const voices = window.speechSynthesis.getVoices();
    const current = select.value;
    // Remove all but the default option
    while (select.options.length > 1) select.remove(1);
    voices.forEach(v => {
      const opt = document.createElement("option");
      opt.value = v.voiceURI;
      opt.textContent = `${v.name} (${v.lang})`;
      select.appendChild(opt);
    });
    select.value = current;
  }

  function saveVoiceSettings() {
    const prefs = {
      voiceURI: document.getElementById("voice-select").value || null,
      rate: parseFloat(document.getElementById("voice-rate").value),
      pitch: parseFloat(document.getElementById("voice-pitch").value),
      ttsVoice: document.getElementById("voice-tts-id")?.value?.trim() || null,
    };
    localStorage.setItem("lantern_tts_prefs", JSON.stringify(prefs));
    const fb = document.getElementById("fb-voice");
    fb.textContent = "✓ saved"; fb.className = "save-feedback ok";
    setTimeout(() => { fb.textContent = ""; fb.className = "save-feedback"; }, 1500);
  }

  function loadVoiceSettings() {
    if (!window.speechSynthesis) return;
    populateVoiceList();
    const prefs = JSON.parse(localStorage.getItem("lantern_tts_prefs") || "{}");
    const select = document.getElementById("voice-select");
    const rateEl = document.getElementById("voice-rate");
    const pitchEl = document.getElementById("voice-pitch");
    if (prefs.voiceURI && select) select.value = prefs.voiceURI;
    if (prefs.rate && rateEl) { rateEl.value = prefs.rate; document.getElementById("voice-rate-val").textContent = prefs.rate; }
    if (prefs.pitch && pitchEl) { pitchEl.value = prefs.pitch; document.getElementById("voice-pitch-val").textContent = prefs.pitch; }
    if (prefs.ttsVoice) {
      const voiceInput = document.getElementById("voice-tts-id");
      if (voiceInput) voiceInput.value = prefs.ttsVoice;
    }
  }

  function testVoice() {
    const sample = "The dream door is open. Choose an agent and say something.";
    speakText(sample);
  }

  if (window.speechSynthesis) {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener?.("voiceschanged", () => {
      window.speechSynthesis.getVoices();
      populateVoiceList();
    });
  }

  initVoice();
  loadVoiceSettings();

  // ── Kingdome of Hearts Game Integration ────────────────────────────────
  let doorsGameState = null;
  let doorsUserId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  async function startThreeDoors() {
    console.log("[Kingdome] Starting game...");
    const row = document.createElement("div");
    row.className = "msg-row agent";
    row.innerHTML = `<div class="msg-label">🚪 Kingdome of Hearts</div><div class="bubble"><b>Opening the first door...</b></div>`;
    messagesEl.appendChild(row);
    scrollToBottom();

    try {
      const r = await fetch(`${serverBase}/api/dream/doors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: doorsUserId, action: "start" }),
      });

      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();

      if (data.error) {
        row.querySelector(".bubble").textContent = `⚠️ Error: ${data.error}`;
        return;
      }

      doorsGameState = data;
      renderDoorsScene(row, data);
    } catch (error) {
      console.error("[Kingdome] Error:", error);
      row.querySelector(".bubble").textContent = `❌ Failed to start game: ${error.message}`;
    }
  }

  function renderDoorsScene(row, scene) {
    const bubble = row.querySelector(".bubble");
    const html = `
      <div style="margin: 8px 0;">
        <div style="margin-bottom: 12px; line-height: 1.6; color: #e2e8f0;">${scene.text}</div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px;">
          ${(scene.doors || [])
            .map((door) => `
            <button onclick="window.chooseDoorsPath('${door.label}')"
              style="padding: 8px 12px; background: #4c1d95; border: 1px solid #7c3aed; color: #c4b5fd; border-radius: 6px; cursor: pointer; font-size: 13px; transition: all 0.2s; font-weight: 500;"
              onmouseover="this.style.background='#6d28d9'; this.style.borderColor='#a78bfa';"
              onmouseout="this.style.background='#4c1d95'; this.style.borderColor='#7c3aed';">
              ${door.label}. ${door.name}
            </button>
          `)
            .join("")}
        </div>
        ${scene.image_prompt ? `
          <div style="background: #1e1b4b; border-left: 3px solid #7c3aed; padding: 8px; border-radius: 4px; margin-top: 12px; font-size: 11px; color: #a78bfa; max-height: 80px; overflow-y: auto;">
            <div style="font-weight: 600; margin-bottom: 4px;">📸 Stable Diffusion Prompt:</div>
            <div style="font-family: monospace; line-height: 1.4; color: #c4b5fd;">${scene.image_prompt}</div>
          </div>
        ` : ""}
        ${scene.fox_present ? `<div style="color: #fbbf24; font-size: 12px; margin-top: 8px; font-style: italic;">🦊 The fox is here.</div>` : ""}
      </div>
    `;
    bubble.innerHTML = html;
  }

  window.chooseDoorsPath = async (doorLabel) => {
    if (!doorsGameState) return;

    const row = document.createElement("div");
    row.className = "msg-row agent";
    row.innerHTML = `<div class="msg-label">🚪 Choosing door ${doorLabel}...</div><div class="bubble"><em>traversing...</em></div>`;
    messagesEl.appendChild(row);
    scrollToBottom();

    try {
      const r = await fetch(`${serverBase}/api/dream/doors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: doorsUserId, action: "choose", choice: doorLabel }),
      });

      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();

      if (data.error) {
        row.querySelector(".bubble").textContent = `⚠️ ${data.error}`;
        return;
      }

      doorsGameState = data;
      renderDoorsScene(row, data);
    } catch (error) {
      console.error("[Kingdome] Choice error:", error);
      row.querySelector(".bubble").textContent = `❌ Failed: ${error.message}`;
    }
  };

  window.startThreeDoors = startThreeDoors;

