// Document processing for Keystone chat: upload a .docx, have the LLM rewrite it per
// an instruction (e.g. "add my Lantern OS work + polish"), regenerate a styled .docx,
// and hand back a download link. Read/write of the .docx is done by a python-docx
// helper (scripts/resume_docx.py); the rewrite is a non-streaming Claude call.
const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");
const Busboy = require("busboy");
const { llmAgent } = require("../lib/insecure-tls");

// ── find a python that actually has python-docx (Windows PATH is unreliable) ──
let _python = null;
function resolvePython(repoRoot) {
  if (_python) return _python;
  const candidates = [
    process.env.LANTERN_PYTHON,
    "python3", "python",
    "C:/Users/alexp/AppData/Local/Python/pythoncore-3.14-64/python.exe",
  ].filter(Boolean);
  for (const py of candidates) {
    try {
      execFileSync(py, ["-c", "import docx"], { stdio: "ignore", timeout: 8000 });
      _python = py;
      return py;
    } catch { /* try next */ }
  }
  throw new Error("no python with python-docx found (pip install python-docx)");
}

function docHelper(repoRoot, args, input) {
  const py = resolvePython(repoRoot);
  const script = path.join(repoRoot, "scripts", "resume_docx.py");
  return execFileSync(py, [script, ...args], {
    cwd: repoRoot, input: input || undefined, encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024, timeout: 60000,
  });
}

// ── non-streaming Claude call returning the rewritten document as JSON ──
function rewriteWithClaude({ apiKey, model, currentText, instruction }) {
  const schema = `{"name": string, "contact": string, "sections": [{"heading": string, "paragraphs"?: string[], "bullets"?: string[], "entries"?: [{"title": string, "org": string, "dates": string, "bullets": string[]}]}]}`;
  const system = [
    "You are a precise professional document/resume editor.",
    "You are given the plain text of a user's existing document and an instruction.",
    "Rewrite the document by applying the instruction. Improve clarity, fix formatting/encoding artifacts (e.g. mangled dashes), tighten wording, and modernize structure.",
    "Be TRUTHFUL: do not invent employers, dates, degrees, or achievements that are not in the input or explicitly provided by the instruction. You may rephrase and strengthen existing facts.",
    `Return ONLY a JSON object — no prose, no code fences — matching this schema: ${schema}`,
    "Put the person's name in `name` and a single contact line in `contact`. Each section has a heading and any of paragraphs[]/bullets[]/entries[]. Use `entries` for jobs (title, org incl. location, dates, achievement bullets).",
  ].join("\n");
  const user = `INSTRUCTION:\n${instruction}\n\n=== CURRENT DOCUMENT TEXT ===\n${currentText}`;

  const payload = JSON.stringify({
    model, max_tokens: 4096, system,
    messages: [{ role: "user", content: user }],
  });
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
          let text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
          text = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
          resolve(JSON.parse(text));
        } catch (e) { reject(new Error("bad_llm_json: " + e.message)); }
      });
      up.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(90000, () => { req.destroy(); reject(new Error("anthropic_timeout")); });
    req.write(payload); req.end();
  });
}

module.exports = async function documentRoutes(req, res, url, deps) {
  const { sendJson, sendFile, repoRoot } = deps;
  const workDir = path.join(repoRoot, "data", "documents");

  // POST /api/document/generate — generate a downloadable document (pdf/md/html) from a prompt
  // (content written by the model) or supplied markdown. Markdown → print-styled PDF via Playwright.
  if (url.pathname === "/api/document/generate" && req.method === "POST") {
    try {
      const raw = await deps.collectRequestBody(req, 2 * 1024 * 1024);
      const body = JSON.parse(raw || "{}");
      const { generateDocument } = require("../lib/document-builder");
      const result = await generateDocument({
        prompt: String(body.prompt || ""),
        markdown: String(body.markdown || ""),
        title: String(body.title || ""),
        format: String(body.format || "pdf"),
      });
      sendJson(res, result, result.ok ? 200 : 502);
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500);
    }
    return true;
  }

  // GET /api/document/download?file=<name> — serve a generated document.
  if (url.pathname === "/api/document/download" && req.method === "GET") {
    const file = (url.searchParams.get("file") || "").replace(/[^a-zA-Z0-9._-]/g, "");
    if (!file || file.includes("..")) { sendJson(res, { error: "invalid file" }, 400); return true; }
    const { DOCS_DIR } = require("../lib/document-builder");
    const fp = path.join(DOCS_DIR, file);
    if (!fs.existsSync(fp)) { sendJson(res, { error: "not found" }, 404); return true; }
    // Content-Type is set by sendFile from the extension (incl. docx/xlsx/pptx);
    // we only force the download disposition + filename here.
    res.setHeader("Content-Disposition", `attachment; filename="${file}"`);
    sendFile(res, fp);
    return true;
  }

  // GET /api/documents/file?id=<id> — download a processed document
  if (url.pathname === "/api/documents/file" && req.method === "GET") {
    const id = (url.searchParams.get("id") || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!id) { sendJson(res, { error: "invalid id" }, 400); return true; }
    const file = path.join(workDir, id + "-out.docx");
    if (!fs.existsSync(file)) { sendJson(res, { error: "not_found" }, 404); return true; }
    res.setHeader("Content-Disposition", `attachment; filename="${id}.docx"`);
    sendFile(res, file);
    return true;
  }

  // POST /api/documents/process — multipart: file (.docx) + instruction
  if (url.pathname === "/api/documents/process" && req.method === "POST") {
    const { isOperatorRequest } = require("../lib/request-auth");
    if (!isOperatorRequest(req)) { sendJson(res, { error: "operator access required" }, 403); return true; }
    const ct = req.headers["content-type"] || "";
    if (!ct.includes("multipart/form-data")) { sendJson(res, { error: "multipart/form-data required" }, 400); return true; }

    fs.mkdirSync(workDir, { recursive: true });
    const id = "doc-" + Date.now().toString(36) + "-" + Math.floor(performance.now()).toString(36);
    const inPath = path.join(workDir, id + "-in.docx");
    const outPath = path.join(workDir, id + "-out.docx");
    let instruction = "Polish and modernize this document; fix formatting and tighten wording without inventing facts.";
    let origName = "document.docx";
    let gotFile = false;
    const writes = [];

    const bb = Busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024 } });
    bb.on("field", (name, val) => { if (name === "instruction" && val) instruction = val; if (name === "filename" && val) origName = val; });
    bb.on("file", (fieldname, file, info) => {
      const fn = (info && info.filename) || "";
      if (!fn.toLowerCase().endsWith(".docx")) { file.resume(); return; }
      gotFile = true; origName = fn;
      writes.push(new Promise((resolve) => {
        const ws = fs.createWriteStream(inPath);
        file.pipe(ws); ws.on("finish", resolve); ws.on("error", resolve);
      }));
    });
    bb.on("close", async () => {
      await Promise.all(writes);
      if (!gotFile || !fs.existsSync(inPath)) { if (!res.writableEnded) sendJson(res, { error: "no .docx uploaded" }, 400); return; }
      try {
        const currentText = docHelper(repoRoot, ["extract", inPath]);
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) { sendJson(res, { error: "no_anthropic_key" }, 503); return; }
        const model = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
        const spec = await rewriteWithClaude({ apiKey, model, currentText, instruction });
        docHelper(repoRoot, ["build", outPath], JSON.stringify(spec));
        const outName = origName.replace(/\.docx$/i, "") + " (updated).docx";
        sendJson(res, {
          ok: true, id,
          downloadUrl: "/api/documents/file?id=" + id,
          filename: outName,
          name: spec.name || null,
          sections: (spec.sections || []).map(s => s.heading).filter(Boolean),
        }, 200);
      } catch (err) {
        if (!res.writableEnded) sendJson(res, { ok: false, error: String(err.message || err) }, 500);
      }
    });
    bb.on("error", (e) => { if (!res.writableEnded) sendJson(res, { ok: false, error: e.message }, 500); });
    req.pipe(bb);
    return true;
  }

  return false;
};
