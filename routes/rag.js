// RAG cache, flat RAG house, operator queue
module.exports = async function ragRoutes(req, res, url, deps) {
  const { fs, path, sendJson, readJsonl, collectRequestBody,
    appendExternalRagItem, flatRagHousePath, repoRoot,
    buildFlatRagHouse, readJson, writeFlatRagHouse, readOperatorQueue } = deps;

  if (url.pathname === "/api/rag-cache" && req.method === "GET") {
    sendJson(res, readJsonl("data/rag-intake/external-llm-web-cache/cache.jsonl", 50));
    return true;
  }
  if (url.pathname === "/api/rag-cache" && req.method === "POST") {
    try {
      const body = await collectRequestBody(req);
      const record = await appendExternalRagItem(JSON.parse(body || "{}"));
      sendJson(res, { ok: true, record }, 201);
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }
  if (url.pathname === "/api/flat-rag-house") {
    sendJson(res, fs.existsSync(flatRagHousePath)
      ? readJson(path.relative(repoRoot, flatRagHousePath), buildFlatRagHouse())
      : buildFlatRagHouse());
    return true;
  }
  if (url.pathname === "/api/operator-queue") {
    sendJson(res, { items: readOperatorQueue(), generatedAt: new Date().toISOString() });
    return true;
  }
};
