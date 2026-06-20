/**
 * Protected page routes with server-side role checking.
 * No client-side auth overlay - clean server-side redirects.
 */

const path = require("path");
const fs = require("fs");
const { requireAuth, requireRole, requireEntitlement, isAdmin } = require("../lib/auth-middleware");
const { isPageDisabled } = require("../lib/feature-flags");

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
  // Admin control surface for feature flags + navigation visibility.
  "/admin-flags.html":    { file: "admin-flags.html",       role: "admin" },
};

// A nav page an admin flagged "disabled" is blocked for everyone except admins
// (who keep preview access). `hidden`-only pages are NOT blocked here — hiding
// merely drops the nav link; the page stays directly reachable.
function renderDisabledPage(pathname) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/css/site.css"><title>Page unavailable</title>
<style>body{display:flex;min-height:90vh;align-items:center;justify-content:center;
font-family:system-ui,sans-serif;color:var(--text,#e5e7eb);background:var(--bg,#0a0e17)}
.box{text-align:center;max-width:420px;padding:32px}.box h1{font-size:1.4rem;margin:0 0 8px}
.box p{color:var(--muted,#9ca3af);line-height:1.5}.box a{color:var(--accent,#06b6d4)}</style>
</head><body><div class="box"><h1>This page is currently unavailable</h1>
<p>An administrator has temporarily disabled <code>${pathname}</code>.</p>
<p><a href="/">Return home</a></p></div></body></html>`;
}

module.exports = async function pagesRoute(req, res, url, deps) {
  const pathname = url.pathname;

  if (!pathname.match(/\.html$/) && pathname !== "/") return false;
  if (res.headersSent) return true;

  // Admin kill-switch: a nav page flagged "disabled" is blocked for non-admins.
  if (isPageDisabled(pathname) && !isAdmin(req)) {
    res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderDisabledPage(pathname));
    return true;
  }

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
