// UI settings: theme, appearance preferences
const path = require("path");

const uiSettingsPath = (repoRoot) => path.join(repoRoot, "data", "ui-settings.json");

function readUiSettings(repoRoot) {
  const settingsPath = uiSettingsPath(repoRoot);
  const fs = require("fs");
  if (!fs.existsSync(settingsPath)) {
    return { theme: "dark", createdAt: new Date().toISOString() };
  }
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return { theme: "dark", createdAt: new Date().toISOString() };
  }
}

function writeUiSettings(repoRoot, settings) {
  const fs = require("fs");
  const settingsPath = uiSettingsPath(repoRoot);
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}

module.exports = async (req, res, url, deps) => {
  const { sendJson, repoRoot } = deps;

  // GET /api/ui/theme — retrieve current theme preference.
  // NOTE: sendJson signature is (res, data, status=200) — pass the payload first, and
  // return `true` (sendJson returns undefined; `return sendJson(...)` would report the
  // route as unhandled and let the server fall through — a double-send hazard).
  if (req.method === "GET" && url.pathname === "/api/ui/theme") {
    const settings = readUiSettings(repoRoot);
    sendJson(res, { theme: settings.theme }, 200);
    return true;
  }

  // POST /api/ui/theme — save theme preference
  if (req.method === "POST" && url.pathname === "/api/ui/theme") {
    const body = await deps.collectRequestBody(req);
    try {
      const { theme } = JSON.parse(body);
      if (!["dark", "light"].includes(theme)) {
        sendJson(res, { error: "invalid theme" }, 400);
        return true;
      }
      const settings = readUiSettings(repoRoot);
      settings.theme = theme;
      settings.updatedAt = new Date().toISOString();
      writeUiSettings(repoRoot, settings);
      sendJson(res, { theme, saved: true }, 200);
      return true;
    } catch (e) {
      sendJson(res, { error: e.message }, 400);
      return true;
    }
  }

  return false; // not handled by this route
};
