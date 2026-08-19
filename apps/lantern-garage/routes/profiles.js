/**
 * User profile API routes.
 * Handles CRUD operations for local user profiles and CSF archives.
 */

const {
  getProfile,
  updateProfile,
  listProfiles,
  setUserRole,
  deleteProfile,
  linkDiscordAccount,
  unlinkIdentity,
  exportToCSF,
  importFromCSF,
  publicProfile,
  getProfileByEmail,
  verifyPassword,
  setLocalPassword,
} = require("../lib/user-profiles");
const { getSessionUser, getSessionUserId } = require("../lib/session-identity");
const { createToken } = require("../lib/auth-tokens");
const { sendMailBounded, verificationEmailPayload } = require("../lib/mailer");
const { canonicalOrigin } = require("../lib/base-url");

const ACCOUNT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCOUNT_MIN_PW = 8;
// Email-confirmation links use the operator-configured canonical origin, not the
// spoofable Host header (host-header poisoning, #2604).
function accountOrigin(req) {
  return canonicalOrigin(req);
}
function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    // #2649: destroying the request on the size cap kills 'data'/'end', so the
    // promise never settled and change-password/change-email hung forever. Resolve
    // (null) on the cap AND on teardown ('close'); resolve() is idempotent so the
    // races are harmless. The awaiting handler then answers instead of leaking.
    req.on("data", (c) => { body += c; if (body.length > 1e6) { resolve(null); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
    req.on("close", () => resolve(null));
  });
}

module.exports = async function profileRoutes(req, res, url, deps) {
  const path = url.pathname;
  const method = req.method;

  console.log(`[PROFILES] ${method} ${path}`);

  // GET /api/profiles/me — Get current user's profile (any provider; #1876)
  if (method === "GET" && path === "/api/profiles/me") {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Not authenticated" }));
    }

    const profile = getProfile(userId);
    // #2651: a disk-persisted session can outlive its profile record (index reset /
    // migration). Returning 200 with a null body made clients (profile.html,
    // auth-gate nav badge) do `(await res.json()).role` → TypeError instead of a
    // recoverable signed-out state. Answer 401 unknown_account so the client treats
    // it as signed-out; mirrors the change-password handler's unknown_account branch.
    if (!profile) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "unknown_account", signedOut: true }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(publicProfile(profile)));
  }

  // PUT /api/profiles/me — Update current user's profile
  if (method === "PUT" && path === "/api/profiles/me") {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Not authenticated" }));
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy(); // 1MB cap — reject oversized bodies (DoS)
    });

    req.on("end", () => {
      try {
        const updates = JSON.parse(body);
        // Users can only update their own profile, not role or tier. Copy ONLY the
        // fields the request actually sent — an absent key must not spread `undefined`
        // over the stored value (updateProfile merges by spread), which previously
        // wiped avatar/preferences/settings on every save that omitted them (#2607).
        const ALLOWED = ["name", "bio", "avatar", "preferences", "settings"];
        const safeUpdates = {};
        for (const key of ALLOWED) {
          if (Object.prototype.hasOwnProperty.call(updates, key) && updates[key] !== undefined) {
            safeUpdates[key] = updates[key];
          }
        }

        const profile = updateProfile(userId, safeUpdates);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(publicProfile(profile)));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    return true;
  }

  // POST /api/profiles/me/link-discord — Link the current web user to a Discord id (#697)
  if (method === "POST" && path === "/api/profiles/me/link-discord") {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Not authenticated" }));
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      try {
        const { discordId } = JSON.parse(body || "{}");
        if (!discordId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "discordId is required" }));
        }
        const link = linkDiscordAccount(userId, String(discordId));
        if (!link) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "No profile to link" }));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, link }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  // POST /api/profiles/me/unlink — Disconnect a linked provider from the current
  // account. Refuses to remove the last remaining login method (server-guarded).
  if (method === "POST" && path === "/api/profiles/me/unlink") {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Not authenticated" }));
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      try {
        const { provider } = JSON.parse(body || "{}");
        if (!provider) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "provider is required" }));
        }
        const result = unlinkIdentity(userId, String(provider));
        if (result.error) {
          const status = result.error === "last_login_method" ? 409
            : result.error === "not_linked" ? 400 : 404;
          res.writeHead(status, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: result.error }));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, profile: publicProfile(result.profile) }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  // POST /api/profiles/me/change-password { currentPassword?, newPassword }
  // If the account already has a password, currentPassword must match. If it has
  // none (OAuth-only), this SETS one (no current required).
  if (method === "POST" && path === "/api/profiles/me/change-password") {
    const userId = getSessionUserId(req);
    if (!userId) { res.writeHead(401, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Not authenticated" })); }
    const b = await readBody(req);
    if (!b) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "invalid_json" })); }
    const profile = getProfile(userId);
    if (!profile) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "unknown_account" })); }
    const newPassword = String(b.newPassword || "");
    if (newPassword.length < ACCOUNT_MIN_PW) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "weak_password", detail: `min ${ACCOUNT_MIN_PW} chars` }));
    }
    if (profile.credential) {
      if (!verifyPassword(String(b.currentPassword || ""), profile.credential)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "wrong_password" }));
      }
    }
    setLocalPassword(userId, newPassword);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, hadPassword: !!profile.credential }));
  }

  // POST /api/profiles/me/change-email { email } — stores the new address as
  // pending and emails a confirmation link; the address only becomes active once
  // that link is clicked (routes/auth verify-email).
  if (method === "POST" && path === "/api/profiles/me/change-email") {
    const userId = getSessionUserId(req);
    if (!userId) { res.writeHead(401, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Not authenticated" })); }
    const b = await readBody(req);
    const email = String((b && b.email) || "").trim().toLowerCase();
    if (!ACCOUNT_EMAIL_RE.test(email)) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "invalid_email" })); }
    const profile = getProfile(userId);
    if (!profile) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "unknown_account" })); }
    const clash = getProfileByEmail(email);
    if (clash && clash.id !== userId) { res.writeHead(409, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "email_taken" })); }
    updateProfile(userId, { pendingEmail: email });
    const token = createToken("verify_email", userId, email);
    const link = `${accountOrigin(req)}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
    // Bounded wait (#3094): the pending-email state is already persisted above, so a
    // slow provider must not hold this form. `delivery: "pending"` means the send is
    // still in flight — the address change is unaffected either way.
    const r = await sendMailBounded(verificationEmailPayload(email, profile.name, link));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, pending: email, delivery: r.pending ? "pending" : r.transport }));
  }

  // POST /api/profiles/me/resend-verification — re-send the confirmation email to
  // the account's (pending or current) address.
  if (method === "POST" && path === "/api/profiles/me/resend-verification") {
    const userId = getSessionUserId(req);
    if (!userId) { res.writeHead(401, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Not authenticated" })); }
    const profile = getProfile(userId);
    if (!profile) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "unknown_account" })); }
    const target = profile.pendingEmail || profile.email;
    if (!target) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "no_email" })); }
    const token = createToken("verify_email", userId, profile.pendingEmail || null);
    const link = `${accountOrigin(req)}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
    // Bounded wait (#3094) — same reasoning as change-email above.
    const r = await sendMailBounded(verificationEmailPayload(target, profile.name, link));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, sentTo: target, delivery: r.pending ? "pending" : r.transport }));
  }

  // GET /api/profiles/:userId — Get any user's public profile (admin-only)
  if (method === "GET" && /^\/api\/profiles\/[a-zA-Z0-9]+$/.test(path)) {
    const adminOnly = getSessionUser(req)?.role === "admin";
    if (!adminOnly) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Admin only" }));
    }

    const userId = path.split("/")[3];
    const profile = getProfile(userId);
    if (!profile) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Profile not found" }));
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(publicProfile(profile)));
  }

  // GET /api/profiles — List all profiles (admin-only)
  if (method === "GET" && path === "/api/profiles") {
    const isAdmin = getSessionUser(req)?.role === "admin";
    if (!isAdmin) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Admin only" }));
    }

    const filter = {};
    if (url.searchParams.has("role")) {
      filter.role = url.searchParams.get("role");
    }
    if (url.searchParams.has("search")) {
      filter.search = url.searchParams.get("search");
    }

    const profiles = listProfiles(filter).map(publicProfile);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ profiles, count: profiles.length }));
  }

  // PUT /api/profiles/:userId/role — Set user role (admin-only)
  if (method === "PUT" && /^\/api\/profiles\/[a-zA-Z0-9]+\/role$/.test(path)) {
    const isAdmin = getSessionUser(req)?.role === "admin";
    if (!isAdmin) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Admin only" }));
    }

    const userId = path.split("/")[3];
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy(); // 1MB cap — reject oversized bodies (DoS)
    });

    req.on("end", () => {
      try {
        const { role } = JSON.parse(body);
        const profile = setUserRole(userId, role);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(publicProfile(profile)));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    return true;
  }

  // DELETE /api/profiles/:userId — Delete profile (admin-only)
  if (method === "DELETE" && /^\/api\/profiles\/[a-zA-Z0-9]+$/.test(path)) {
    const isAdmin = getSessionUser(req)?.role === "admin";
    if (!isAdmin) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Admin only" }));
    }

    const userId = path.split("/")[3];
    // An admin must not delete their OWN account here — it would tombstone the acting
    // session (getSessionUser now denies deleted, #2608) and can lock the last admin
    // out. Account removal of self goes through a deliberate flow, not this endpoint (#2629).
    if (userId === getSessionUserId(req)) {
      res.writeHead(409, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "cannot_delete_self" }));
    }
    if (!getProfile(userId)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "unknown_account" }));
    }
    deleteProfile(userId);
    console.log(`[PROFILES] admin ${getSessionUserId(req)} deleted profile ${userId}`); // audit line (#2629)
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  // GET /api/profiles/export/csf — Export profiles to CSF (admin-only)
  if (method === "GET" && path === "/api/profiles/export/csf") {
    const isAdmin = getSessionUser(req)?.role === "admin";
    if (!isAdmin) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Admin only" }));
    }

    try {
      const csf = exportToCSF();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(csf));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  return false;
};

// Test seam (#2649): the body reader is otherwise module-private. Exposed so the
// route-body-robustness suite can drive the oversize/teardown paths directly.
module.exports.readBody = readBody;
