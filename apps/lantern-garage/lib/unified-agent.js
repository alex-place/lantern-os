const path = require("path");
const { spawn } = require("child_process");

const repoRoot = path.resolve(__dirname, "..", "..");

function unifiedAgentStream(message, persona, provider, context) {
  return new Promise((resolve, reject) => {
    const pyPath = path.join(repoRoot, "src", "unified_agent_connector.py");
    const args = [pyPath, "--action", "stream", "--message", message];
    if (persona) args.push("--persona", persona);
    if (provider) args.push("--provider", provider);
    if (context) args.push("--context", context);

    const proc = spawn("python", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `exit ${code}`));
      }
    });
    proc.stdin.end();
  });
}

function unifiedAgentHealth() {
  return new Promise((resolve) => {
    const pyPath = path.join(repoRoot, "src", "unified_agent_connector.py");
    const proc = spawn("python", [pyPath, "--action", "health"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.on("close", () => {
      try { resolve(JSON.parse(stdout)); } catch { resolve({}); }
    });
    proc.stdin.end();
  });
}

function unifiedAgentInspect() {
  return new Promise((resolve) => {
    const pyPath = path.join(repoRoot, "src", "unified_agent_connector.py");
    const proc = spawn("python", [pyPath, "--action", "inspect"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.on("close", () => {
      try { resolve(JSON.parse(stdout)); } catch { resolve({}); }
    });
    proc.stdin.end();
  });
}

function unifiedAgentGreet(recentDreams) {
  return new Promise((resolve) => {
    const pyPath = path.join(repoRoot, "src", "unified_agent_connector.py");
    const args = [pyPath, "--action", "greet"];
    if (recentDreams && recentDreams.length) {
      args.push("--context", JSON.stringify(recentDreams.slice(0, 3)));
    }
    const proc = spawn("python", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.on("close", () => {
      try { resolve(JSON.parse(stdout)); } catch { resolve({ greeting: stdout.trim(), persona: "unknown", source: "python_fallback" }); }
    });
    proc.stdin.end();
  });
}

module.exports = {
  unifiedAgentStream,
  unifiedAgentHealth,
  unifiedAgentInspect,
  unifiedAgentGreet,
};
