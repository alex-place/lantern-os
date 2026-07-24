/**
 * Agent Leaderboard Routes
 * Dashboard and retirement history endpoints
 */

const path = require("path");

module.exports = async function leaderboardRoutes(req, res, url, deps) {
  const { sendJson, sendFile } = deps;

  // GET /leaderboard — Serve dashboard HTML
  if (url.pathname === "/leaderboard" && req.method === "GET") {
    try {
      const dashboardPath = path.resolve(__dirname, "..", "public", "agent-leaderboard.html");
      await sendFile(res, dashboardPath, "text/html");
    } catch (error) {
      sendJson(res, { error: error.message }, 500);
    }
    return true;
  }

  // GET /api/leaderboard/retirement-history — Get agent retirement records
  if (url.pathname === "/api/leaderboard/retirement-history" && req.method === "GET") {
    try {
      const fs = require("fs").promises;
      const retirementPath = path.resolve(__dirname, "data", "agent-retirement-history.jsonl");

      let retirements = [];
      try {
        const content = await fs.readFile(retirementPath, "utf-8");
        retirements = content
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .reverse() // Most recent first
          .slice(0, 50); // Last 50 retirements
      } catch (err) {
        // File may not exist yet
      }

      sendJson(res, { retirements, total: retirements.length }, 200);
    } catch (error) {
      sendJson(res, { error: error.message }, 500);
    }
    return true;
  }

  return false;
};
