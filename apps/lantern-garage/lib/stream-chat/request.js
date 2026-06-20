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

async function parseStreamChatRequest(req, url, deps = {}) {
  const normalizeDreamerUser = deps.normalizeDreamerUser || ((value) => String(value || "dreamer"));
  const collectRequestBody = deps.collectRequestBody;

  const parsed = {
    message: "",
    user: "dreamer",
    requestedAgent: "",
    requestedProvider: "",
    history: [],
    mcpFlag: false,
    routeIntent: "",
    surface: "",
    sessionId: null,
  };

  if (req.method === "GET") {
    parsed.message = String(url.searchParams.get("message") || "").slice(0, 4000).trim();
    parsed.user = normalizeDreamerUser(url.searchParams.get("user") || "dreamer");
    parsed.requestedAgent = String(url.searchParams.get("agent") || "").trim();
    parsed.requestedProvider = String(url.searchParams.get("provider") || "").trim().toLowerCase();
    parsed.routeIntent = String(url.searchParams.get("routeIntent") || "").trim();
    parsed.surface = String(url.searchParams.get("surface") || "").trim().toLowerCase();
    parsed.sessionId = String(url.searchParams.get("sessionId") || "").trim().slice(0, 64) || null;
    return parsed;
  }

  if (typeof collectRequestBody !== "function") return parsed;

  try {
    const rawBody = await collectRequestBody(req);
    const body = JSON.parse(rawBody || "{}");
    parsed.mcpFlag = !!body.mcp;
    parsed.message = String(body.message || "").slice(0, 4000).trim();
    parsed.user = normalizeDreamerUser(body.user || "dreamer");
    parsed.requestedAgent = String(body.agent || "").trim();
    parsed.requestedProvider = String(body.provider || "").trim().toLowerCase();
    parsed.history = sanitizeHistory(body.history);
    parsed.routeIntent = String(body.routeIntent || "").trim();
    parsed.surface = String(body.surface || "").trim().toLowerCase();
    parsed.sessionId = String(body.sessionId || "").trim().slice(0, 64) || null;
  } catch {
    // Keep safe defaults for malformed JSON or body read failures.
  }

  return parsed;
}

module.exports = {
  sanitizeHistory,
  parseStreamChatRequest,
};
