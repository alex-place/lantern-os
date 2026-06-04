const fs = require("fs");
const path = require("path");
const { generateQutritId, generateEntryId } = require("./qutrit");

const repoRoot = path.resolve(__dirname, "..", "..");
const maxDreamerTextLength = 2000;
const dreamerNotebookDir = path.join(repoRoot, "data", "dreamer", "notebooks");

function normalizeDreamerUser(value) {
  const user = String(value || "courtney")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return user || "courtney";
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
  if (!fs.existsSync(filePath)) return [];
  const lines_text = fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
  return lines_text.map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function readRecentDreams(limit = 5) {
  const dreamDir = path.join(repoRoot, "data", "dream_journal");
  if (!fs.existsSync(dreamDir)) return [];
  const entries = [];
  const files = fs.readdirSync(dreamDir).filter((f) => f.endsWith(".jsonl"));
  for (const file of files) {
    const content = fs.readFileSync(path.join(dreamDir, file), "utf-8").trim();
    if (!content) continue;
    for (const line of content.split("\n")) {
      try { entries.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  entries.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
  return entries.slice(0, limit);
}

module.exports = {
  normalizeDreamerUser,
  dreamerNotebookPath,
  appendDreamerEntry,
  readDreamerNotebook,
  readRecentDreams,
};
