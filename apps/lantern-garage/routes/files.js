// Repo file serving and markdown viewer
module.exports = async function fileRoutes(req, res, url, deps) {
  const { fs, path, sendJson, sendFile, sendHtml, repoRoot, renderMarkdownDocument } = deps;

  // Default-deny: /repo only serves these document/asset extensions. This closes the
  // whole class of leaks (.git/*, dotfiles, .js/.py/.json source, data/ingest|reports)
  // by extension instead of enumerating deny patterns forever. #868
  const ALLOWED_EXT = new Set([
    ".md", ".txt", ".pdf", ".tex",
    ".png", ".svg", ".jpg", ".jpeg", ".gif", ".webp",
  ]);

  const DENY_PATTERNS = [
    /(^|[\/\\])\.[^\/\\]/,                       // any leading-dot segment: .git, .env, .gitignore, …
    /^data[\/\\](private|dream_journal|dreamer|conversations|ingest|reports)/, // PII pools (allowed-ext PDFs too)
    /^logs[\/\\]/,
    /\.(jsonl|csf)$/i,
    /^secrets[\/\\]/,
  ];

  function isPathAllowed(relativePath) {
    // Allowlist by extension first — anything without an approved extension
    // (.git/HEAD, .gitignore, server.js, *.json, pack files, …) is denied.
    const ext = path.extname(relativePath).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return false;
    // DENY_PATTERNS stays as defense-in-depth (e.g. a .txt under secrets/).
    return !DENY_PATTERNS.some(p => p.test(relativePath));
  }

  function checkBoundary(targetPath, relativePath) {
    const rel = path.relative(repoRoot, targetPath);
    if (path.isAbsolute(rel) || rel.startsWith("..")) return false;
    return isPathAllowed(rel);
  }

  if (url.pathname.startsWith("/repo/")) {
    const relative = decodeURIComponent(url.pathname.replace(/^\/repo\//, ""));
    const target = path.resolve(repoRoot, relative);
    if (!checkBoundary(target, relative)) { sendJson(res, { error: "forbidden" }, 403); return true; }
    if (!fs.existsSync(target)) { sendJson(res, { error: "not_found" }, 404); return true; }
    const ext = path.extname(target).toLowerCase();
    if (ext === ".md" || ext === ".txt") {
      sendHtml(res, renderMarkdownDocument(fs.readFileSync(target, "utf8"), relative));
      return true;
    }
    sendFile(res, target);
    return true;
  }
  if (url.pathname === "/view") {
    const relative = decodeURIComponent(url.searchParams.get("path") || "");
    const target = path.resolve(repoRoot, relative);
    if (!relative || !checkBoundary(target, relative)) { sendJson(res, { error: "forbidden" }, 403); return true; }
    if (!fs.existsSync(target)) { sendJson(res, { error: "not_found" }, 404); return true; }
    if (path.extname(target).toLowerCase() === ".md") {
      sendHtml(res, renderMarkdownDocument(fs.readFileSync(target, "utf8"), relative));
      return true;
    }
    sendFile(res, target);
    return true;
  }
};
