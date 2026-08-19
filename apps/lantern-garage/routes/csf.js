"use strict";

const { getDictStats, readDeltas } = require("../lib/csf-delta-store");
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const knowledgeRouter = require("../lib/knowledge-router");

const TESSERACT_SCRIPT = path.resolve(__dirname, "../../../scripts/csf_research_tesseract.py");
const TESSERACT_MANIFEST = path.resolve(__dirname, "../../../data/tesseract/manifest.json");

function runPython(args, repoRoot, extraEnv) {
  return new Promise((resolve, reject) => {
    const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
    execFile("python", args, { cwd: repoRoot, timeout: 120_000, env }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on("end", () => resolve(b || "{}"));
    req.on("error", reject);
  });
}

// Resolve a user-supplied relative path strictly inside repoRoot (no traversal).
function resolveInRepo(repoRoot, p) {
  const root = path.resolve(repoRoot);
  const full = path.resolve(root, p);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`path escapes repo: ${p}`);
  }
  return full;
}

module.exports = async function csfRoutes(req, res, url, deps) {
  const { sendJson, repoRoot } = deps || {};

  const p = url.pathname;
  if (!p.startsWith("/api/csf/") && !p.startsWith("/api/knowledge/")) return false;

  // GET /api/knowledge/report-manifest — the allowlist of research PDFs that may be
  // shown on the PUBLIC Knowledge Center. /api/pdfs is a directory listing of the
  // ingest pool (third-party papers included), so the page filters through this.
  if (p === "/api/knowledge/report-manifest" && req.method === "GET") {
    try {
      const mf = path.resolve(__dirname, "../../../data/knowledge/report-manifest.json");
      const j = JSON.parse(fs.readFileSync(mf, "utf8"));
      return sendJson(res, { reports: Array.isArray(j.reports) ? j.reports : [] });
    } catch {
      // Fail CLOSED: an unreadable allowlist must not become "allow everything".
      return sendJson(res, { reports: [] });
    }
  }

  // GET/POST /api/knowledge/query — cheaper deterministic/near routing over the
  // base Knowledge Center index. Answers $0 (no LLM) on a near hit; else miss.
  if (p === "/api/knowledge/query") {
    try {
      let q = url.searchParams.get("q") || "";
      if (req.method === "POST") { const b = JSON.parse(await readBody(req)); q = b.query || b.q || q; }
      if (!q) return sendJson(res, { error: "q/query required" }, 400);
      sendJson(res, knowledgeRouter.answer(q));
    } catch (err) { sendJson(res, { error: err.message }, 500); }
    return true;
  }

  // POST /api/csf/profile/pack { user } — one file compacting all a user's CSF data + KB grounding
  if (req.method === "POST" && p === "/api/csf/profile/pack") {
    try {
      const body = JSON.parse(await readBody(req));
      const user = String(body.user || "").replace(/[^a-zA-Z0-9._-]/g, "");
      if (!user) return sendJson(res, { ok: false, error: "user required" }, 400);
      const out = `data/profiles/${user}.csf`;
      const log = await runPython(["-m", "csf.profile_pack", "pack", user, "-o", out], repoRoot,
        { PYTHONPATH: path.resolve(repoRoot, "src") });
      const full = path.resolve(repoRoot, out);
      sendJson(res, { ok: true, log, out, bytes: fs.existsSync(full) ? fs.statSync(full).size : null });
    } catch (err) { sendJson(res, { ok: false, error: err.message }, 500); }
    return true;
  }

  // GET /api/csf/profile/info?user=<id> — embedded profile manifest (no extract)
  if (req.method === "GET" && p === "/api/csf/profile/info") {
    try {
      const user = String(url.searchParams.get("user") || "").replace(/[^a-zA-Z0-9._-]/g, "");
      const arc = path.resolve(repoRoot, `data/profiles/${user}.csf`);
      if (!user || !fs.existsSync(arc)) return sendJson(res, { error: "profile not found" }, 404);
      const log = await runPython(["-m", "csf.profile_pack", "info", arc], repoRoot,
        { PYTHONPATH: path.resolve(repoRoot, "src") });
      sendJson(res, JSON.parse(log));
    } catch (err) { sendJson(res, { error: err.message }, 500); }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/csf/stats") {
    const stats = getDictStats();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(stats));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/csf/deltas") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 200);
    const deltas = readDeltas(limit);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(deltas));
    return true;
  }

  // POST /api/csf/pack — CSF-Pack v0.8: pack ARBITRARY repo files into one .csf
  //   body: { paths: ["docs", "README.md"], out: "data/exports/bundle.csf", compress?: true }
  // Paths and out are constrained to within repoRoot (no traversal).
  if (req.method === "POST" && url.pathname === "/api/csf/pack") {
    try {
      const body = JSON.parse(await readBody(req));
      const paths = Array.isArray(body.paths) ? body.paths : [];
      const out = body.out || "data/exports/bundle.csf";
      if (!paths.length) return sendJson(res, { ok: false, error: "paths[] required" }, 400);
      const safePaths = paths.map((p) => resolveInRepo(repoRoot, p));
      const safeOut = resolveInRepo(repoRoot, out);
      fs.mkdirSync(path.dirname(safeOut), { recursive: true });
      const args = ["-m", "csf.csf_pack", "pack", ...safePaths, "-o", safeOut];
      if (body.compress === false) args.push("--no-compress");
      const log = await runPython(args, repoRoot, { PYTHONPATH: path.resolve(repoRoot, "src") });
      const stat = fs.existsSync(safeOut) ? fs.statSync(safeOut) : null;
      sendJson(res, { ok: true, log, out, bytes: stat ? stat.size : null });
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500);
    }
    return true;
  }

  // POST /api/csf/unpack — extract a CSF-Pack archive (integrity + path-safety enforced)
  //   body: { archive: "data/exports/bundle.csf", dest: "data/exports/out" }
  if (req.method === "POST" && url.pathname === "/api/csf/unpack") {
    try {
      const body = JSON.parse(await readBody(req));
      const archive = resolveInRepo(repoRoot, body.archive || "");
      const dest = resolveInRepo(repoRoot, body.dest || "data/exports/out");
      const log = await runPython(["-m", "csf.csf_pack", "unpack", archive, "-d", dest], repoRoot,
        { PYTHONPATH: path.resolve(repoRoot, "src") });
      sendJson(res, { ok: true, log, dest: body.dest });
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500);
    }
    return true;
  }

  // POST /api/csf/tesseract/pack — compress all ingest PDFs into one CSF tesseract
  if (req.method === "POST" && url.pathname === "/api/csf/tesseract/pack") {
    try {
      const out = await runPython([TESSERACT_SCRIPT, "pack"], repoRoot);
      const manifest = fs.existsSync(TESSERACT_MANIFEST)
        ? JSON.parse(fs.readFileSync(TESSERACT_MANIFEST, "utf-8"))
        : null;
      sendJson(res, { ok: true, log: out, manifest });
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500);
    }
    return true;
  }

  // POST /api/csf/tesseract/unpack — read and return the manifest from the tesseract
  if (req.method === "POST" && url.pathname === "/api/csf/tesseract/unpack") {
    try {
      const out = await runPython([TESSERACT_SCRIPT, "unpack"], repoRoot);
      const manifest = fs.existsSync(TESSERACT_MANIFEST)
        ? JSON.parse(fs.readFileSync(TESSERACT_MANIFEST, "utf-8"))
        : null;
      sendJson(res, { ok: true, log: out, manifest });
    } catch (err) {
      sendJson(res, { ok: false, error: err.message }, 500);
    }
    return true;
  }

  // GET /api/csf/tesseract/status — current tesseract info without running anything
  if (req.method === "GET" && url.pathname === "/api/csf/tesseract/status") {
    if (!fs.existsSync(TESSERACT_MANIFEST)) {
      sendJson(res, { exists: false });
      return true;
    }
    const manifest = JSON.parse(fs.readFileSync(TESSERACT_MANIFEST, "utf-8"));
    const csfPath = path.resolve(__dirname, "../../../data/tesseract/research-pool.csf");
    const stat = fs.existsSync(csfPath) ? fs.statSync(csfPath) : null;
    sendJson(res, {
      exists: true,
      manifest,
      csfSize: stat ? stat.size : null,
      csfModified: stat ? stat.mtime.toISOString() : null,
    });
    return true;
  }

  return false;
};
