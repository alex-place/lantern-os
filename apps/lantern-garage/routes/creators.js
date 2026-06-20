// Creator profile intake and retrieval
module.exports = async function creatorsRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody, path, repoRoot, fs } = deps;

  const creatorsDir = path.join(repoRoot, "data", "creators");

  function ensureDir() {
    if (!fs.existsSync(creatorsDir)) fs.mkdirSync(creatorsDir, { recursive: true });
  }

  // GET /api/creators — list all creator slugs
  if (url.pathname === "/api/creators" && req.method === "GET") {
    ensureDir();
    const files = fs.readdirSync(creatorsDir).filter(f => f.endsWith(".json"));
    const slugs = files.map(f => f.replace(".json", ""));
    sendJson(res, { creators: slugs });
    return true;
  }

  // GET /api/creators/:slug — load a creator profile
  if (url.pathname.startsWith("/api/creators/") && req.method === "GET") {
    const slug = url.pathname.split("/api/creators/")[1].replace(/[^a-z0-9-]/g, "");
    const filePath = path.join(creatorsDir, `${slug}.json`);
    if (!fs.existsSync(filePath)) {
      sendJson(res, { error: "Creator not found" }, 404);
      return true;
    }
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    sendJson(res, { creator: data });
    return true;
  }

  // POST /api/creators — save or update a creator profile
  if (url.pathname === "/api/creators" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const body = JSON.parse(raw);
      if (!body.slug || !/^[a-z0-9-]+$/.test(body.slug)) {
        sendJson(res, { error: "Invalid or missing slug (lowercase letters, numbers, hyphens only)" }, 400);
        return true;
      }
      ensureDir();
      const filePath = path.join(creatorsDir, `${body.slug}.json`);
      const record = { ...body, ingestedAt: new Date().toISOString() };
      fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");
      sendJson(res, { saved: true, slug: body.slug, creator: record });
    } catch (err) {
      sendJson(res, { error: err.message }, 400);
    }
    return true;
  }

  return false;
};
