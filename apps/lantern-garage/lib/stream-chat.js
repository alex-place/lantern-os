const https = require("https");
const http = require("http");
const { AGENT_PERSONAS, selectAgent } = require("./dream-chat");
const { readRecentDreams, normalizeDreamerUser } = require("./dreamer-store");
const { appendConversationEntry } = require("./conversation-store");

const maxConversationTextLength = 4000;

async function handleStreamChat(req, url, res) {
  let message = "";
  let user = "dreamer";
  let requestedAgent = "";
  let requestedProvider = "";
  if (req.method === "GET") {
    message = String(url.searchParams.get("message") || "").slice(0, 4000).trim();
    user = normalizeDreamerUser(url.searchParams.get("user") || "dreamer");
    requestedAgent = String(url.searchParams.get("agent") || "").trim();
    requestedProvider = String(url.searchParams.get("provider") || "").trim().toLowerCase();
  } else {
    try {
      const { collectRequestBody } = require("./http-utils");
      const rawBody = await collectRequestBody(req);
      const body = JSON.parse(rawBody || "{}");
      message = String(body.message || "").slice(0, 4000).trim();
      user = normalizeDreamerUser(body.user || "dreamer");
      requestedAgent = String(body.agent || "").trim();
      requestedProvider = String(body.provider || "").trim().toLowerCase();
    } catch { /* message stays empty */ }
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  });

  const recentDreams = readRecentDreams(5);

  const agent = requestedAgent
    ? (AGENT_PERSONAS.find((a) => a.id === requestedAgent) || selectAgent(message))
    : selectAgent(message);
  const dreamContext = recentDreams.length > 0
    ? `Recent journal entries:\n${recentDreams.slice(0, 3).map((d, i) =>
        `${i + 1}. ${String(d.text || d.content || "").slice(0, 200)}`
      ).join("\n")}`
    : "No journal entries yet — this is the dreamer's first visit.";

  const systemPrompt = `${agent.systemPrompt}\n\n${dreamContext}\n\nTone: thoughtful, unhurried, human. Never clinical. Never sycophantic. Use the dreamer's own words back to them. End responses with one question or one invitation to record.`;

  const sendToken = (token) => {
    res.write(`data: ${JSON.stringify({ type: "token", text: token })}\n\n`);
  };
  const sendDone = (source, extra = {}) => {
    res.write(`data: ${JSON.stringify({ type: "done", source, ...extra })}\n\n`);
    res.end();
  };
  const sendError = (msg) => {
    res.write(`data: ${JSON.stringify({ type: "error", text: msg })}\n\n`);
  };

  await appendConversationEntry({
    recordedAt: new Date().toISOString(),
    surface: "dream-chat-stream",
    role: "operator",
    text: message.slice(0, maxConversationTextLength),
  }).catch(() => {});

  let fullReply = "";

  // Provider 1: Anthropic Claude (streaming)
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey && message && (!requestedProvider || requestedProvider === "claude" || requestedProvider === "anthropic")) {
    try {
      const anthropicModel = String(process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-20241022").replace(/\[[0-9;]*m/g, "").trim();
      const payload = JSON.stringify({
        model: anthropicModel,
        max_tokens: 1024,
        stream: true,
        system: systemPrompt,
        messages: [{ role: "user", content: message }],
      });

      await new Promise((resolve, reject) => {
        const opts = {
          hostname: "api.anthropic.com",
          path: "/v1/messages",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
            "Content-Length": Buffer.byteLength(payload),
          },
        };
        const req2 = https.request(opts, (upstream) => {
          if (upstream.statusCode !== 200) {
            upstream.resume();
            reject(new Error(`anthropic_status_${upstream.statusCode}`));
            return;
          }
          let buf = "";
          upstream.on("data", (chunk) => {
            buf += chunk.toString();
            const lines = buf.split("\n");
            buf = lines.pop();
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const raw = line.slice(5).trim();
              if (raw === "[DONE]" || raw === "") continue;
              try {
                const evt = JSON.parse(raw);
                if (evt.type === "content_block_delta" && evt.delta?.text) {
                  fullReply += evt.delta.text;
                  sendToken(evt.delta.text);
                }
              } catch { /* skip malformed */ }
            }
          });
          upstream.on("end", () => resolve());
          upstream.on("error", reject);
        });
        req2.on("error", reject);
        req2.write(payload);
        req2.end();
      });

      await appendConversationEntry({
        recordedAt: new Date().toISOString(),
        surface: "dream-chat-stream",
        role: "lantern",
        text: fullReply.slice(0, maxConversationTextLength),
      }).catch(() => {});

      sendDone("anthropic", { agent: agent.name, online: true });
      return;
    } catch (err) {
      sendError(`anthropic_unavailable: ${err.message}`);
      if (requestedProvider) { sendDone("unavailable", { error: err.message, agent: agent.name }); return; }
    }
  }

  // Provider 2: OpenAI (streaming)
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey && message && (!requestedProvider || requestedProvider === "openai" || requestedProvider === "gpt")) {
    try {
      const payload = JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        stream: true,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ],
      });
      await new Promise((resolve, reject) => {
        const req2 = https.request({
          hostname: "api.openai.com",
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${openaiKey}`,
            "Content-Length": Buffer.byteLength(payload),
          },
        }, (upstream) => {
          if (upstream.statusCode !== 200) {
            upstream.resume();
            reject(new Error(`openai_status_${upstream.statusCode}`));
            return;
          }
          let buf = "";
          upstream.on("data", (chunk) => {
            buf += chunk.toString();
            const lines = buf.split("\n");
            buf = lines.pop();
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const raw = line.slice(6).trim();
              if (raw === "[DONE]" || raw === "") continue;
              try {
                const evt = JSON.parse(raw);
                const token = evt.choices?.[0]?.delta?.content || "";
                if (token) {
                  fullReply += token;
                  sendToken(token);
                }
              } catch { /* skip malformed */ }
            }
          });
          upstream.on("end", () => resolve());
          upstream.on("error", reject);
        });
        req2.on("error", reject);
        req2.setTimeout(15000, () => { req2.destroy(); reject(new Error("openai_timeout")); });
        req2.write(payload);
        req2.end();
      });
      await appendConversationEntry({
        recordedAt: new Date().toISOString(),
        surface: "dream-chat-stream",
        role: "lantern",
        text: fullReply.slice(0, maxConversationTextLength),
      }).catch(() => {});
      sendDone("openai", { agent: agent.name, online: true });
      return;
    } catch (err) {
      sendError(`openai_unavailable: ${err.message}`);
      if (requestedProvider) { sendDone("unavailable", { error: err.message, agent: agent.name }); return; }
    }
  }

  // Provider 3: Gemini (streaming)
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (geminiKey && message && (!requestedProvider || requestedProvider === "gemini" || requestedProvider === "google")) {
    try {
      const payload = JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\n${message}` }] }],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
      });
      const geminiModel = process.env.GEMINI_MODEL || "gemini-1.5-flash";
      await new Promise((resolve, reject) => {
        const req2 = https.request({
          hostname: "generativelanguage.googleapis.com",
          path: `/v1beta/models/${geminiModel}:streamGenerateContent?alt=sse&key=${geminiKey}`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        }, (upstream) => {
          if (upstream.statusCode !== 200) {
            upstream.resume();
            reject(new Error(`gemini_status_${upstream.statusCode}`));
            return;
          }
          let buf = "";
          upstream.on("data", (chunk) => {
            buf += chunk.toString();
            const lines = buf.split("\n");
            buf = lines.pop();
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const raw = line.slice(6).trim();
              if (!raw) continue;
              try {
                const evt = JSON.parse(raw);
                const parts = evt.candidates?.[0]?.content?.parts || [];
                for (const p of parts) {
                  const token = p.text || "";
                  if (token) { fullReply += token; sendToken(token); }
                }
              } catch { /* skip malformed */ }
            }
          });
          upstream.on("end", () => resolve());
          upstream.on("error", reject);
        });
        req2.on("error", reject);
        req2.setTimeout(15000, () => { req2.destroy(); reject(new Error("gemini_timeout")); });
        req2.write(payload);
        req2.end();
      });
      await appendConversationEntry({
        recordedAt: new Date().toISOString(),
        surface: "dream-chat-stream",
        role: "lantern",
        text: fullReply.slice(0, maxConversationTextLength),
      }).catch(() => {});
      sendDone("gemini", { agent: agent.name, online: true });
      return;
    } catch (err) {
      sendError(`gemini_unavailable: ${err.message}`);
      if (requestedProvider) { sendDone("unavailable", { error: err.message, agent: agent.name }); return; }
    }
  }

  // Provider 4: Ollama (streaming)
  const ollamaBase = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const ollamaModel = process.env.OLLAMA_MODEL || "llama3";
  if (message && (!requestedProvider || requestedProvider === "ollama" || requestedProvider === "local")) {
    try {
      const payload = JSON.stringify({
        model: ollamaModel,
        stream: true,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ],
      });

      const ollamaUrl = new URL(ollamaBase);
      const ollamaOpts = {
        hostname: ollamaUrl.hostname,
        port: ollamaUrl.port || 11434,
        path: "/api/chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      };

      let ollamaOk = false;
      await new Promise((resolve, reject) => {
        const req2 = http.request(ollamaOpts, (upstream) => {
          if (upstream.statusCode !== 200) {
            upstream.resume();
            reject(new Error(`ollama_status_${upstream.statusCode}`));
            return;
          }
          ollamaOk = true;
          let buf = "";
          upstream.on("data", (chunk) => {
            buf += chunk.toString();
            const lines = buf.split("\n");
            buf = lines.pop();
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const evt = JSON.parse(line);
                const token = evt.message?.content || evt.response || "";
                if (token) {
                  fullReply += token;
                  sendToken(token);
                }
              } catch { /* skip */ }
            }
          });
          upstream.on("end", () => resolve());
          upstream.on("error", reject);
        });
        req2.on("error", reject);
        req2.setTimeout(5000, () => {
          req2.destroy();
          reject(new Error("ollama_connect_timeout"));
        });
        req2.write(payload);
        req2.end();
      });

      if (ollamaOk) {
        await appendConversationEntry({
          recordedAt: new Date().toISOString(),
          surface: "dream-chat-stream",
          role: "lantern",
          text: fullReply.slice(0, maxConversationTextLength),
        }).catch(() => {});
        sendDone("ollama", { agent: agent.name, online: true });
        return;
      }
    } catch (err) {
      sendError(`ollama_unavailable: ${err.message}`);
      if (requestedProvider) { sendDone("unavailable", { error: err.message, agent: agent.name }); return; }
    }
  }

  // No provider available — clean failure
  sendError("All providers unavailable. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or start Ollama.");
  sendDone("unavailable", { error: "no_provider", agent: agent.name, online: false });
}

module.exports = { handleStreamChat };
