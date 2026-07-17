/**
 * Protected page routes with server-side role checking.
 * No client-side auth overlay - clean server-side redirects.
 */

const path = require("path");
const fs = require("fs");
const { requireAuth, requireRole, requireEntitlement, hasEntitlement, meetsRole, isAdmin, isStaff } = require("../lib/auth-middleware");
const { isPageDisabled } = require("../lib/feature-flags");
const { getSessionUser } = require("../lib/session-identity");
const { parseCookies, isOperatorRequest } = require("../lib/request-auth");

// The public "front door" — the home page. A brand-new visitor must make an entry
// choice (sign in as a USER, or "Continue without an account" as a GUEST) before
// the site opens. Both the apex and the explicit index path count as home so the
// gate can't be sidestepped by requesting /index.html directly.
const HOME_PATHS = new Set(["/", "/index.html"]);

/**
 * Has this request already entered as a user OR a guest? True when:
 *   • an authenticated session exists (a signed-in user, incl. test-auth), OR
 *   • the guest-choice cookie is present (they clicked "Continue without an
 *     account" on /auth.html — the ln_guest=1 marker set there), OR
 *   • it is a trusted local/operator request (the desktop app + the local operator
 *     dashboard reach Node over an un-proxied loopback socket; external tunnelled
 *     visitors carry proxy headers and never qualify — see lib/request-auth).
 * A visitor with none of these is an unknown first-timer → bounce to /auth.html to
 * choose. Kept in lock-step with the client first-visit gate in js/auth-gate.js.
 */
function hasEnteredAsUserOrGuest(req) {
  if (getSessionUser(req)?.id) return true;
  if (parseCookies(req).ln_guest === "1") return true;
  if (isOperatorRequest(req)) return true;
  return false;
}

// Public pages — no auth required
const PUBLIC_PAGES = {
  "/auth.html":           "auth.html",
  "/auth":                "auth.html",
  // Terms of Service + EULA — MUST be public so a signed-out user can read it
  // before agreeing during account creation (linked from auth.html).
  "/terms.html":          "terms.html",
  // Pricing is a conversion page — it MUST be visible to signed-out prospects, who
  // are exactly its audience. Auth-gating it bounced them to sign-in and dropped the
  // destination (#2610). The Stripe checkout buttons still require auth server-side.
  "/pricing.html":        "pricing.html",
  "/reset-password.html": "reset-password.html",
  "/":                    "index.html",
  "/index.html":          "index.html",
  "/explore.html":        "explore.html",
  "/knowledgecenter.html":"knowledgecenter.html",
  "/ibkr-setup-guide.html":"ibkr-setup-guide.html", // IBKR connect how-to (public help)
  "/ibkr-connect.html":   "ibkr-connect.html",       // redirect → /orchestration.html#broker
  // Primary interface: the chat must be reachable without a Patreon login so the
  // "no account needed" promise holds (#739). dream-chat.html handles the guest
  // session client-side (defaults to { authenticated:false, role:"guest" }).
  "/dream-chat.html":     "dream-chat.html",
  // The stock trader is served to everyone: entitled users get the full terminal,
  // guests get the same page in read-only "guest mode" (trading actions hidden
  // client-side; the trade-gated data endpoints stay blocked server-side by
  // tradeApiGuard). A single page = a true 1:1 view, no duplicated chart layer.
  "/stock-trader.html":   "stock-trader.html",
  // Public read-only spectator view of the demo (paper) account (#2548): a
  // logged-out visitor can watch it trade live. No order controls exist on the
  // page and its feed endpoint is a sanitized public read (PUBLIC_TRADING_READS).
  "/demo.html":           "demo.html",
  // Orchestration is a public READ-ONLY fleet view. Guests/non-admins see status
  // panels only; the control endpoints are admin-gated in server.js
  // (orchestrationControlGuard) and the sensitive panels are hidden client-side
  // (auth-gate.js sets body.is-guest). Same pattern as the guest-mode trader.
  "/orchestration.html":  "orchestration.html",
};

// Protected pages — { file, role } where role is minimum required, OR
// { file, entitlement } where a per-feature entitlement is required (admins pass
// implicitly). Trade pages use the "trade" entitlement so a paid tier such as
// Pro (deep_dreamer) does NOT get trading access unless explicitly granted.
const PROTECTED_PAGES = {
  "/profile.html":        { file: "profile.html",           role: "guest" },
  "/create.html":         { file: "create.html",            role: "deep_dreamer" },
  // /trading.html retired → 302s to /stock-trader.html (see REDIRECTS, #2488).
  "/kalshi-terminal.html":{ file: "kalshi-terminal.html",   entitlement: "trade" },
  // Admin control surface for feature flags + navigation visibility.
  "/admin-flags.html":    { file: "admin-flags.html",       role: "admin" },
  // Account-support console: view/configure/fix multi-auth + password issues.
  // Restricted to STAFF (admin OR tech_support) via an explicit set check, not a
  // hierarchy level — see auth-middleware.requireStaff.
  "/accounts.html":       { file: "accounts.html",          staff: true },
  "/accounts":            { file: "accounts.html",          staff: true },
};

// A nav page an admin flagged "disabled" is blocked for everyone except admins
// (who keep preview access). `hidden`-only pages are NOT blocked here — hiding
// merely drops the nav link; the page stays directly reachable.
// Permanent redirects for surfaces that MOVED. Kept server-side so old links /
// bookmarks don't 404, without carrying a dead stub .html file in public/ (a
// redirect is not a public surface — it must not inflate the Σ₀ surface count).
const REDIRECTS = {
  "/ibkr-connect.html": "/orchestration.html#broker", // broker connect folded into Settings → Broker (#ADR-0022)
  "/trading.html": "/stock-trader.html", // legacy dashboard retired → live stock trader (#2488)
  "/upgrade-lab.html": "/pricing.html",  // orphaned off-brand upgrade workbench retired → pricing (#2473)
  "/api-keys-settings.html": "/settings.html", // single-column key page retired → tabbed two-column settings
};

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

// A signed-in user who lacks the tier/entitlement for a page gets a friendly HTML
// "unlock" page instead of a raw JSON 403 filling the browser (a first-time-user
// papercut). Unauthenticated users are still redirected to login upstream.
// Canonical tier display names for the CURRENTLY SOLD ladder: Free / $20 Pro /
// $200 Pilot. The $5 "Member" tier is RETIRED — its `supporter` role is retained
// for legacy patrons only and now sits at the Free floor (see plan-matrix
// ROLE_TO_PLAN), so a (latent, #2644) supporter-level gate names "Pro", the
// cheapest plan a paying upgrade would buy — never the dead "Member" label.
// `admin` is a STAFF role, not a purchasable tier, so it's handled below as a staff
// gate (no "See plans") rather than being named as a buyable tier.
const TIER_LABEL = { supporter: "Pro", deep_dreamer: "Pro", pilot: "Pilot" };
// Friendly name for the tier a per-feature ENTITLEMENT requires (used when a page
// gates on an entitlement rather than a role).
const ENTITLEMENT_TIER = { trade: "Pro", pro: "Pro", ai_trader: "Pilot" };
const STAFF_ROLES = new Set(["admin", "tech_support"]);
function renderUpgradePage(page) {
  const isStaff = page.staff === true || STAFF_ROLES.has(page.role);
  const need = page.entitlement ? `the ${ENTITLEMENT_TIER[page.entitlement] || "a higher"} tier`
    : page.role ? `the ${TIER_LABEL[page.role] || page.role} tier` : "a higher tier";
  const heading = isStaff ? "Staff access required" : "This feature needs an upgrade";
  // Staff pages aren't for sale — never show a buy-a-plan CTA on them (#2470).
  const message = isStaff
    ? `This page is limited to unisona staff. If you think you should have access, contact the team.`
    : `Unlocking this feature requires <strong>${need}</strong>. Your current plan doesn't include it yet.`;
  // The upgrade page is only reachable signed-in (signed-out visitors are
  // redirected to sign-in before any tier check, #2471) — so the extra CTA is
  // "switch account", covering the user whose OTHER account holds the tier.
  const actions = isStaff
    ? `<a class="btn ghost" href="/">Return home</a>`
    : `<a class="btn primary" href="/pricing.html">See plans</a><a class="btn ghost" href="/auth.html">Sign in with another account</a><a class="btn ghost" href="/">Return home</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/css/site.css"><title>${isStaff ? "Staff only" : "Unlock this feature"} — unisona.ai</title>
<style>body{display:flex;min-height:90vh;align-items:center;justify-content:center;
font-family:system-ui,sans-serif;color:var(--text,#e5e7eb);background:var(--bg,#0a0e17)}
.box{text-align:center;max-width:440px;padding:32px}.box h1{font-size:1.4rem;margin:0 0 8px}
.box p{color:var(--muted,#9ca3af);line-height:1.55;margin:0 0 20px}
.row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.btn{display:inline-block;padding:10px 18px;border-radius:10px;font-weight:600;text-decoration:none}
.btn.primary{background:var(--accent,#06b6d4);color:#fff}
.btn.ghost{border:1px solid var(--border,#374151);color:var(--text,#e5e7eb)}</style>
</head><body><div class="box"><h1>${heading}</h1>
<p>${message}</p>
<div class="row">${actions}</div>
</div></body></html>`;
}

module.exports = async function pagesRoute(req, res, url, deps) {
  const pathname = url.pathname;

  if (!pathname.match(/\.html$/) && pathname !== "/") return false;
  if (res.headersSent) return true;

  // Moved surfaces: 302 to the canonical location (see REDIRECTS).
  if (REDIRECTS[pathname]) {
    res.writeHead(302, { Location: REDIRECTS[pathname] });
    res.end();
    return true;
  }

  // Admin kill-switch: a nav page flagged "disabled" is blocked for non-admins.
  if (isPageDisabled(pathname) && !isAdmin(req)) {
    res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderDisabledPage(pathname));
    return true;
  }

  // Front-door gate: the home page redirects an unknown visitor to /auth.html so
  // they choose an entry — sign in (user) or "Continue without an account" (guest).
  // Only the home path is gated (the rest of PUBLIC_PAGES stays openly reachable);
  // a chosen guest / signed-in user / local operator passes straight through.
  if (HOME_PATHS.has(pathname) && !hasEnteredAsUserOrGuest(req)) {
    res.writeHead(302, { Location: "/auth.html?returnTo=" + encodeURIComponent(pathname) });
    res.end();
    return true;
  }

  // Public — serve directly
  if (PUBLIC_PAGES[pathname]) {
    const filePath = path.join(deps.publicRoot, PUBLIC_PAGES[pathname]);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, must-revalidate" });
      res.end(require("../lib/desktop-heartbeat").injectHeartbeat(fs.readFileSync(filePath, "utf-8")));
      return true;
    }
  }

  // Explicitly protected pages (role-specific)
  const page = PROTECTED_PAGES[pathname];
  if (page) {
    if (page.staff) {
      // Staff gate: a BROWSER page must never answer with raw JSON (#2472) — the
      // old requireStaff() call wrote {"error":"Staff access required."} into the
      // tab. Signed out → sign-in with a way back; signed in but not staff → the
      // same styled gate page as every other protected page (its staff branch has
      // no buy-a-plan CTA). /api/accounts/* keeps requireStaff's JSON contract.
      if (!getSessionUser(req)?.id) {
        res.writeHead(302, { Location: "/auth.html?returnTo=" + encodeURIComponent(pathname) });
        res.end();
        return true;
      }
      if (!isStaff(req)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderUpgradePage(page));
        return true;
      }
    } else if (!getSessionUser(req)?.id) {
      // Signed out → the correct action is signing in, so send them there with a
      // way back. This must run BEFORE any tier check: letting a sessionless guest
      // fall through to meetsRole() rendered a self-contradictory "requires the
      // guest tier" upgrade wall when the auth gate is off (#2471) — requireAuth
      // returns true for everyone in that mode and never redirects.
      res.writeHead(302, { Location: "/auth.html?returnTo=" + encodeURIComponent(pathname) });
      res.end();
      return true;
    } else {
      // Authenticated but possibly under-tier: check WITHOUT emitting a raw JSON 403,
      // and render a friendly "unlock" page instead when access is short.
      const allowed = page.entitlement ? hasEntitlement(req, page.entitlement) : meetsRole(req, page.role);
      if (!allowed) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderUpgradePage(page));
        return true;
      }
    }

    const filePath = path.join(deps.publicRoot, page.file);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, must-revalidate" });
      res.end(require("../lib/desktop-heartbeat").injectHeartbeat(fs.readFileSync(filePath, "utf-8")));
      return true;
    }
  }

  // Catch-all: any other .html page not explicitly listed is auth-gated
  if (pathname.match(/\.html$/)) {
    const filePath = path.join(deps.publicRoot, pathname.slice(1));
    if (fs.existsSync(filePath)) {
      if (!requireAuth(req, res)) return true;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, must-revalidate" });
      res.end(require("../lib/desktop-heartbeat").injectHeartbeat(fs.readFileSync(filePath, "utf-8")));
      return true;
    }
  }

  return false;
};
