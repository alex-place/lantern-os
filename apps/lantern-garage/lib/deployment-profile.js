/**
 * deployment-profile.js — what the app IS in this deployment (ADR-0018, W4/W5).
 *
 * The one Convergence Core serves two delivery profiles (ADR-0018):
 *   - "local"  (DEFAULT) — the full desktop / single-owner app: every surface.
 *   - "cloud"  — the hosted multi-tenant web tier: ONLY the hosted subset below.
 *
 * Selection reuses the tenancy seam (lib/tenant.js) — the tenancy profile IS the
 * deployment profile, so there is one concept, not two. This module answers the
 * downstream question "is THIS surface part of the current profile?", which the
 * static catch-all (routes/surfaces.js) and the nav both gate on.
 *
 * BEHAVIOUR-PRESERVING in local: isSurfaceAllowed() returns true for everything,
 * so 4177 / 4178 / the desktop app are unchanged. The subset only bites when
 * LANTERN_TENANCY=cloud.
 */

"use strict";

const { tenancyProfile } = require("./tenant");

// The hosted web tier serves ONLY these top-level public/*.html surfaces.
// Chat + Explore + Help are the product; the rest is the account/landing shell.
// Everything NOT here (trading, creator, autowork, admin, ops, the life tools, …)
// is local-only and unreachable on a cloud instance.
const HOSTED_SURFACES = new Set([
  "index.html", // landing / home
  "dream-chat.html", // chat — the product
  "explore.html", // explore — loop demo (logged-out) / own memory (logged-in)
  "faq.html", // help / FAQ / getting-started (+ "download the desktop app")
  "auth.html", // login
  "entry.html", // post-login entry
  "profile.html", // account
  "pricing.html", // plans
  "whats-new.html", // meta
  "changelog.html", // meta
]);

/** Current deployment profile: "cloud" (hosted subset) or "local" (full app). */
function profile() {
  return tenancyProfile();
}

/** True when the hosted subset is in effect (LANTERN_TENANCY=cloud). */
function isCloud() {
  return profile() === "cloud";
}

/**
 * Is a top-level public/*.html surface served under the current profile?
 * @param {string} surfaceFile bare filename, e.g. "dream-chat.html"
 */
function isSurfaceAllowed(surfaceFile) {
  if (!isCloud()) return true; // local / desktop serves everything
  return HOSTED_SURFACES.has(surfaceFile);
}

module.exports = { profile, isCloud, isSurfaceAllowed, HOSTED_SURFACES };
