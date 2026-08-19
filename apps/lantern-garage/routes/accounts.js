/**
 * accounts.js — Staff account-support API (admin + tech_support).
 *
 * Powers accounts.html: view every account, configure roles, and fix multi-auth /
 * password issues. Every path is gated by auth-middleware.isStaff (admin OR
 * tech_support, or the local-owner bypass). Two capabilities are ADMIN-ONLY, not
 * tech_support: granting/removing the admin role, and unlinking a provider (both
 * are privilege- or lockout-sensitive).
 *
 *   GET  /api/accounts                  → { accounts[], archived[], viewer }
 *   POST /api/accounts/role             → { id, role, reason? }     set a role (reason REQUIRED to grant a paid tier)
 *   POST /api/accounts/reconcile        → { id }                    re-apply owner/admin override monotonically
 *   POST /api/accounts/update           → { id, name?, email? }     edit name / email (email change ⇒ admin)
 *   POST /api/accounts/set-password     → { id, password?, email? } set a password, optionally email the user
 *   POST /api/accounts/reset-password   → { id }                    set a temp password, return it for the operator to relay
 *   POST /api/accounts/delete           → { id }                    (admin only) archive a read-only copy, then tombstone
 *   POST /api/accounts/unlink           → { id, provider }          (admin only) remove a linked identity
 *
 * Every mutation appends a line to data/profiles/account-admin-audit.jsonl.
 * Deleted accounts are snapshotted to data/profiles/archive.jsonl first.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { dataPath } = require("../lib/app-paths");
const crypto = require("crypto");
const { destroyUserSessions } = require("../lib/session-file-store");

// Where the session store persists its files (mirrors server.js). A privileged role
// change invalidates the target's live sessions here so revoked access takes effect
// immediately, not at the next natural logout (#2627).
const SESSION_DIR = dataPath("sessions");

const {
  listProfiles,
  getProfile,
  setUserRole,
  unlinkIdentity,
  setLocalPassword,
  updateProfile,
  deleteProfile,
  getProfileByEmail,
  publicProfile,
} = require("../lib/user-profiles");
const { profileHasAdminOverride } = require("../lib/auth-providers");
const { higherRole, isStaffRole, ROLE_HIERARCHY } = require("../lib/role-hierarchy");
const { isStaff, isAdmin } = require("../lib/auth-middleware");
const { getSessionUser, getSessionUserId } = require("../lib/session-identity");
const { sendMailBounded, smtpConfigured } = require("../lib/mailer");

const AUDIT_LOG = dataPath("profiles", "account-admin-audit.jsonl");
// Read-only archive of deleted accounts — a durable snapshot appended before the
// profile is tombstoned, so a "delete" is recoverable/auditable, never data loss.
const ARCHIVE_LOG = dataPath("profiles", "archive.jsonl");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

// Roles an operator may assign from the console. `founder` is a legacy alias and is
// intentionally omitted from the picker (deep_dreamer is its canonical name).
const ASSIGNABLE_ROLES = ["guest", "supporter", "deep_dreamer", "pilot", "tech_support", "admin"];

// Roles that carry a PURCHASABLE plan (see lib/plan-matrix ROLE_TO_PLAN). Granting one
// by hand is a comp and must be justified + recorded; staff roles are not comps, and
// guest/supporter sit at the Free floor so they need no explanation.
const PAID_ROLES = ["deep_dreamer", "pilot"];

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
    archived: p.deleted === true,
    archivedAt: p.deletedAt || null,
    createdAt: (p.metadata && p.metadata.createdAt) || null,
    // Provenance for a hand-granted paid tier (#3095) — null for purchased or free
    // accounts. Surfaced so an operator can tell a comp from a paid subscription at a
    // glance, which is the whole point of recording it.
    manualGrant: p.manualGrant || null,
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

  // GET /api/accounts — the whole table. `archived` carries the read-only deleted
  // accounts so the UI can show them behind a "Show archived" toggle.
  if (method === "GET" && pathname === "/api/accounts") {
    const all = listProfiles();
    const byEmail = (a, b) => (a.email || a.id).localeCompare(b.email || b.id);
    const accounts = all.filter((p) => !p.deleted).map(toAccountView).sort(byEmail);
    const archived = all.filter((p) => p.deleted).map(toAccountView).sort(byEmail);
    sendJson(res, { accounts, archived, viewer });
    return true;
  }

  // All remaining routes mutate — parse the JSON body once.
  let body = {};
  if (method === "POST") {
    try { body = JSON.parse((await collectRequestBody(req)) || "{}"); }
    catch { sendJson(res, { error: "invalid_json" }, 400); return true; }
  }
  const target = body.id ? getProfile(body.id) : null;
  const targetNeeded = [
    "/api/accounts/role", "/api/accounts/reconcile", "/api/accounts/reset-password",
    "/api/accounts/unlink", "/api/accounts/update", "/api/accounts/set-password", "/api/accounts/delete",
  ];
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
    // A staff-granted paid tier must be DISTINGUISHABLE from a purchased one (#3095).
    // Without provenance, a comp is indistinguishable from a Stripe/Patreon upgrade
    // after the fact — so a later billing reconcile can't tell "this user never paid,
    // leave them alone" from "this user's subscription lapsed, downgrade them", and
    // silently revokes a comp the operator meant to keep.
    const reason = String(body.reason || "").trim().slice(0, 200);
    const becomesPaid = PAID_ROLES.includes(role);
    if (becomesPaid && !reason) {
      // Required, not optional: an unexplained comp is exactly the record that is
      // useless six months later when someone asks why this account is free.
      sendJson(res, { error: "reason_required", detail: "Granting a paid tier by hand needs a reason (it is recorded on the account)." }, 400);
      return true;
    }
    const updated = setUserRole(target.id, role);
    // Stamp or clear the grant. Dropping back to a non-paid role clears it, so a
    // revoked comp doesn't leave a stale record claiming the account is comped.
    updateProfile(target.id, {
      manualGrant: becomesPaid
        ? { role, reason, by: actorOf(req), at: new Date().toISOString() }
        : null,
    });
    // Invalidate the target's live sessions so a revoked/downgraded role takes effect
    // now — otherwise a demoted admin keeps isAdmin/isStaff until their session expires
    // (disk-persisted across restarts), the exact gap #2627 flags. They re-auth into the
    // new role. A no-op when they have no active session.
    const killedSessions = destroyUserSessions(SESSION_DIR, target.id);
    audit(req, "set_role", target.id, { from: target.role, to: role, reason: reason || null, sessionsInvalidated: killedSessions });
    sendJson(res, { ok: true, account: toAccountView(getProfile(target.id)), sessionsInvalidated: killedSessions });
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

  // POST /api/accounts/update — edit the account's display name and/or email.
  // Changing the email or touching an ADMIN account requires admin (identity-
  // sensitive). A new email is marked unverified until the user re-confirms.
  if (method === "POST" && pathname === "/api/accounts/update") {
    const updates = {};
    if (typeof body.name === "string") updates.name = body.name.trim().slice(0, 120);
    const emailChanging = typeof body.email === "string" && body.email.trim().toLowerCase() !== (target.email || "").toLowerCase();
    if (emailChanging) {
      const email = body.email.trim();
      if (!EMAIL_RE.test(email)) { sendJson(res, { error: "invalid_email" }, 400); return true; }
      const clash = getProfileByEmail(email);
      if (clash && clash.id !== target.id) { sendJson(res, { error: "email_taken" }, 409); return true; }
      updates.email = email;
      updates.emailVerified = false; // a changed address is unverified until reconfirmed
    }
    // Editing an admin account, or changing an email, is admin-only.
    if ((target.role === "admin" || emailChanging) && !viewerAdmin) {
      sendJson(res, { error: "edit_requires_admin", detail: "Editing an admin account or changing an email requires admin." }, 403);
      return true;
    }
    if (!Object.keys(updates).length) { sendJson(res, { error: "nothing_to_update" }, 400); return true; }
    const updated = updateProfile(target.id, updates);
    audit(req, "update_profile", target.id, { fields: Object.keys(updates), email: updates.email || undefined });
    sendJson(res, { ok: true, account: toAccountView(updated) });
    return true;
  }

  // POST /api/accounts/set-password — set a password (provided or generated) and,
  // optionally, email it to the user. Setting a password on an admin account
  // requires admin. { id, password?, email?:bool }
  if (method === "POST" && pathname === "/api/accounts/set-password") {
    if (target.role === "admin" && !viewerAdmin) {
      sendJson(res, { error: "set_password_requires_admin" }, 403);
      return true;
    }
    let pw = typeof body.password === "string" && body.password ? body.password : null;
    const generated = !pw;
    if (pw && pw.length < MIN_PASSWORD) {
      sendJson(res, { error: "weak_password", detail: `min ${MIN_PASSWORD} chars` }, 400);
      return true;
    }
    if (!pw) pw = tempPassword();
    setLocalPassword(target.id, pw);
    let emailed = false, emailPending = false, emailTransport = null;
    if (body.email === true) {
      if (!target.email) { sendJson(res, { error: "no_email_on_account" }, 400); return true; }
      const html =
        `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;color:#0f172a">` +
        `<h2 style="color:#06b6d4">unisona.ai</h2><h3>Your password was set by an administrator</h3>` +
        `<p>Hi ${target.name || "there"}, an administrator set a new password for your unisona.ai account.</p>` +
        `<p>Temporary password: <code style="background:#f1f5f9;padding:4px 8px;border-radius:6px;font-size:15px">${pw}</code></p>` +
        `<p><strong>Please sign in and change it right away.</strong></p></div>`;
      // Bounded wait (#3094): the password is ALREADY set above, so a slow provider
      // must not hang the admin's form. `emailed` stays strictly true-on-confirmed —
      // a pending send reports emailPending, never a fabricated success, because the
      // operator uses this to decide whether to relay the password by hand.
      const r = await sendMailBounded({ to: target.email, subject: "Your unisona.ai password was reset", html, text: `Your new temporary password: ${pw}. Please sign in and change it.` });
      emailed = !!(r && r.ok);
      emailPending = !!(r && r.pending);
      emailTransport = r && r.transport;
    }
    audit(req, "set_password", target.id, { generated, emailed });
    // Return the plaintext ONLY when generated (operator needs to relay it); when the
    // operator typed it, they already have it.
    sendJson(res, { ok: true, tempPassword: generated ? pw : undefined, emailed, emailPending, emailTransport, smtp: smtpConfigured(), account: toAccountView(getProfile(target.id)) });
    return true;
  }

  // POST /api/accounts/delete — archive a read-only copy, then tombstone (ADMIN ONLY).
  if (method === "POST" && pathname === "/api/accounts/delete") {
    if (!viewerAdmin) { sendJson(res, { error: "delete_requires_admin" }, 403); return true; }
    if (target.id === getSessionUserId(req)) { sendJson(res, { error: "cannot_delete_self" }, 400); return true; }
    // Durable read-only snapshot BEFORE tombstoning (credential stripped).
    try {
      fs.appendFileSync(
        ARCHIVE_LOG,
        JSON.stringify({ archivedAt: new Date().toISOString(), archivedBy: actorOf(req), profile: publicProfile(target) }) + "\n"
      );
    } catch (_) { /* best-effort archive; deletion still proceeds via tombstone */ }
    deleteProfile(target.id); // tombstone: { deleted:true, deletedAt } appended to index
    audit(req, "delete_account", target.id, { email: target.email || null, archived: true });
    sendJson(res, { ok: true, id: target.id });
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
