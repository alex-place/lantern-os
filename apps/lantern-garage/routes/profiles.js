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
  exportToCSF,
  importFromCSF,
} = require("../lib/user-profiles");

module.exports = async function profileRoutes(req, res, url, deps) {
  const path = url.pathname;
  const method = req.method;

  console.log(`[PROFILES] ${method} ${path}`);

  // GET /api/profiles/me — Get current user's profile
  if (method === "GET" && path === "/api/profiles/me") {
    const userId = req.session?.patreon?.id;
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Not authenticated" }));
    }

    const profile = getProfile(userId);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(profile));
  }

  // PUT /api/profiles/me — Update current user's profile
  if (method === "PUT" && path === "/api/profiles/me") {
    const userId = req.session?.patreon?.id;
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Not authenticated" }));
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", () => {
      try {
        const updates = JSON.parse(body);
        // Users can only update their own profile, not role or tier
        const safeUpdates = {
          name: updates.name,
          bio: updates.bio,
          avatar: updates.avatar,
          preferences: updates.preferences,
          settings: updates.settings,
        };

        const profile = updateProfile(userId, safeUpdates);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(profile));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    return true;
  }

  // POST /api/profiles/me/link-discord — Link the current web user to a Discord id (#697)
  if (method === "POST" && path === "/api/profiles/me/link-discord") {
    const userId = req.session?.patreon?.id;
    if (!userId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Not authenticated" }));
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
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

  // GET /api/profiles/:userId — Get any user's public profile (admin-only)
  if (method === "GET" && /^\/api\/profiles\/[a-zA-Z0-9]+$/.test(path)) {
    const adminOnly = req.session?.patreon?.role === "admin";
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
    return res.end(JSON.stringify(profile));
  }

  // GET /api/profiles — List all profiles (admin-only)
  if (method === "GET" && path === "/api/profiles") {
    const isAdmin = req.session?.patreon?.role === "admin";
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

    const profiles = listProfiles(filter);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ profiles, count: profiles.length }));
  }

  // PUT /api/profiles/:userId/role — Set user role (admin-only)
  if (method === "PUT" && /^\/api\/profiles\/[a-zA-Z0-9]+\/role$/.test(path)) {
    const isAdmin = req.session?.patreon?.role === "admin";
    if (!isAdmin) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Admin only" }));
    }

    const userId = path.split("/")[3];
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", () => {
      try {
        const { role } = JSON.parse(body);
        const profile = setUserRole(userId, role);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(profile));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    return true;
  }

  // DELETE /api/profiles/:userId — Delete profile (admin-only)
  if (method === "DELETE" && /^\/api\/profiles\/[a-zA-Z0-9]+$/.test(path)) {
    const isAdmin = req.session?.patreon?.role === "admin";
    if (!isAdmin) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Admin only" }));
    }

    const userId = path.split("/")[3];
    deleteProfile(userId);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  // GET /api/profiles/export/csf — Export profiles to CSF (admin-only)
  if (method === "GET" && path === "/api/profiles/export/csf") {
    const isAdmin = req.session?.patreon?.role === "admin";
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
