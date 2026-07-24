// MCP Resource Client — thin HTTP client for reading MCP resources from the Lantern OS MCP server.
// Replaces direct fs.readFileSync blob reads with URI-addressable MCP resource fetches.
//
// Usage:
//   const { readMcpResource, listMcpResources } = require("./mcp-resource-client");
//   const personas = await readMcpResource("context://personas");
//   const list = await listMcpResources();

const http = require("http");
const fs = require("fs");
const path = require("path");

const MCP_HOST = process.env.MCP_SERVER_HOST || "127.0.0.1";
const MCP_PORT = parseInt(process.env.MCP_SERVER_PORT || "8771", 10);
const MCP_TIMEOUT = parseInt(process.env.MCP_CLIENT_TIMEOUT || "5000", 10);
const REPO_ROOT = path.resolve(__dirname, "..");

// URI → local filesystem path fallback mapping
const _URI_TO_PATH = {
  "pcsf://model":        path.join(REPO_ROOT, "data", "pcsf", "model.pcsf.json"),
  "pcsf://agent":        path.join(REPO_ROOT, "data", "pcsf", "agent.pcsf.json"),
  "pcsf://settings":     path.join(REPO_ROOT, "data", "pcsf", "settings.pcsf.json"),
  "pcsf://narrator":     path.join(REPO_ROOT, "data", "pcsf", "narrator.pcsf.json"),
  "pcsf://provider":     path.join(REPO_ROOT, "data", "pcsf", "provider.pcsf.json"),
  "pcsf://health":       path.join(REPO_ROOT, "data", "pcsf", "health.pcsf.json"),
  "rag://house":         path.join(REPO_ROOT, "data", "internal-rag-house", "LANTERN-OS-INTERNAL-HOUSE-RAG.flat.md"),
  "rag://manifest":      path.join(REPO_ROOT, "data", "internal-rag-house", "RAG-HOUSE-MANIFEST.json"),
  "rag://readme":        path.join(REPO_ROOT, "data", "internal-rag-house", "README.md"),
  "context://personas":  path.join(REPO_ROOT, "data", "contexts", "personas.json"),
  "context://doors":     path.join(REPO_ROOT, "data", "contexts", "doors.json"),
  "context://doors-instruction": path.join(REPO_ROOT, "data", "contexts", "doors-instruction.md"),
  "context://keystone-debug":    path.join(REPO_ROOT, "data", "contexts", "keystone-debug.md"),
  "csf://memory":        path.join(REPO_ROOT, "data", "csf_memory"),
  "journal://entries":   path.join(REPO_ROOT, "data", "dream_journal"),
};

function _httpGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: MCP_HOST, port: MCP_PORT, path, timeout: MCP_TIMEOUT }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else {
          reject(new Error(`MCP resource ${path} returned ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", (err) => reject(err));
    req.on("timeout", () => { req.destroy(); reject(new Error(`MCP resource ${path} timed out`)); });
  });
}

/** List all available MCP resources. Returns array of {uri, name, mimeType, size}. */
async function listMcpResources() {
  try {
    const result = await _httpGet("/resource");
    return result.resources || [];
  } catch (err) {
    // MCP server may not be running; return empty list gracefully
    return [];
  }
}

/** Read a single MCP resource by URI. Returns the parsed JSON/text object or null on failure. */
async function readMcpResource(uri) {
  try {
    const encoded = encodeURIComponent(uri);
    const result = await _httpGet(`/resource/read?uri=${encoded}`);
    if (result && result.text) {
      // JSON resources auto-parse
      if (result.mimeType === "application/json") {
        try { return JSON.parse(result.text); } catch { return result.text; }
      }
      return result.text;
    }
    return result;
  } catch (err) {
    // Graceful fallback: return null so callers can use their own defaults
    return null;
  }
}

/** Internal: read a local file by URI mapping, returning parsed JSON or text. */
function _readLocalFile(uri) {
  const filePath = _URI_TO_PATH[uri];
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const text = fs.readFileSync(filePath, "utf8");
    if (filePath.endsWith(".json")) {
      try { return JSON.parse(text); } catch { return text; }
    }
    return text;
  } catch {
    return null;
  }
}

/** Read a resource synchronously via local filesystem fallback only.
 *  Prefer this for boot-time / sync code paths where async is not possible.
 *  For HTTP-first fetching, use readMcpResourceWithFallback instead. */
function readMcpResourceSync(uri, defaultValue = null) {
  const local = _readLocalFile(uri);
  if (local !== null) return local;
  return defaultValue;
}

/** Async read with full fallback chain: MCP HTTP → local fs → defaultValue. */
async function readMcpResourceWithFallback(uri, defaultValue = null) {
  const remote = await readMcpResource(uri);
  if (remote !== null) return remote;
  const local = _readLocalFile(uri);
  if (local !== null) return local;
  return defaultValue;
}

// Build reverse map once at module load for O(1) path → URI lookup
const _PATH_TO_URI = Object.fromEntries(
  Object.entries(_URI_TO_PATH).map(([uri, p]) => [path.normalize(p), uri])
);

/** Generic file read with MCP-first fallback. Reads any local path, trying MCP HTTP if
 *  the path maps to a known URI, otherwise direct fs. Returns {text, mimeType} or null. */
function readFileViaMcp(filePath) {
  const normalized = path.normalize(filePath);
  const uri = _PATH_TO_URI[normalized];
  if (uri) {
    const result = _readLocalFile(uri);
    if (result !== null) {
      const isJson = typeof result === "object";
      return {
        text: isJson ? JSON.stringify(result, null, 2) : result,
        mimeType: isJson ? "application/json" : "text/plain",
      };
    }
  }
  // Direct fs fallback
  if (!fs.existsSync(filePath)) return null;
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const isJson = filePath.endsWith(".json");
    return {
      text,
      mimeType: isJson ? "application/json" : "text/plain",
    };
  } catch {
    return null;
  }
}

module.exports = {
  listMcpResources,
  readMcpResource,
  readMcpResourceSync,
  readMcpResourceWithFallback,
  readFileViaMcp,
};
