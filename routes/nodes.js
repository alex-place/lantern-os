/**
 * Lantern Node Mesh — discover and monitor connected nodes
 * Tracks machines running Lantern OS and active agents/workers
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

module.exports = async function nodesRoutes(req, res, url, deps) {
  const { sendJson, collectRequestBody, repoRoot } = deps;
  const nodesDir = path.join(repoRoot, "data", "nodes");

  // Ensure nodes directory exists
  if (!fs.existsSync(nodesDir)) {
    fs.mkdirSync(nodesDir, { recursive: true });
  }

  // ── GET /api/nodes/mesh ──
  // Returns all discovered Lantern nodes in the mesh
  if (url.pathname === "/api/nodes/mesh" && req.method === "GET") {
    try {
      const nodes = [];
      const files = fs.readdirSync(nodesDir).filter(f => f.endsWith(".json"));

      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(nodesDir, file), "utf8"));
          const lastSeen = new Date(data.lastSeen || data.registeredAt || 0);
          const isAlive = (Date.now() - lastSeen.getTime()) < 60000; // 60s heartbeat window
          nodes.push({
            ...data,
            isAlive,
            lastSeenAgo: Math.floor((Date.now() - lastSeen.getTime()) / 1000) + "s"
          });
        } catch { /* skip malformed */ }
      }

      sendJson(res, {
        nodeCount: nodes.length,
        aliveCount: nodes.filter(n => n.isAlive).length,
        nodes: nodes.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen))
      });
      return true;
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
      return true;
    }
  }

  // ── POST /api/nodes/register ──
  // Node registers itself to the mesh
  if (url.pathname === "/api/nodes/register" && req.method === "POST") {
    try {
      const raw = await collectRequestBody(req);
      const payload = JSON.parse(raw);
      const nodeId = payload.nodeId || os.hostname();
      const nodeName = payload.nodeName || os.hostname();
      const agents = payload.agents || [];
      const workers = payload.workers || 0;

      const nodeRecord = {
        nodeId,
        nodeName,
        platform: os.platform(),
        arch: os.arch(),
        uptime: process.uptime(),
        agents,
        workerCount: workers,
        registeredAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        address: req.socket?.remoteAddress,
        port: payload.port || 4177
      };

      const nodeFile = path.join(nodesDir, nodeId + ".json");
      fs.writeFileSync(nodeFile, JSON.stringify(nodeRecord, null, 2));

      sendJson(res, { ok: true, nodeId, message: "Node registered to mesh" });
      return true;
    } catch (err) {
      sendJson(res, { error: err.message }, 400);
      return true;
    }
  }

  // ── GET /api/nodes/this ──
  // Returns this node's info
  if (url.pathname === "/api/nodes/this" && req.method === "GET") {
    sendJson(res, {
      nodeId: os.hostname(),
      nodeName: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptime: process.uptime(),
      memory: {
        total: os.totalmem(),
        free: os.freemem(),
        used: os.totalmem() - os.freemem()
      },
      cpus: os.cpus().length
    });
    return true;
  }

  // ── GET /api/agents/workers ──
  // Returns active workers/collaborators for each agent
  if (url.pathname === "/api/agents/workers" && req.method === "GET") {
    try {
      const agentWorkerMap = {};
      const files = fs.readdirSync(nodesDir).filter(f => f.endsWith(".json"));

      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(nodesDir, file), "utf8"));
          const lastSeen = new Date(data.lastSeen || data.registeredAt || 0);
          const isAlive = (Date.now() - lastSeen.getTime()) < 60000;

          if (isAlive && data.agents) {
            for (const agent of data.agents) {
              if (!agentWorkerMap[agent]) {
                agentWorkerMap[agent] = { agent, workerNodes: [], totalWorkers: 0 };
              }
              agentWorkerMap[agent].workerNodes.push({
                nodeId: data.nodeId,
                nodeName: data.nodeName,
                workers: data.workerCount || 1
              });
              agentWorkerMap[agent].totalWorkers += (data.workerCount || 1);
            }
          }
        } catch { /* skip malformed */ }
      }

      const agents = Object.values(agentWorkerMap).sort((a, b) => b.totalWorkers - a.totalWorkers);
      sendJson(res, {
        timestamp: new Date().toISOString(),
        agentCount: agents.length,
        totalWorkers: agents.reduce((sum, a) => sum + a.totalWorkers, 0),
        agents
      });
      return true;
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
      return true;
    }
  }

  return false;
};
