// docmode.js — Keystone "Document Mode": a versioned document workspace edited
// turn-by-turn from chat. Each /propose call returns a revised text + explanation
// WITHOUT saving; the client shows a diff and the user clicks Apply (/apply) to commit
// a revision. Undo/rollback = /revert. Export rebuilds a .docx from the current text.
//
// Editing philosophy: the model is told to change ONLY what was asked and otherwise
// reproduce the document verbatim, so the diff stays a minimal patch — not a rewrite.
const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");
const Busboy = require("busboy");
const { llmAgent } = require("../lib/insecure-tls");
const store = require("../lib/docmode-store");

// ── python with python-docx (shared with routes/documents.js semantics) ──
let _python = null;
function resolvePython() {
  if (_python) return _python;
  const cands = [process.env.LANTERN_PYTHON, "python3", "python", "C:/Users/alexp/AppData/Local/Python/pythoncore-3.14-64/python.exe"].filter(Boolean);
  for (const py of cands) {
    try { execFileSync(py, ["-c", "import docx"], { stdio: "ignore", timeout: 8000 }); _python = py; return py; } catch {}
  }
  throw new Error("no python with python-docx (pip install python-docx)");
}
function docHelper(repoRoot, args, input) {
  const script = path.join(repoRoot, "scripts", "resume_docx.py");
  return execFileSync(resolvePython(), [script, ...args], { cwd: repoRoot, input, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024, timeout: 60000 });
}

// ── non-streaming Claude edit: returns { explanation, newText } ──
function proposeEdit({ apiKey, model, docText, instruction, selection }) {
  const sel = selection && selection.trim()
    ? `\n\nThe user has SELECTED this passage — apply the change to it specifically (you may still return the whole document):\n<<<SELECTION\n${selection}\nSELECTION>>>`
    : "";
  const system = [
    "You are Keystone, a careful collaborative document editor (like editing a shared doc).",
    "Apply ONLY the change the user asks for. Reproduce everything else of the document VERBATIM — same wording, same order, same markdown formatting (headings #, lists -, blank lines). Do not silently rewrite, reorder, or 'improve' untouched parts. Minimal diffs.",
    "Preserve the author's meaning unless they explicitly ask to change it. Never invent facts.",
    "Return ONLY a JSON object: {\"explanation\": string, \"newText\": string}. `explanation` is 1-3 short sentences describing what you changed and where. `newText` is the FULL updated document as markdown.",
  ].join("\n");
  const user = `INSTRUCTION:\n${instruction}${sel}\n\n=== CURRENT DOCUMENT (markdown) ===\n${docText}`;
  const payload = JSON.stringify({ model, max_tokens: 8192, system, messages: [{ role: "user", content: user }] });
  return new Promise((resolve, reject) => {
    const req = https.request({
      agent: llmAgent, hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(payload) },
    }, (up) => {
      if (up.statusCode !== 200) { up.resume(); reject(new Error(`anthropic_status_${up.statusCode}`)); return; }
      let b = ""; up.on("data", c => b += c);
      up.on("end", () => {
        try {
          const j = JSON.parse(b);
          let t = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
          t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
          const obj = JSON.parse(t);
          resolve({ explanation: String(obj.explanation || "Updated the document."), newText: String(obj.newText || "") });
        } catch (e) { reject(new Error("bad_llm_json: " + e.message)); }
      });
      up.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error("anthropic_timeout")); });
    req.write(payload); req.end();
  });
}

function readJson(req, deps) {
  return deps.collectRequestBody(req).then(b => { try { return b ? JSON.parse(b) : {}; } catch { return {}; } });
}

module.exports = async function docmodeRoutes(req, res, url, deps) {
  const { sendJson, sendFile, repoRoot } = deps;
  const p = url.pathname;
  if (!p.startsWith("/api/docmode/")) return false;

  const { isOperatorRequest } = require("../lib/request-auth");
  if (!isOperatorRequest(req)) { sendJson(res, { error: "operator access required" }, 403); return true; }

  // POST /api/docmode/create — JSON {title,text}  OR  multipart .docx import
  if (p === "/api/docmode/create" && req.method === "POST") {
    const ct = req.headers["content-type"] || "";
    if (ct.includes("multipart/form-data")) {
      const tmp = path.join(repoRoot, "data", "documents", "ws-import-" + Date.now() + ".docx");
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      let got = false, title = "Imported document"; const writes = [];
      const bb = Busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024 } });
      bb.on("file", (f, file, info) => {
        const fn = (info && info.filename) || "";
        if (!fn.toLowerCase().endsWith(".docx")) { file.resume(); return; }
        got = true; title = fn.replace(/\.docx$/i, "");
        writes.push(new Promise(r => { const ws = fs.createWriteStream(tmp); file.pipe(ws); ws.on("finish", r); ws.on("error", r); }));
      });
      bb.on("close", async () => {
        await Promise.all(writes);
        if (!got) { sendJson(res, { error: "no .docx" }, 400); return; }
        try {
          const text = docHelper(repoRoot, ["extract-md", tmp]);
          const doc = store.createDoc({ title, text });
          fs.unlink(tmp, () => {});
          sendJson(res, store.view(doc), 200);
        } catch (e) { sendJson(res, { error: String(e.message) }, 500); }
      });
      req.pipe(bb); return true;
    }
    const body = await readJson(req, deps);
    const doc = store.createDoc({ title: body.title, text: body.text });
    sendJson(res, store.view(doc), 200); return true;
  }

  // GET /api/docmode/get?id=
  if (p === "/api/docmode/get" && req.method === "GET") {
    const doc = store.getDoc(url.searchParams.get("id"));
    if (!doc) { sendJson(res, { error: "not_found" }, 404); return true; }
    sendJson(res, store.view(doc), 200); return true;
  }

  // POST /api/docmode/propose — {id, instruction, selection?} → {explanation, newText} (no save)
  if (p === "/api/docmode/propose" && req.method === "POST") {
    const body = await readJson(req, deps);
    const doc = store.getDoc(body.id);
    if (!doc) { sendJson(res, { error: "not_found" }, 404); return true; }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { sendJson(res, { error: "no_anthropic_key" }, 503); return true; }
    try {
      const out = await proposeEdit({
        apiKey, model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
        docText: store.currentText(doc), instruction: String(body.instruction || ""), selection: body.selection || "",
      });
      sendJson(res, { ok: true, explanation: out.explanation, newText: out.newText, baseRevision: doc.current }, 200);
    } catch (e) { sendJson(res, { ok: false, error: String(e.message) }, 500); }
    return true;
  }

  // POST /api/docmode/apply — {id, text, note} → new revision
  if (p === "/api/docmode/apply" && req.method === "POST") {
    const body = await readJson(req, deps);
    const doc = store.addRevision(body.id, String(body.text || ""), body.note || "Applied edit");
    if (!doc) { sendJson(res, { error: "not_found" }, 404); return true; }
    sendJson(res, store.view(doc), 200); return true;
  }

  // POST /api/docmode/revert — {id, index} → set current revision (Undo / rollback)
  if (p === "/api/docmode/revert" && req.method === "POST") {
    const body = await readJson(req, deps);
    const doc = store.setCurrent(body.id, body.index);
    if (!doc) { sendJson(res, { error: "not_found" }, 404); return true; }
    sendJson(res, store.view(doc), 200); return true;
  }

  // POST /api/docmode/title — {id, title}
  if (p === "/api/docmode/title" && req.method === "POST") {
    const body = await readJson(req, deps);
    const doc = store.setTitle(body.id, body.title);
    if (!doc) { sendJson(res, { error: "not_found" }, 404); return true; }
    sendJson(res, store.view(doc), 200); return true;
  }

  // GET /api/docmode/export?id= — rebuild a .docx from the current markdown
  if (p === "/api/docmode/export" && req.method === "GET") {
    const doc = store.getDoc(url.searchParams.get("id"));
    if (!doc) { sendJson(res, { error: "not_found" }, 404); return true; }
    try {
      const outPath = path.join(repoRoot, "data", "documents", doc.id + "-export.docx");
      docHelper(repoRoot, ["build-md", outPath], store.currentText(doc));
      res.setHeader("Content-Disposition", `attachment; filename="${(doc.title || "document").replace(/[^a-zA-Z0-9 _.-]/g, "_")}.docx"`);
      sendFile(res, outPath);
    } catch (e) { sendJson(res, { error: String(e.message) }, 500); }
    return true;
  }

  return false;
};
