/**
 * Protected page routes with server-side role checking.
 * No client-side auth overlay - clean server-side redirects.
 */

const path = require("path");
const fs = require("fs");
const { requireAuth, requireRole, requireEntitlement } = require("../lib/auth-middleware");

// Public pages — no auth required
const PUBLIC_PAGES = {
  "/auth.html":           "auth.html",
  "/auth":                "auth.html",
  "/":                    "index.html",
  "/index.html":          "index.html",
  "/explore.html":        "explore.html",
  "/knowledgecenter.html":"knowledgecenter.html",
  // Primary interface: the chat must be reachable without a Patreon login so the
  // "no account needed" promise holds (#739). dream-chat.html handles the guest
  // session client-side (defaults to { authenticated:false, role:"guest" }).
  "/dream-chat.html":     "dream-chat.html",
};

// Protected pages — { file, role } where role is minimum required, OR
// { file, entitlement } where a per-feature entitlement is required (admins pass
// implicitly). Trade pages use the "trade" entitlement so a paid tier such as
// Deep Dreamer (deep_dreamer) does NOT get trading access unless explicitly granted.
const PROTECTED_PAGES = {
  "/profile.html":        { file: "profile.html",           role: "guest" },
  "/crypto-dashboard.html":{ file: "crypto-dashboard.html", role: "guest" },
  "/create.html":         { file: "create.html",            role: "deep_dreamer" },
  "/trading.html":        { file: "trading.html",           entitlement: "trade" },
  "/trading-news.html":   { file: "trading-news.html",      entitlement: "trade" },
  "/trader-dashboard.html":{ file: "trader-dashboard.html", entitlement: "trade" },
  "/kalshi-terminal.html":{ file: "kalshi-terminal.html",   entitlement: "trade" },
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
    if (page.entitlement) {
      if (!requireEntitlement(req, res, page.entitlement)) return true;
    } else if (!requireRole(req, res, page.role)) {
      return true;
    }

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
