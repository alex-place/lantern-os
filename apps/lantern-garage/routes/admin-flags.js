/**
 * admin-flags.js — Admin feature-flag + navigation-visibility API.
 *
 * Public (read-only — consumed by the global header / any page):
 *   GET    /api/flags            → { flags: { key: enabledBool } }
 *   GET    /api/nav-config       → { navigation: { path: { hidden, disabled } } }
 *
 * Admin-only (writes — gated by role "admin" or local bypass):
 *   GET    /api/admin/config     → full config (flags[] + navigation[])
 *   PUT    /api/admin/flags      → upsert a flag { key, label, description, enabled }
 *   DELETE /api/admin/flags/:key → remove a flag
 *   PUT    /api/admin/nav        → set nav override { path, hidden, disabled }
 */

"use strict";

const {
  listFlags,
  getPublicFlags,
  setFlag,
  deleteFlag,
  getNavConfig,
  getNavMap,
  setNavEntry,
} = require("../lib/feature-flags");
const { isAdmin } = require("../lib/auth-middleware");

function actorOf(req) {
  return req.session?.patreon?.id || "local-admin";
}

module.exports = async function adminFlagsRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody } = deps;
  const pathname = url.pathname;
  const method = req.method;

  // ── Public reads ──────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/flags") {
    sendJson(res, { flags: getPublicFlags() });
    return true;
  }

  if (method === "GET" && pathname === "/api/nav-config") {
    sendJson(res, { navigation: getNavMap() });
    return true;
  }

  // ── Admin surface ─────────────────────────────────────────────────────────
  const isAdminPath = pathname === "/api/admin/config"
    || pathname === "/api/admin/flags"
    || pathname.startsWith("/api/admin/flags/")
    || pathname === "/api/admin/nav";
  if (!isAdminPath) return false;

  if (!isAdmin(req)) {
    sendJson(res, { error: "Admin only" }, 403);
    return true;
  }

  // GET /api/admin/config — full config for the admin page
  if (method === "GET" && pathname === "/api/admin/config") {
    sendJson(res, { flags: listFlags(), navigation: getNavConfig() });
    return true;
  }

  // PUT /api/admin/flags — create or update a flag
  if (method === "PUT" && pathname === "/api/admin/flags") {
    try {
      const body = JSON.parse((await collectRequestBody(req)) || "{}");
      if (!body.key || !String(body.key).trim()) {
        sendJson(res, { error: "key is required" }, 400);
        return true;
      }
      const flag = setFlag(
        body.key,
        { label: body.label, description: body.description, enabled: body.enabled },
        actorOf(req)
      );
      sendJson(res, { ok: true, flag });
    } catch (e) {
      sendJson(res, { error: e.message }, 400);
    }
    return true;
  }

  // DELETE /api/admin/flags/:key — remove a flag
  if (method === "DELETE" && pathname.startsWith("/api/admin/flags/")) {
    const key = decodeURIComponent(pathname.slice("/api/admin/flags/".length));
    const removed = deleteFlag(key);
    sendJson(res, { ok: removed, key }, removed ? 200 : 404);
    return true;
  }

  // PUT /api/admin/nav — set hidden/disabled for one nav page
  if (method === "PUT" && pathname === "/api/admin/nav") {
    try {
      const body = JSON.parse((await collectRequestBody(req)) || "{}");
      if (!body.path) {
        sendJson(res, { error: "path is required" }, 400);
        return true;
      }
      const entry = setNavEntry(
        body.path,
        { hidden: body.hidden, disabled: body.disabled },
        actorOf(req)
      );
      sendJson(res, { ok: true, entry });
    } catch (e) {
      sendJson(res, { error: e.message }, 400);
    }
    return true;
  }

  // Known admin path but wrong method
  sendJson(res, { error: "Method not allowed" }, 405);
  return true;
};
