// Request parsing helper for streaming dream chat.

function sanitizeHistory(value, limit = 6) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry.role === "string" && typeof entry.text === "string")
    .slice(-limit)
    .map((entry) => ({
      role: entry.role === "assistant" ? "assistant" : "user",
      text: String(entry.text).slice(0, 1000),
    }));
}

// Uploaded files attached to this turn (the "+" work tool). Bounded count + size.
// An attachment is kept if it carries extractable text OR an image data URL (#1606):
// images have no text but must survive so the server can resolve them via the vision
// model — otherwise they vanish and the model reports it received "0 files".
function sanitizeAttachments(value, maxItems = 4, maxChars = 24000, maxImageChars = 8_000_000) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((a) => a && typeof a === "object" && (
      (typeof a.text === "string" && a.text.trim()) ||
      (typeof a.image === "string" && a.image.trim())
    ))
    .slice(0, maxItems)
    .map((a) => {
      const name = String(a.name || "file").slice(0, 200);
      if (typeof a.image === "string" && a.image.trim()) {
        return {
          name,
          image: String(a.image).slice(0, maxImageChars),
          mimeType: typeof a.mimeType === "string" ? a.mimeType.slice(0, 100) : "image/png",
        };
      }
      return { name, text: String(a.text).slice(0, maxChars) };
    });
}

async function parseStreamChatRequest(req, url, deps = {}) {
  const normalizeDreamerUser = deps.normalizeDreamerUser || ((value) => String(value || "dreamer"));
  const collectRequestBody = deps.collectRequestBody;

  const parsed = {
    message: "",
    user: "dreamer",
    requestedAgent: "",
    requestedProvider: "",
    requestedModel: "",
    history: [],
    mcpFlag: false,
    routeIntent: "",
    surface: "",
    sessionId: null,
    attachments: [],
    forceGround: false,
  };

  if (req.method === "GET") {
    parsed.message = String(url.searchParams.get("message") || "").slice(0, 4000).trim();
    parsed.user = normalizeDreamerUser(url.searchParams.get("user") || "dreamer");
    parsed.requestedAgent = String(url.searchParams.get("agent") || "").trim();
    parsed.requestedProvider = String(url.searchParams.get("provider") || "").trim().toLowerCase();
    // Model pin (#1127): honoured only with a pinned provider AND an allowlisted id.
    parsed.requestedModel = String(url.searchParams.get("model") || "").trim().slice(0, 80);
    parsed.routeIntent = String(url.searchParams.get("routeIntent") || "").trim();
    parsed.surface = String(url.searchParams.get("surface") || "").trim().toLowerCase();
    parsed.sessionId = String(url.searchParams.get("sessionId") || "").trim().slice(0, 64) || null;
    // "Ground this" retry: force the web-search grounding branch for a reply the
    // groundedness canary flagged as confident-but-unanchored (the 42-state).
    parsed.forceGround = ["1", "true"].includes(String(url.searchParams.get("forceGround") || "").toLowerCase());
    return parsed;
  }

  if (typeof collectRequestBody !== "function") return parsed;

  try {
    let rawBody = await collectRequestBody(req);
    // Strip a leading UTF-8 BOM (﻿). Some clients (PowerShell `Out-File -Encoding
    // utf8`, certain editors/proxies) prepend one; JSON.parse THROWS on a leading BOM,
    // which previously dropped the whole body to defaults — an empty message that then
    // mis-surfaced as "all providers failed / cloud unreachable". Strip it first.
    if (typeof rawBody === "string" && rawBody.charCodeAt(0) === 0xfeff) rawBody = rawBody.slice(1);
    // Empty / whitespace-only body is distinct from malformed JSON — flag it as its own
    // parseError instead of silently dropping to defaults (the test contract, #1009). #1358
    if (!rawBody || !String(rawBody).trim()) {
      parsed.parseError = "empty_body";
      return parsed;
    }
    const body = JSON.parse(rawBody);
    parsed.mcpFlag = !!body.mcp;
    parsed.message = String(body.message || "").slice(0, 4000).trim();
    parsed.user = normalizeDreamerUser(body.user || "dreamer");
    parsed.requestedAgent = String(body.agent || "").trim();
    parsed.requestedProvider = String(body.provider || "").trim().toLowerCase();
    parsed.requestedModel = String(body.model || "").trim().slice(0, 80);
    parsed.history = sanitizeHistory(body.history);
    parsed.routeIntent = String(body.routeIntent || "").trim();
    parsed.surface = String(body.surface || "").trim().toLowerCase();
    parsed.sessionId = String(body.sessionId || "").trim().slice(0, 64) || null;
    parsed.attachments = sanitizeAttachments(body.attachments);
    parsed.forceGround = body.forceGround === true || body.forceGround === "1";
  } catch {
    // Body was present but unparseable (malformed JSON, bad encoding). Flag it so the
    // handler surfaces an honest "couldn't read your message" instead of routing an
    // empty message to the providers and blaming them. Σ₀: surface why, don't swallow.
    // The contract (test_stream_chat_request_helper.js) is parseError="malformed_json". #1358
    parsed.parseError = "malformed_json";
  }

  return parsed;
}

module.exports = {
  sanitizeHistory,
  sanitizeAttachments,
  parseStreamChatRequest,
};
