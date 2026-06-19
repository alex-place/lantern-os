// ── Three Doors Keystone Conversation ───────────────────────────────────────────
// Freeform conversation with Keystone — the guide answers mid-scene
// Depends on three-doors-data.js for SCENES

// ── Freeform conversation with Keystone — the guide answers mid-scene ──
const lanternHistory = [];
let lanternBusy = false;

async function askLantern(text) {
  if (lanternBusy) return;
  lanternBusy = true;
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  appendUserMsg(esc(text));
  appendTyping();

  // First history entry anchors Keystone in the current scene
  const sceneText = (SCENES[gameState?.scene_key]?.text || gameState?.text || "")
    .replace(/\*\*/g, "").replace(/\*/g, "").slice(0, 300);
  const sceneCtx = {
    role: "assistant",
    text: `Scene: ${gameState?.scene_key || "the Kingdome"} (loop ${gameState?.loop_count ?? 0}). ${sceneText}`,
  };

  let fullText = "";
  let bubble = null;
  try {
    const resp = await fetch("/api/dream/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        user: userId,
        agent: "lantern",
        surface: "three-doors",
        history: [sceneCtx, ...lanternHistory.slice(-5)],
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok || !resp.body) throw new Error("chat " + resp.status);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === "token" && (evt.text || evt.token)) {
            fullText += evt.text || evt.token;
            if (!bubble) {
              removeTyping();
              const chat = document.getElementById("chat");
              const el = document.createElement("div");
              el.className = "message agent";
              el.innerHTML = `<div class="agent-avatar">🏮</div><div class="message-content"></div>`;
              chat.appendChild(el);
              bubble = el.querySelector(".message-content");
            }
            bubble.innerHTML = md(esc(fullText.replace(/\[DOORS:[^\]]*\]?/i, "").trimEnd()));
            const chat = document.getElementById("chat");
            chat.scrollTop = chat.scrollHeight;
          } else if (evt.type === "done" && evt.cleanText) {
            fullText = evt.cleanText;
            if (bubble) bubble.innerHTML = md(esc(fullText));
          }
        } catch { /* skip malformed line */ }
      }
    }
  } catch (e) { /* fall through to fallback below */ }

  removeTyping();
  if (!fullText) {
    const chat = document.getElementById("chat");
    const el = document.createElement("div");
    el.className = "message agent";
    el.innerHTML = `<div class="agent-avatar">🏮</div><div class="message-content"><em>Keystone's flame flickers — it can't find words right now. Try again, or choose a door.</em></div>`;
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
  } else {
    lanternHistory.push({ role: "user", text }, { role: "assistant", text: fullText });
  }
  lanternBusy = false;
}
