  const messagesEl = document.getElementById("messages");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send-btn");
  const statusDot = document.getElementById("status-dot");
  const statusLabel = document.getElementById("status-label");
  const emptyState = document.getElementById("empty-state");
  const agentSelect = document.getElementById("agent-select");
  const providerSelect = document.getElementById("provider-select");
  const mcpToggle = document.getElementById("mcp-toggle");
  let keystoneMcpEnabled = false;
  let originalAgents = [];

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
      document.getElementById("dbg-session").textContent = `${mins}:${secs}`;
      document.getElementById("dbg-messages").textContent = this.messagesSent;
      document.getElementById("dbg-tokens").textContent = this.tokensReceived;
      const errEl = document.getElementById("dbg-errors");
      errEl.textContent = this.errors;
      errEl.className = "debug-val " + (this.errors > 0 ? "err" : "ok");
      const fbEl = document.getElementById("dbg-fallbacks");
      fbEl.textContent = this.fallbacks;
      fbEl.className = "debug-val " + (this.fallbacks > 0 ? "warn" : "ok");
      const avg = this.latencies.length > 0
        ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length) + " ms"
        : "—";
      document.getElementById("dbg-latency").textContent = avg;
      document.getElementById("dbg-provider").textContent = this.lastProvider || "—";
      document.getElementById("dbg-agent").textContent = this.lastAgent || "—";
    },
  };
  setInterval(() => analytics.render(), 1000);
  function toggleDebug() {
    document.getElementById("debug-panel").classList.toggle("open");
  }

  function toggleKeystoneMcp() {
    keystoneMcpEnabled = !keystoneMcpEnabled;
    mcpToggle.classList.toggle("active", keystoneMcpEnabled);
    document.querySelector(".app").classList.toggle("mcp-mode", keystoneMcpEnabled);
    document.querySelector(".input-area").classList.toggle("mcp-mode", keystoneMcpEnabled);
    if (keystoneMcpEnabled) {
      lockAgentToKeystone();
    } else {
      restoreAgentSelector();
    }
  }

  function lockAgentToKeystone() {
    if (!originalAgents.length) return;
    const keystone = originalAgents.find(a => a.id === "keystone");
    if (keystone) {
      agentSelect.innerHTML = `<option value="${keystone.id}">${keystone.name}</option>`;
      agentSelect.value = keystone.id;
    }
  }

  function restoreAgentSelector() {
    if (!originalAgents.length) return;
    agentSelect.innerHTML = originalAgents.map((a) => `<option value="${a.id}">${a.name}</option>`).join("");
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
        agentSelect.innerHTML = agents.map((a) => `<option value="${a.id}">${a.name}</option>`).join("");
        if (data.default) agentSelect.value = data.default;
        if (keystoneMcpEnabled) lockAgentToKeystone();
        statusDot.className = "dot online";
        statusLabel.textContent = "online";
        TELEMETRY.log("agents", `Loaded ${agents.length} agents`);
        return;
      }
      TELEMETRY.warn("agents", `Non-OK response loading agents: ${r.status}`);
    } catch (err) {
      TELEMETRY.error("agents", `Failed to load agents: ${err.message}`, { serverBase });
    }
    statusDot.className = "dot";
    statusLabel.textContent = "offline";
  }
  loadAgents();

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
    // !convergence runs the Lantern convergence loop + version check + auto-update
    if (text === "!convergence") {
      inputEl.value = "";
      triggerAutoupdate("Auto-update");
      const sysRow = document.createElement("div");
      sysRow.className = "msg-row agent";
      sysRow.innerHTML = `<div class="msg-label">System</div><div class="bubble">Running convergence loop…</div>`;
      messagesEl.appendChild(sysRow);
      scrollToBottom();

      const runLoop = fetch(`${serverBase}/api/actions/run-loop`, { method: "POST" });
      const fetchVersion = fetch(`${serverBase}/api/version`).then(r => r.ok ? r.json() : null).catch(() => null);

      Promise.all([runLoop, fetchVersion])
        .then(async ([loopR, versionD]) => {
          const d = await loopR.json();
          const rawOut = d.stdout || "";
          const rawErr = d.stderr || "";
          const tag = versionD?.version?.semver || versionD?.version?.tag || "unknown";
          const commit = versionD?.version?.commit ? versionD.version.commit.slice(0, 7) : "?";

          // Extract JSON from stdout (convergence loop prints it at the end)
          let promo = "";
          try {
            const jsonMatch = rawOut.match(/\{[\s\S]*"promotion_ready"[\s\S]*\}/);
            if (jsonMatch) {
              const loopJson = JSON.parse(jsonMatch[0]);
              promo = loopJson.promotion_ready ? "✓ promotion_ready" : "✗ not ready";
            }
          } catch {}

          const out = rawOut.slice(0, 700);
          const err = rawErr.slice(0, 300);

          sysRow.querySelector(".bubble").innerHTML =
            `<b>Convergence loop</b> ${loopR.ok ? "✓" : "✗"} <code>${tag}</code> <code>${commit}</code> ${promo}<pre style="margin-top:6px;white-space:pre-wrap;font-size:12px;opacity:0.85;">${escapeHtml(out)}${err ? "\n---stderr---\n" + escapeHtml(err) : ""}</pre>`;
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
    // Allow backend-streaming bang commands through; reject truly unknown ones
    const STREAMING_BANGS = ["swarm", "converge"];
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
    inputEl.value = "";
    analytics.messagesSent++;
    analytics.lastAgent = agents.find((a) => a.id === agentSelect.value)?.name || agentSelect.value;
    analytics.record("send", text.slice(0, 40));
    analytics._msgStart = Date.now();
    streamAgentResponse(text);
  }

  function appendUserBubble(text) {
    conversationHistory.push({ role: "user", text });
    const row = document.createElement("div");
    row.className = "msg-row user";
    row.innerHTML = `<div class="msg-label">You</div><div class="bubble">${escapeHtml(text)}</div>`;
    messagesEl.appendChild(row);
    scrollToBottom();
  }

  // ── Stream agent response ───────────────────────────────────────────────────
  function streamAgentResponse(message) {
    isStreaming = true;
    sendBtn.disabled = true;
    setThinking(true);

    const agentName = agents.find((a) => a.id === agentSelect.value)?.name || "Agent";
    const row = document.createElement("div");
    row.className = "msg-row agent";

    const label = document.createElement("div");
    label.className = "msg-label";
    label.textContent = agentName;

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
    const agent = agentSelect.value;
    // POST with history for multi-turn context; history excludes current message (already appended)
    const historyToSend = conversationHistory.slice(0, -1).slice(-6); // last 6 turns before this message

    fetch(`${serverBase}/api/dream/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, provider: provider || undefined, agent: agent || undefined, history: historyToSend, mcp: keystoneMcpEnabled }),
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
        function processLines(lines) {
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw) continue;
            try {
              const evt = JSON.parse(raw);
              if (evt.type === "token" && evt.text) {
                if (!hasTokens) { hasTokens = true; setThinking(false); }
                fullText += evt.text;
                analytics.tokensReceived++;
                cursor.remove();
                // Hide [DOORS:...] tag from the user during streaming
                const visibleText = fullText.replace(/\[DOORS:[^\]]*\]?/i, "").replace(/\n{3,}/g, "\n\n").trimEnd();
                bubble.textContent = visibleText;
                bubble.appendChild(cursor);
                scrollToBottom();
              }
              if (evt.type === "error" && evt.text) {
                analytics.errors++;
                analytics.record("error", evt.text);
                appendErrorNotice(row, evt.text);
              }
              if (evt.type === "done" && !streamFinished) {
                streamFinished = true;
                const displayText = evt.cleanText || fullText;
                if (evt.cleanText && evt.cleanText !== fullText) {
                  bubble.textContent = evt.cleanText;
                }
                finishStream(row, bubble, cursor, displayText, evt.source, evt.error, evt.suggestions, evt.image_prompt);
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
                finishStream(row, bubble, cursor, fullText, "done", undefined, undefined);
              }
              return;
            }
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop();
            processLines(lines);
            read();
          }).catch(() => { if (!streamFinished) finishStream(row, bubble, cursor, fullText, "error"); });
        }
        read();
      })
      .catch((err) => {
        setThinking(false);
        bubble.textContent = "Failed to reach the server.";
        cursor.remove();
        finishStream(row, bubble, cursor, "", "error");
      });
  }

  function finishStream(row, bubble, cursor, text, source, error, suggestions, imagePrompt) {
    cursor.remove();
    if (!text && !error) {
      bubble.textContent = bubble.textContent || "…";
    }
    if (text) conversationHistory.push({ role: "assistant", text });

    // Analytics
    const latency = analytics._msgStart ? Date.now() - analytics._msgStart : null;
    if (latency) analytics.latencies.push(latency);
    analytics.lastProvider = source || "—";
    const isFallback = source === "offline" || source === "local_fallback" || source === "unavailable";
    if (isFallback) analytics.fallbacks++;
    analytics.record(isFallback ? "fallback" : "done", `${source}${latency ? " @ " + latency + "ms" : ""}`);

    if (source === "failed" || source === "unavailable" || source === "error" || error) {
      const badge = document.createElement("div");
      badge.className = "source-badge offline";
      badge.textContent = error ? error : source;
      row.appendChild(badge);
    } else if (source) {
      const badge = document.createElement("div");
      badge.className = `source-badge ${source}`;
      const names = { anthropic: "Claude", openai: "ChatGPT", gemini: "Gemini", grok: "Grok", ollama: "Ollama" };
      badge.textContent = `❆ ${names[source] || source}`;
      row.appendChild(badge);
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
    if (keystoneMcpEnabled && agentSelect.value === "keystone" && text) {
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

    isStreaming = false;
    sendBtn.disabled = false;
    setThinking(false);
    scrollToBottom();
    // TTS — speak the clean reply after stream completes
    if (text && source !== "failed" && source !== "error") speakText(text);
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
      `<span class="tag-chip active" onclick="removeTagChip('${category}','${v}')">${escapeHtml(v)} ×</span>`
    ).join("");
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
    ctfPaletteOpen = !ctfPaletteOpen;
    ctfPopup.classList.toggle("hidden", !ctfPaletteOpen);
    if (ctfPaletteOpen && !ctfPopup.children.length) buildCtfPalette();
    document.getElementById("ctf-btn").style.color = ctfPaletteOpen ? "var(--accent)" : "";
  }

  // Auto-suggest CTF as you type
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

  function stopSpeaking() {
    if (ttsAudio) { ttsAudio.pause(); ttsAudio = null; }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
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


