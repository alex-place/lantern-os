const fs = require("fs");
const path = require("path");
const { generateQutritId, generateEntryId } = require("./qutrit");
const { readFileViaMcp } = require("./mcp-resource-client");

const { dataRoot } = require("./app-paths");
// #1946 G2: notebooks live under dataRoot() — <repoRoot>/data on servers (unchanged),
// %APPDATA%\unisona\data on the desktop app. dreamer-store reads via absolute paths.
const repoRoot = path.resolve(__dirname, "..");
const maxDreamerTextLength = 2000;
const dreamerNotebookDir = path.join(dataRoot(), "dreamer", "notebooks");

// Helper: read file text via MCP resource client, falling back to fs.readFileSync
function _readText(filePath) {
  const result = readFileViaMcp(filePath);
  if (result && result.text) return result.text;
  if (!fs.existsSync(filePath)) return "";
  try { return fs.readFileSync(filePath, "utf8"); } catch { return ""; }
}

function normalizeDreamerUser(value) {
  const user = String(value || "dreamer")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return user || "dreamer";
}

function dreamerNotebookPath(user) {
  return path.join(dreamerNotebookDir, `${normalizeDreamerUser(user)}.jsonl`);
}

async function appendDreamerEntry(user, entry) {
  const entryId = generateEntryId();
  const record = {
    id: entryId,
    kind: String(entry.kind || "note").slice(0, 40),
    name: String(entry.name || "").slice(0, 120),
    mood: String(entry.mood || "").slice(0, 40),
    text: String(entry.text || "").slice(0, maxDreamerTextLength),
    tags: Array.isArray(entry.tags) ? entry.tags.map((t) => String(t).slice(0, 40)).slice(0, 10) : [],
    links: Array.isArray(entry.links) ? entry.links.map((t) => String(t).slice(0, 40)).slice(0, 20) : [],
    recordedAt: new Date().toISOString(),
    ternaryId: generateQutritId(entryId + "|" + String(entry.text || "")),
    private: true,
  };
  const filePath = dreamerNotebookPath(user);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
  return record;
}

function readDreamerNotebook(user) {
  const filePath = dreamerNotebookPath(user);
  const text = _readText(filePath);
  if (!text) return [];
  const lines_text = text.trim().split("\n").filter(Boolean);
  return lines_text.map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

// Simple memo cache with TTL for recent dreams (avoids disk I/O on every chat)
let recentDreamsCache = { entries: [], ts: 0, limit: 0 };
const RECENT_DREAMS_TTL_MS = 3000;

function readRecentDreams(limit = 5) {
  const now = Date.now();
  if (recentDreamsCache.limit >= limit && (now - recentDreamsCache.ts) < RECENT_DREAMS_TTL_MS) {
    return recentDreamsCache.entries.slice(0, limit);
  }
  const dreamDir = path.join(dataRoot(), "dream_journal");
  if (!fs.existsSync(dreamDir)) return [];
  const files = fs.readdirSync(dreamDir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  const entries = [];
  // Read only the most recent file(s) until we have enough entries
  for (const file of files) {
    if (entries.length >= limit) break;
    const content = _readText(path.join(dreamDir, file)).trim();
    if (!content) continue;
    const lines = content.split("\n").reverse(); // newest last in JSONL, so reverse
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* skip */ }
      if (entries.length >= limit) break;
    }
  }
  // Already in reverse-chronological order due to file+line order
  recentDreamsCache = { entries, ts: now, limit };
  return entries.slice(0, limit);
}

module.exports = {
  normalizeDreamerUser,
  dreamerNotebookPath,
  appendDreamerEntry,
  readDreamerNotebook,
  readRecentDreams,
};
