/**
 * admin-traction.js — admin-only traction / adoption API.
 *
 * GET /api/admin/traction → the AARRR adoption snapshot (real vs test accounts,
 * activation/retention/revenue, per-user table). Admin role required — this exposes
 * user emails and account data, so it is gated exactly like the other admin surfaces
 * (see routes/profiles.js, routes/admin-flags.js).
 */

"use strict";

const { computeTraction } = require("../lib/metrics");
const { isAdmin } = require("../lib/auth-middleware");

module.exports = async function adminTractionRoute(req, res, url) {
  if (req.method !== "GET" || url.pathname !== "/api/admin/traction") return false;

  // isAdmin honors both an admin session role AND the loopback local-admin bypass —
  // the same gate routes/pages.js uses to protect traction.html itself.
  if (!isAdmin(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Admin only" }));
    return true;
  }

  try {
    const snapshot = computeTraction();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(snapshot));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
  return true;
};
