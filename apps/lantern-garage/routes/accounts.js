/**
 * accounts.js — Staff account-support API (admin + tech_support).
 *
 * Powers accounts.html: view every account, configure roles, and fix multi-auth /
 * password issues. Every path is gated by auth-middleware.isStaff (admin OR
 * tech_support, or the local-owner bypass). Two capabilities are ADMIN-ONLY, not
 * tech_support: granting/removing the admin role, and unlinking a provider (both
 * are privilege- or lockout-sensitive).
 *
 *   GET  /api/accounts                  → { accounts[], viewer }
 *   POST /api/accounts/role             → { id, role }         set a role
 *   POST /api/accounts/reconcile        → { id }               re-apply owner/admin override monotonically
 *   POST /api/accounts/reset-password   → { id }               set a temp password, return it for the operator to relay
 *   POST /api/accounts/unlink           → { id, provider }     (admin only) remove a linked identity
 *
 * Every mutation appends a line to data/profiles/account-admin-audit.jsonl.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  listProfiles,
  getProfile,
  setUserRole,
  unlinkIdentity,
  setLocalPassword,
} = require("../lib/user-profiles");
const { profileHasAdminOverride } = require("../lib/auth-providers");
const { higherRole, isStaffRole, ROLE_HIERARCHY } = require("../lib/role-hierarchy");
const { isStaff, isAdmin } = require("../lib/auth-middleware");
const { getSessionUser, getSessionUserId } = require("../lib/session-identity");

const AUDIT_LOG = path.join(process.cwd(), "data", "profiles", "account-admin-audit.jsonl");

// Roles an operator may assign from the console. `founder` is a legacy alias and is
// intentionally omitted from the picker (deep_dreamer is its canonical name).
const ASSIGNABLE_ROLES = ["guest", "supporter", "deep_dreamer", "tech_support", "admin"];

function actorOf(req) {
  return getSessionUserId(req) || "local-owner";
}

function audit(req, action, targetId, detail) {
  try {
    fs.appendFileSync(
      AUDIT_LOG,
      JSON.stringify({ ts: new Date().toISOString(), actor: actorOf(req), action, targetId, detail: detail || null }) + "\n"
    );
  } catch (_) { /* audit is best-effort; never block the fix */ }
}

/** A short, human-relayable temporary password (no ambiguous chars). */
function tempPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(14);
  let out = "";
  for (let i = 0; i < 14; i++) out += alphabet[bytes[i] % alphabet.length];
  return out.slice(0, 5) + "-" + out.slice(5, 10) + "-" + out.slice(10);
}

/** The linked sign-in methods for a profile, deduped, including a synthetic `local`. */
function providersOf(p) {
  const out = [];
  const seen = new Set();
  for (const i of p.identities || []) {
    const key = `${i.provider}:${i.providerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider: i.provider, providerId: String(i.providerId), emailVerified: i.emailVerified === true });
  }
  // A local password is a login method even without an explicit `local` identity row.
  if (p.hasPassword && !out.some((x) => x.provider === "local")) {
    out.push({ provider: "local", providerId: p.email || "", emailVerified: p.emailVerified === true });
  }
  return out;
}

/** Derive the actionable auth-health issues for one profile. */
function issuesOf(p, providers) {
  const issues = [];
  // The exact class of bug we just fixed: an owner/admin override is present on a
  // linked identity but the stored role never got it. One-click reconcile fixes it.
  if (profileHasAdminOverride(p) && p.role !== "admin") {
    issues.push({ code: "admin_override_not_applied", severity: "high", label: "Owner override not applied", fix: "reconcile" });
  }
  const loginMethods = providers.length;
  if (loginMethods === 0) {
    issues.push({ code: "no_login_method", severity: "high", label: "No sign-in method", fix: "reset_password" });
  }
  if (!p.hasPassword) {
    issues.push({ code: "no_password", severity: "low", label: "No password set", fix: "reset_password" });
  }
  if (p.emailVerified !== true) {
    issues.push({ code: "email_unverified", severity: "low", label: "Email unverified", fix: null });
  }
  return issues;
}

/** Shape one profile for the table (never leaks the credential — listProfiles keeps it, so strip). */
function toAccountView(p) {
  const hasPassword = !!p.credential;
  const view = {
    id: p.id,
    name: p.name || "",
    email: p.email || "",
    emailVerified: p.emailVerified === true,
    role: p.role || "guest",
    tier: p.tier || null,
    hasPassword,
    createdAt: (p.metadata && p.metadata.createdAt) || null,
  };
  view.providers = providersOf({ ...p, hasPassword });
  view.issues = issuesOf({ ...p, hasPassword }, view.providers);
  return view;
}

module.exports = async function accountsRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody } = deps;
  const pathname = url.pathname;
  const method = req.method;

  if (!pathname.startsWith("/api/accounts")) return false;

  // ── Staff gate (admin OR tech_support, or local owner) ──────────────────────
  if (!isStaff(req)) {
    sendJson(res, { error: "Staff access required (admin or tech_support)." }, 403);
    return true;
  }

  const viewerAdmin = isAdmin(req);
  const viewer = {
    role: getSessionUser(req)?.role || (viewerAdmin ? "admin" : "tech_support"),
    isAdmin: viewerAdmin,
    canUnlink: viewerAdmin,
    canGrantAdmin: viewerAdmin,
    assignableRoles: ASSIGNABLE_ROLES,
  };

  // GET /api/accounts — the whole table.
  if (method === "GET" && pathname === "/api/accounts") {
    const accounts = listProfiles()
      .filter((p) => !p.deleted)
      .map(toAccountView)
      .sort((a, b) => (a.email || a.id).localeCompare(b.email || b.id));
    sendJson(res, { accounts, viewer });
    return true;
  }

  // All remaining routes mutate — parse the JSON body once.
  let body = {};
  if (method === "POST") {
    try { body = JSON.parse((await collectRequestBody(req)) || "{}"); }
    catch { sendJson(res, { error: "invalid_json" }, 400); return true; }
  }
  const target = body.id ? getProfile(body.id) : null;
  const targetNeeded = ["/api/accounts/role", "/api/accounts/reconcile", "/api/accounts/reset-password", "/api/accounts/unlink"];
  if (targetNeeded.includes(pathname)) {
    if (!body.id) { sendJson(res, { error: "id is required" }, 400); return true; }
    if (!target) { sendJson(res, { error: "account_not_found", id: body.id }, 404); return true; }
  }

  // POST /api/accounts/role — set a role.
  if (method === "POST" && pathname === "/api/accounts/role") {
    const role = String(body.role || "");
    if (!Object.prototype.hasOwnProperty.call(ROLE_HIERARCHY, role) || !ASSIGNABLE_ROLES.includes(role)) {
      sendJson(res, { error: "invalid_role", role }, 400);
      return true;
    }
    // Admin is privilege-sensitive: only an admin may grant it, remove it, or change
    // an existing admin's role. tech_support can manage non-admin tiers only.
    const touchesAdmin = role === "admin" || target.role === "admin";
    if (touchesAdmin && !viewerAdmin) {
      sendJson(res, { error: "admin_role_requires_admin", detail: "Only an admin can grant or change the admin role." }, 403);
      return true;
    }
    const updated = setUserRole(target.id, role);
    audit(req, "set_role", target.id, { from: target.role, to: role });
    sendJson(res, { ok: true, account: toAccountView(updated) });
    return true;
  }

  // POST /api/accounts/reconcile — re-apply the owner/admin override monotonically.
  // Server-side we can only re-derive from the account's linked identities (admin
  // override); live Patreon-tier resolution needs the user's own token, so a tier
  // refresh still requires them to sign in with Patreon. This fixes the common
  // "owner shows as Free" case one-click.
  if (method === "POST" && pathname === "/api/accounts/reconcile") {
    let role = target.role || "guest";
    if (profileHasAdminOverride(target)) role = higherRole(role, "admin");
    if (role === target.role) {
      sendJson(res, { ok: true, changed: false, account: toAccountView(target) });
      return true;
    }
    // Reconcile can elevate to admin — that's the whole point for the owner — so it is
    // allowed for tech_support ONLY when the elevation is driven by a hard override id
    // (not an arbitrary grant). The override check above is that guarantee.
    const updated = setUserRole(target.id, role);
    audit(req, "reconcile_role", target.id, { from: target.role, to: role, reason: "admin_override" });
    sendJson(res, { ok: true, changed: true, account: toAccountView(updated) });
    return true;
  }

  // POST /api/accounts/reset-password — set a temp password and return it to relay.
  if (method === "POST" && pathname === "/api/accounts/reset-password") {
    const pw = tempPassword();
    setLocalPassword(target.id, pw);
    audit(req, "reset_password", target.id, { method: "temp_password" });
    sendJson(res, { ok: true, tempPassword: pw, account: toAccountView(getProfile(target.id)) });
    return true;
  }

  // POST /api/accounts/unlink — remove a linked identity (ADMIN ONLY).
  if (method === "POST" && pathname === "/api/accounts/unlink") {
    if (!viewerAdmin) {
      sendJson(res, { error: "unlink_requires_admin" }, 403);
      return true;
    }
    const provider = String(body.provider || "");
    if (!provider) { sendJson(res, { error: "provider is required" }, 400); return true; }
    const result = unlinkIdentity(target.id, provider);
    if (result.error) {
      const code = result.error === "last_login_method" ? 409 : 400;
      sendJson(res, { error: result.error }, code);
      return true;
    }
    audit(req, "unlink_provider", target.id, { provider });
    sendJson(res, { ok: true, account: toAccountView(result.profile) });
    return true;
  }

  sendJson(res, { error: "Not found" }, 404);
  return true;
};
