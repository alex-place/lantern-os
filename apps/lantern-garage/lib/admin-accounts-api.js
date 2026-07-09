/**
 * admin-accounts.js — support/admin account repair console.
 *
 * GET    /api/admin/accounts                  → searchable, sanitized account table
 * GET    /api/admin/accounts/:id              → sanitized account detail
 * PATCH  /api/admin/accounts/:id              → repair metadata / admin config edits
 * POST   /api/admin/accounts/:id/normalize    → de-dupe/sync provider identity rows
 * POST   /api/admin/accounts/:id/password-reset
 * POST   /api/admin/accounts/:id/resend-verification
 *
 * Access: admin and tech_support roles only. Admins may change roles, tier labels
 * and entitlements; tech support may view accounts and perform auth repair actions.
 */

"use strict";

const {
  getProfile,
  updateProfile,
  listProfiles,
  publicProfile,
} = require("./user-profiles");
const { isLocalBypass } = require("./auth-middleware");
const { getSessionUser } = require("./session-identity");
const { roleLevel, roleMeets, ROLE_HIERARCHY } = require("./role-hierarchy");
const { createToken } = require("./auth-tokens");
const { sendPasswordResetEmail, sendVerificationEmail, smtpConfigured } = require("./mailer");
const { isLoopback } = require("./request-auth");

const ACCOUNT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ADMIN_ACCOUNT_RE = /^\/api\/admin\/accounts(?:\/([^/]+)(?:\/([^/]+))?)?$/;
const VALID_PROVIDER = new Set(["local", "google", "discord", "patreon"]);

function originOf(req) {
  const host = (req.headers && req.headers.host) || "127.0.0.1";
  const proto =
    (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() ||
    (req.socket && req.socket.encrypted ? "https" : "http");
  return `${proto}://${host}`;
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}

function isSupport(req) {
  if (isLocalBypass(req)) return true;
  return roleMeets(getSessionUser(req)?.role, "tech_support");
}

function isAdmin(req) {
  if (isLocalBypass(req)) return true;
  return getSessionUser(req)?.role === "admin";
}

function deny(res, status, error, detail) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error, ...(detail ? { detail } : {}) }));
}

function latestEmail(profile) {
  return String(profile.pendingEmail || profile.email || "").trim().toLowerCase();
}

function identityKey(identity) {
  return `${identity.provider}:${String(identity.providerId)}`;
}

function normalizeIdentityRows(profile) {
  const now = new Date().toISOString();
  const identities = [];
  const seen = new Set();

  for (const raw of Array.isArray(profile.identities) ? profile.identities : []) {
    if (!raw || !VALID_PROVIDER.has(raw.provider) || raw.providerId == null) continue;
    const id = {
      provider: raw.provider,
      providerId: String(raw.providerId),
      email: raw.email || null,
      emailVerified: raw.emailVerified === true,
      linkedAt: raw.linkedAt || now,
    };
    const key = identityKey(id);
    if (seen.has(key)) continue;
    seen.add(key);
    identities.push(id);
  }

  if (profile.patreonId) {
    const id = {
      provider: "patreon",
      providerId: String(profile.patreonId),
      email: profile.email || null,
      emailVerified: false,
      linkedAt: now,
    };
    const key = identityKey(id);
    if (!seen.has(key)) {
      identities.push(id);
      seen.add(key);
    }
  }

  if (profile.discordId) {
    const id = {
      provider: "discord",
      providerId: String(profile.discordId),
      email: profile.email || null,
      emailVerified: false,
      linkedAt: now,
    };
    const key = identityKey(id);
    if (!seen.has(key)) {
      identities.push(id);
      seen.add(key);
    }
  }

  if (profile.credential && profile.email) {
    const id = {
      provider: "local",
      providerId: String(profile.email).toLowerCase(),
      email: String(profile.email).toLowerCase(),
      emailVerified: profile.emailVerified === true,
      linkedAt: now,
    };
    const key = identityKey(id);
    if (!seen.has(key)) identities.push(id);
  }

  return identities;
}

function providerSummary(profile) {
  const identities = Array.isArray(profile.identities) ? profile.identities : [];
  const providers = {};
  for (const identity of identities) {
    if (!identity || !identity.provider) continue;
    providers[identity.provider] ||= [];
    providers[identity.provider].push({
      providerId: String(identity.providerId || ""),
      email: identity.email || null,
      emailVerified: identity.emailVerified === true,
      linkedAt: identity.linkedAt || null,
    });
  }
  if (profile.credential && !providers.local) {
    providers.local = [{
      providerId: String(profile.email || "").toLowerCase(),
      email: profile.email || null,
      emailVerified: profile.emailVerified === true,
      linkedAt: null,
      implicitCredential: true,
    }];
  }
  return providers;
}

function accountIssues(profile, emailOwners = new Map()) {
  const issues = [];
  const identities = Array.isArray(profile.identities) ? profile.identities : [];
  const credential = !!profile.credential;
  const keys = new Set();
  const providers = new Map();

  for (const identity of identities) {
    if (!identity || !identity.provider || identity.providerId == null) {
      issues.push("malformed_identity");
      continue;
    }
    const key = identityKey(identity);
    if (keys.has(key)) issues.push("duplicate_identity");
    keys.add(key);
    providers.set(identity.provider, (providers.get(identity.provider) || 0) + 1);
  }

  for (const [provider, count] of providers) {
    if (count > 1) issues.push(`multiple_${provider}_identities`);
  }

  const hasLoginMethod = identities.length > 0 || credential;
  if (!hasLoginMethod) issues.push("no_login_method");
  if (credential && !identities.some((i) => i.provider === "local")) issues.push("credential_without_local_identity");
  if (!credential && identities.some((i) => i.provider === "local")) issues.push("local_identity_without_password");
  if (profile.patreonId && !identities.some((i) => i.provider === "patreon" && String(i.providerId) === String(profile.patreonId))) {
    issues.push("patreon_mirror_missing_identity");
  }
  if (profile.discordId && !identities.some((i) => i.provider === "discord" && String(i.providerId) === String(profile.discordId))) {
    issues.push("discord_mirror_missing_identity");
  }
  if (profile.pendingEmail) issues.push("pending_email");
  if (profile.email && profile.emailVerified !== true) issues.push("unverified_email");

  const email = latestEmail(profile);
  const owners = email ? emailOwners.get(email) : null;
  if (owners && owners.size > 1) issues.push("email_collision");

  return Array.from(new Set(issues));
}

function buildEmailOwnerMap(profiles) {
  const map = new Map();
  for (const profile of profiles) {
    const emails = new Set();
    if (profile.email) emails.add(String(profile.email).toLowerCase());
    if (profile.pendingEmail) emails.add(String(profile.pendingEmail).toLowerCase());
    for (const identity of Array.isArray(profile.identities) ? profile.identities : []) {
      if (identity.email) emails.add(String(identity.email).toLowerCase());
    }
    for (const email of emails) {
      if (!map.has(email)) map.set(email, new Set());
      map.get(email).add(profile.id);
    }
  }
  return map;
}

function accountView(profile, emailOwners, canAdmin) {
  const safe = publicProfile(profile);
  return {
    id: safe.id,
    name: safe.name || "",
    email: safe.email || "",
    pendingEmail: safe.pendingEmail || null,
    emailVerified: safe.emailVerified === true,
    role: safe.role || "guest",
    tier: safe.tier || null,
    entitlements: safe.entitlements || {},
    hasPassword: safe.hasPassword === true,
    providers: providerSummary(profile),
    identities: safe.identities || [],
    patreonId: safe.patreonId || null,
    discordId: safe.discordId || null,
    source: safe.metadata?.source || null,
    createdAt: safe.metadata?.createdAt || null,
    updatedAt: safe.metadata?.updatedAt || null,
    lastLoginAt: safe.metadata?.lastLoginAt || null,
    issues: accountIssues(profile, emailOwners),
    canAdmin: !!canAdmin,
  };
}

function sendResetLink(req, res, profile) {
  const email = profile.email;
  if (!email || !ACCOUNT_EMAIL_RE.test(String(email))) {
    deny(res, 400, "missing_email", "Account must have a valid email before password reset.");
    return true;
  }
  const token = createToken("reset_password", profile.id, profile.email);
  const link = `${originOf(req)}/reset-password.html?token=${encodeURIComponent(token)}`;
  sendPasswordResetEmail(profile.email, profile.name, link).catch(() => {});
  const body = { ok: true, sentTo: profile.email };
  if (!smtpConfigured() && isLoopback(req)) body.devResetLink = link;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
  return true;
}

function sendVerification(req, res, profile) {
  const target = profile.pendingEmail || profile.email;
  if (!target || !ACCOUNT_EMAIL_RE.test(String(target))) {
    deny(res, 400, "missing_email", "Account must have a valid email before verification.");
    return true;
  }
  const token = createToken("verify_email", profile.id, profile.pendingEmail || null);
  const link = `${originOf(req)}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  sendVerificationEmail(target, profile.name, link).catch(() => {});
  const body = { ok: true, sentTo: target };
  if (!smtpConfigured() && isLoopback(req)) body.devVerifyLink = link;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
  return true;
}

module.exports = async function adminAccountsRoutes(req, res, url) {
  const match = ADMIN_ACCOUNT_RE.exec(url.pathname);
  if (!match) return false;

  if (!isSupport(req)) {
    deny(res, 403, "support_required", "Accounts are visible only to admin and tech support roles.");
    return true;
  }

  const method = req.method;
  const accountId = match[1] ? decodeURIComponent(match[1]) : null;
  const action = match[2] ? decodeURIComponent(match[2]) : null;
  const profiles = listProfiles().filter((p) => !p.deleted);
  const emailOwners = buildEmailOwnerMap(profiles);
  const canAdmin = isAdmin(req);

  if (method === "GET" && !accountId) {
    const search = String(url.searchParams.get("search") || "").trim().toLowerCase();
    const role = String(url.searchParams.get("role") || "").trim();
    const provider = String(url.searchParams.get("provider") || "").trim();
    const issue = String(url.searchParams.get("issue") || "").trim();

    let accounts = profiles.map((profile) => accountView(profile, emailOwners, canAdmin));

    if (search) {
      accounts = accounts.filter((a) => {
        const haystack = [
          a.id, a.name, a.email, a.pendingEmail, a.role, a.tier, a.patreonId, a.discordId,
          ...a.identities.flatMap((i) => [i.provider, i.providerId, i.email]),
        ].filter(Boolean).join(" ").toLowerCase();
        return haystack.includes(search);
      });
    }
    if (role) accounts = accounts.filter((a) => a.role === role);
    if (provider) accounts = accounts.filter((a) => !!a.providers[provider]);
    if (issue) accounts = accounts.filter((a) => a.issues.includes(issue));

    accounts.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      accounts,
      count: accounts.length,
      roles: Object.keys(ROLE_HIERARCHY),
      canAdmin,
      canSupport: true,
    }));
    return true;
  }

  if (!accountId) {
    deny(res, 405, "method_not_allowed");
    return true;
  }

  const profile = getProfile(accountId);
  if (!profile || profile.deleted) {
    deny(res, 404, "account_not_found");
    return true;
  }

  if (method === "GET" && !action) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(accountView(profile, emailOwners, canAdmin)));
    return true;
  }

  if (method === "PATCH" && !action) {
    const body = await readJsonBody(req);
    if (!body) {
      deny(res, 400, "invalid_json");
      return true;
    }

    const updates = {};

    if (Object.prototype.hasOwnProperty.call(body, "emailVerified")) {
      updates.emailVerified = body.emailVerified === true;
    }
    if (Object.prototype.hasOwnProperty.call(body, "pendingEmail")) {
      const pending = String(body.pendingEmail || "").trim().toLowerCase();
      if (pending && !ACCOUNT_EMAIL_RE.test(pending)) {
        deny(res, 400, "invalid_pending_email");
        return true;
      }
      updates.pendingEmail = pending || null;
    }

    if (Object.prototype.hasOwnProperty.call(body, "role")) {
      if (!canAdmin) {
        deny(res, 403, "admin_required", "Only admins can change roles.");
        return true;
      }
      const newRole = String(body.role || "");
      if (getSessionUser(req)?.id === accountId && profile.role === "admin" && newRole !== "admin") {
        deny(res, 409, "self_admin_change_blocked", "Use another admin account to alter your own admin role.");
        return true;
      }
      if (!Object.prototype.hasOwnProperty.call(ROLE_HIERARCHY, newRole)) {
        deny(res, 400, "invalid_role", `Invalid role: ${newRole}`);
        return true;
      }
      updates.role = newRole;
    }

    if (Object.prototype.hasOwnProperty.call(body, "tier")) {
      if (!canAdmin) {
        deny(res, 403, "admin_required", "Only admins can change tier labels.");
        return true;
      }
      updates.tier = body.tier == null || body.tier === "" ? null : String(body.tier);
    }

    if (Object.prototype.hasOwnProperty.call(body, "entitlements")) {
      if (!canAdmin) {
        deny(res, 403, "admin_required", "Only admins can change entitlements.");
        return true;
      }
      const entitlements = { ...(profile.entitlements || {}) };
      for (const [key, value] of Object.entries(body.entitlements || {})) {
        entitlements[key] = value === true;
      }
      updates.entitlements = entitlements;
    }

    const updated = Object.keys(updates).length ? updateProfile(accountId, updates) : profile;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(accountView(updated, buildEmailOwnerMap(listProfiles().filter((p) => !p.deleted)), canAdmin)));
    return true;
  }

  if (method === "POST" && action === "normalize") {
    const identities = normalizeIdentityRows(profile);
    const updates = { identities };
    if (!profile.patreonId) {
      const patreon = identities.find((i) => i.provider === "patreon");
      if (patreon) updates.patreonId = patreon.providerId;
    }
    if (!profile.discordId) {
      const discord = identities.find((i) => i.provider === "discord");
      if (discord) updates.discordId = discord.providerId;
    }
    const updated = updateProfile(accountId, updates);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, account: accountView(updated, buildEmailOwnerMap(listProfiles().filter((p) => !p.deleted)), canAdmin) }));
    return true;
  }

  if (method === "POST" && action === "password-reset") {
    return sendResetLink(req, res, profile);
  }

  if (method === "POST" && action === "resend-verification") {
    return sendVerification(req, res, profile);
  }

  deny(res, 405, "method_not_allowed");
  return true;
};
