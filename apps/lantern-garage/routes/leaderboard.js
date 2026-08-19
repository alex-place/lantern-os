/**
 * Agent Leaderboard Routes
 * Dashboard and retirement history endpoints
 */

const path = require("path");

module.exports = async function leaderboardRoutes(req, res, url, deps) {
  const { sendJson } = deps;

  // GET /leaderboard — the agent-leaderboard.html surface was retired in #3109
  // (orphaned: no inbound nav path from anywhere on the site). The retirement
  // records below are still served as JSON; only the HTML view is gone, so this
  // path 302s to the fleet view rather than 500ing on a missing file.
  if (url.pathname === "/leaderboard" && req.method === "GET") {
    res.writeHead(302, { Location: "/orchestration.html" });
    res.end();
    return true;
  }

  // GET /api/leaderboard/retirement-history — Get agent retirement records
  if (url.pathname === "/api/leaderboard/retirement-history" && req.method === "GET") {
    try {
      const fs = require("fs").promises;
      const retirementPath = path.resolve(__dirname, "..", "..", "data", "agent-retirement-history.jsonl");

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
