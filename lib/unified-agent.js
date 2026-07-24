const path = require("path");
const { spawn } = require("child_process");

// lib → lantern-garage → apps → repo root
const repoRoot = path.resolve(__dirname, "..");
const PY = process.platform === "win32" ? "python" : "python3";
const PY_ENV = { ...process.env, PYTHONPATH: path.join(repoRoot, "src") };

function unifiedAgentStream(message, persona, provider, context) {
  return new Promise((resolve, reject) => {
    const pyPath = path.join(repoRoot, "src", "unified_agent_connector.py");
    const args = [pyPath, "--action", "stream", "--message", message];
    if (persona) args.push("--persona", persona);
    if (provider) args.push("--provider", provider);
    if (context) args.push("--context", context);

    const proc = spawn(PY, args, { stdio: ["pipe", "pipe", "pipe"], env: PY_ENV });
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
    const proc = spawn(PY, [pyPath, "--action", "health"], { stdio: ["pipe", "pipe", "pipe"], env: PY_ENV });
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
    const proc = spawn(PY, [pyPath, "--action", "inspect"], { stdio: ["pipe", "pipe", "pipe"], env: PY_ENV });
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
    const proc = spawn(PY, args, { stdio: ["pipe", "pipe", "pipe"], env: PY_ENV });
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.on("close", () => {
      try { resolve(JSON.parse(stdout)); } catch { resolve({ greeting: stdout.trim(), persona: "unknown", source: "python_fallback" }); }
    });
    proc.stdin.end();
  });
}

/**
 * Stream tokens from the unified connector for SSE consumption.
 * Yields { token: string } objects and ends with { done: true, meta: {...} }.
 * Each token is flushed to stdout as a JSON line by the Python side.
 */
function unifiedAgentStreamSSE(message, persona, provider, context) {
  const pyPath = path.join(repoRoot, "src", "unified_agent_connector.py");
  const args = [pyPath, "--action", "stream-sse", "--message", message];
  if (persona) args.push("--persona", persona);
  if (provider) args.push("--provider", provider);
  if (context) args.push("--context", context);

  const proc = spawn(PY, args, { stdio: ["pipe", "pipe", "pipe"], env: PY_ENV });
  proc.stdin.end();

  return {
    onData(cb) {
      let buf = "";
      proc.stdout.on("data", (d) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            cb(parsed);
          } catch { /* skip non-JSON lines */ }
        }
      });
    },
    onError(cb) {
      let errBuf = "";
      proc.stderr.on("data", (d) => { errBuf += d.toString(); });
      proc.on("close", (code) => {
        if (code !== 0) cb(new Error(errBuf || `exit ${code}`));
      });
      proc.on("error", cb);
    },
    kill() { proc.kill(); },
  };
}

module.exports = {
  unifiedAgentStream,
  unifiedAgentStreamSSE,
  unifiedAgentHealth,
  unifiedAgentInspect,
  unifiedAgentGreet,
};
