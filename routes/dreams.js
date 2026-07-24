/**
 * Dream Chat API Routes — Conversation management, file upload
 */

module.exports = async function dreamsRoutes(req, res, url, deps) {
  const { fs, path, sendJson, collectRequestBody, repoRoot } = deps;
  const DATA_DIR = path.join(repoRoot, "data", "conversations");

  // Ensure directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // GET /api/dreams/conversations — list all conversations
  if (url.pathname === "/api/dreams/conversations" && req.method === "GET") {
    try {
      const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".jsonl"));
      const convos = files.map(f => {
        try {
          const data = fs.readFileSync(path.join(DATA_DIR, f), "utf8");
          const lines = data.trim().split("\n").filter(Boolean);
          if (lines.length === 0) return null;

          const first = JSON.parse(lines[0]);
          const last = JSON.parse(lines[lines.length - 1]);
          return {
            id: f.replace(".jsonl", ""),
            name: (first.text || "").slice(0, 50) || "Untitled",
            messageCount: lines.length,
            created: first.timestamp || 0,
            updated: last.timestamp || 0,
          };
        } catch (e) {
          return null;
        }
      }).filter(Boolean);

      sendJson(res, { conversations: convos.sort((a, b) => b.updated - a.updated) }, 200);
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
    return true;
  }

  // POST /api/dreams/conversations — create new conversation
  if (url.pathname === "/api/dreams/conversations" && req.method === "POST") {
    try {
      const id = `convo-${Date.now()}`;
      const filePath = path.join(DATA_DIR, `${id}.jsonl`);
      fs.writeFileSync(filePath, "");
      sendJson(res, { id, created: true }, 201);
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
    return true;
  }

  // GET /api/dreams/conversations/:id — get one conversation
  if (url.pathname.match(/^\/api\/dreams\/conversations\/[^/]+$/) && req.method === "GET") {
    try {
      const id = url.pathname.split("/")[4];
      const filePath = path.join(DATA_DIR, `${id}.jsonl`);
      if (!fs.existsSync(filePath)) {
        sendJson(res, { error: "Conversation not found" }, 404);
        return true;
      }
      const data = fs.readFileSync(filePath, "utf8");
      const messages = data.trim().split("\n").filter(Boolean).map(line => {
        try {
          return JSON.parse(line);
        } catch (e) {
          return null;
        }
      }).filter(Boolean);
      sendJson(res, { id, messages }, 200);
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
    return true;
  }

  // POST /api/dreams/conversations/:id/messages — add message
  if (url.pathname.match(/^\/api\/dreams\/conversations\/[^/]+\/messages$/) && req.method === "POST") {
    try {
      const id = url.pathname.split("/")[4];
      const body = await collectRequestBody(req);
      const payload = body ? JSON.parse(body) : {};

      const filePath = path.join(DATA_DIR, `${id}.jsonl`);
      const msg = { ...payload, timestamp: Date.now() };
      fs.appendFileSync(filePath, JSON.stringify(msg) + "\n");
      sendJson(res, { ok: true }, 200);
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
    return true;
  }

  // DELETE /api/dreams/conversations/:id — delete conversation
  if (url.pathname.match(/^\/api\/dreams\/conversations\/[^/]+$/) && req.method === "DELETE") {
    try {
      const id = url.pathname.split("/")[4];
      const filePath = path.join(DATA_DIR, `${id}.jsonl`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      sendJson(res, { ok: true }, 200);
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
    return true;
  }

  return false;
};
