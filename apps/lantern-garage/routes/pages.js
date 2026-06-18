/**
 * Protected page routes with server-side role checking.
 * No client-side auth overlay - clean server-side redirects.
 */

const path = require("path");
const fs = require("fs");
const { requireAuth, requireRole } = require("../lib/auth-middleware");

// Public pages — no auth required
const PUBLIC_PAGES = {
  "/auth.html":           "auth.html",
  "/auth":                "auth.html",
  "/":                    "index.html",
  "/index.html":          "index.html",
  "/explore.html":        "explore.html",
  "/knowledgecenter.html":"knowledgecenter.html",
};

// Protected pages — { file, role } where role is minimum required
const PROTECTED_PAGES = {
  "/dream-chat.html":     { file: "dream-chat.html",        role: "guest" },
  "/profile.html":        { file: "profile.html",           role: "guest" },
  "/crypto-dashboard.html":{ file: "crypto-dashboard.html", role: "guest" },
  "/create.html":         { file: "create.html",            role: "founder" },
  "/trader-dashboard.html":{ file: "trader-dashboard.html", role: "admin" },
  "/kalshi-terminal.html":{ file: "kalshi-terminal.html",   role: "admin" },
};

module.exports = async function pagesRoute(req, res, url, deps) {
  const pathname = url.pathname;

  if (!pathname.match(/\.html$/) && pathname !== "/") return false;
  if (res.headersSent) return true;

  // Public — serve directly
  if (PUBLIC_PAGES[pathname]) {
    const filePath = path.join(deps.publicRoot, PUBLIC_PAGES[pathname]);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(filePath, "utf-8"));
      return true;
    }
  }

  // Explicitly protected pages (role-specific)
  const page = PROTECTED_PAGES[pathname];
  if (page) {
    if (!requireAuth(req, res)) return true;
    if (!requireRole(req, res, page.role)) return true;

    const filePath = path.join(deps.publicRoot, page.file);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(filePath, "utf-8"));
      return true;
    }
  }

  // Catch-all: any other .html page not explicitly listed is auth-gated
  if (pathname.match(/\.html$/)) {
    const filePath = path.join(deps.publicRoot, pathname.slice(1));
    if (fs.existsSync(filePath)) {
      if (!requireAuth(req, res)) return true;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(filePath, "utf-8"));
      return true;
    }
  }

  return false;
};
