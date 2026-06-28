const fs = require("fs");
const path = require("path");
const { readFileViaMcp } = require("./mcp-resource-client");

const repoRoot = path.resolve(__dirname, "..", "..", "..");

const CSF_MEMORY_PATH = path.join(repoRoot, "data", "csf_memory");
const CSF_INGEST_PATH = path.join(repoRoot, "csf", "ingest");
const DREAM_JOURNAL_PATH = path.join(repoRoot, "data", "dream_journal");
const TESSERACT_MANIFEST = path.join(repoRoot, "data", "tesseract", "manifest.json");
const DOOR_STATE_PATH = path.join(DREAM_JOURNAL_PATH, "door_state.json");
const RAG_HOUSE_PATH = path.join(repoRoot, "data", "rag-house", "flat-rag-house-latest.json");
const CONVERSATION_LOG_PATH = path.join(repoRoot, "data", "conversations", "garage-conversations.jsonl");

let _cache = { memories: null, ingest: null, ts: 0 };
const CACHE_TTL_MS = 10_000;

// Helper: read a file via MCP resource client, falling back to fs.readFileSync
function _readText(filePath) {
  const result = readFileViaMcp(filePath);
  if (result && result.text) return result.text;
  if (!fs.existsSync(filePath)) return "";
  try { return fs.readFileSync(filePath, "utf8"); } catch { return ""; }
}

function readMemoryRecords(limit = 20) {
  const records = [];
  if (!fs.existsSync(CSF_MEMORY_PATH)) return records;
  const files = fs.readdirSync(CSF_MEMORY_PATH, { recursive: true })
    .filter(f => String(f).endsWith(".jsonl"));
  for (const file of files) {
    const text = _readText(path.join(CSF_MEMORY_PATH, file));
    const lines = text.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try { records.push(JSON.parse(line)); } catch {}
    }
    if (records.length >= limit) break;
  }
  return records.slice(0, limit);
}

function readIngestDocs(limit = 3) {
  if (!fs.existsSync(CSF_INGEST_PATH)) return [];
  return fs.readdirSync(CSF_INGEST_PATH, { recursive: true })
    .filter(f => String(f).endsWith(".md"))
    .sort().reverse()
    .slice(0, limit)
    .map(f => {
      const content = _readText(path.join(CSF_INGEST_PATH, String(f))).trim();
      return { name: String(f), content: content.slice(0, 400) };
    });
}

// Helper: Common English stopwords for filtering
const stopwords = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "and", "or", "but", "if", "then", "else", "when", "where", "why", "how",
  "to", "of", "in", "on", "at", "for", "with", "by", "from", "up", "down",
  "out", "off", "over", "under", "again", "further", "then", "once", "here",
  "there", "what", "who", "whom", "this", "that", "these", "those", "am",
  "i", "me", "my", "myself", "we", "our", "ours", "ourselves", "you", "your",
  "yours", "yourself", "yourselves", "he", "him", "his", "himself", "she",
  "her", "hers", "herself", "it", "its", "itself", "they", "them", "their",
  "theirs", "themselves", "do", "does", "did", "doing",
  "because", "as", "until", "while", "about", "against", "between", "into",
  "through", "during", "before", "after", "above", "below",
  "all", "any", "both", "each", "few", "more", "most", "other", "some",
  "such", "no", "nor", "not", "only", "own", "same", "so", "than", "too",
  "very", "s", "t", "can", "will", "just", "don", "should", "now", "d", "ll",
  "m", "o", "re", "ve", "y", "ain", "aren", "couldn", "didn", "doesn", "hadn",
  "hasn", "haven", "isn", "ma", "mightn", "mustn", "needn", "shan", "shouldn",
  "wasn", "weren", "won", "wouldn"
]);

// Helper: Tokenizes text, removes stopwords and short words
function getFilteredTokens(text) {
  if (!text) return [];
  return text.toLowerCase()
    .split(/[\s.,;!?"'(){}[\]-]+/) // Split by common delimiters
    .filter(word => word.length > 2 && !stopwords.has(word));
}

// Keyword relevance scoring — returns 0-1 score for how relevant a text is to the query
function relevanceScore(text, query) {
  if (!text || !query) return 0;

  const queryTokens = getFilteredTokens(query);
  if (queryTokens.length === 0) return 0;

  const textTokens = getFilteredTokens(text);
  if (textTokens.length === 0) return 0;

  let hits = 0;
  for (const qToken of queryTokens) {
    if (textTokens.includes(qToken)) {
      hits++;
    }
  }
  return hits / queryTokens.length;
}

// Count of DISTINCT non-stopword tokens shared between query and text. The ratio
// from relevanceScore alone lets a SINGLE coincidental content word clear a
// threshold on a short query — the #1276 confabulation case — so cross-session
// recall additionally requires an absolute count of distinctive hits.
function distinctiveHitCount(text, query) {
  const q = new Set(getFilteredTokens(query));
  if (q.size === 0) return 0;
  const t = new Set(getFilteredTokens(text));
  let hits = 0;
  for (const tok of q) if (t.has(tok)) hits++;
  return hits;
}

// Query-filtered memory: only return records relevant to the user's message
// Σ₀ Fix: Validate scores; don't force low-relevance memories into context
function queryMemories(message, limit = 3) {
  const allRecords = readMemoryRecords(50);
  if (allRecords.length === 0) return [];
  const scored = allRecords.map(r => {
    const text = r.content?.text || r.content?.raw_input || (r.tags || []).join(" ");
    const tagText = (r.tags || []).join(" ");
    const score = Math.max(relevanceScore(text, message), relevanceScore(tagText, message));
    return { record: r, score };
  });
  scored.sort((a, b) => b.score - a.score);

  // Σ₀ Fix: Filter by relevance threshold (0.3 = at least 30% word match)
  // Don't force low-score memories into context just to avoid empty results
  const MIN_RELEVANCE = 0.3;
  const qualified = scored.filter(s => s.score >= MIN_RELEVANCE);

  // Return qualified memories (up to limit), even if less than limit
  // This prevents low-relevance memories from drowning out high-relevance ones
  const result = qualified.slice(0, limit).map(s => s.record);

  // Log quality metric: how many records were filtered vs returned
  if (scored.length > result.length) {
    try {
      const { appendJsonlQueued } = require("./file-queue");
      const metricsPath = path.resolve(__dirname, "../../data/csf-query-metrics.jsonl");
      appendJsonlQueued(metricsPath, {
        timestamp: new Date().toISOString(),
        messageLength: message.length,
        candidatesCount: scored.length,
        qualifiedCount: result.length,
        filteredCount: scored.length - result.length,
        topScores: scored.slice(0, 3).map(s => s.score)
      }).catch(() => {});
    } catch (e) {}
  }

  return result;
}

// Issue #919 finding #1 — semantic memory retrieval via nomic-embed-text.
// Upgrades queryMemories with real embeddings from the local Ollama model.
// Falls back silently to keyword results when the embed model is unavailable.
// Returns a Promise; callers that need sync can use queryMemories() above.
async function queryMemoriesSemantic(message, limit = 3) {
  const keyword = queryMemories(message, limit * 3);  // wider candidate pool for reranker
  if (keyword.length === 0) return [];
  try {
    const { semanticRerank } = require("./semantic-reranker");
    const textField = "__text";
    const withText = keyword.map(r => ({
      ...r,
      [textField]: r.content?.text || r.content?.raw_input || (r.tags || []).join(" "),
    }));
    const reranked = await semanticRerank(message, withText, { topK: limit, textField });
    return reranked.map(r => { const c = { ...r }; delete c[textField]; return c; });
  } catch {
    return keyword.slice(0, limit);
  }
}

// Query-filtered ingest docs: only return docs relevant to the message
function queryIngestDocs(message, limit = 2) {
  const allDocs = readIngestDocs(10);
  if (allDocs.length === 0) return [];
  const scored = allDocs.map(d => ({
    doc: d,
    score: Math.max(relevanceScore(d.name, message), relevanceScore(d.content, message)),
  }));
  scored.sort((a, b) => b.score - a.score);
  // Always return top-N docs so context is never empty
  return scored.slice(0, limit).map(s => s.doc);
}

// Query dream journal entries for relevant context
function queryDreamEntries(message, limit = 3) {
  const journalFile = path.join(DREAM_JOURNAL_PATH, `dreams_${new Date().toISOString().slice(0, 7)}.jsonl`);
  const text = _readText(journalFile);
  if (!text) return [];
  const lines = text.trim().split("\n").filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch {}
  }
  // Score by relevance, prefer entries with actual content
  const scored = entries
    .filter(e => e.text && e.text.length > 10)
    .map(e => {
      const combined = `${e.text} ${(e.tags || []).join(" ")} ${(e.symbols || []).join(" ")}`;
      return { entry: e, score: relevanceScore(combined, message) };
    });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.entry);
}

function loadDoorState() {
  try {
    const text = _readText(DOOR_STATE_PATH);
    if (text) return JSON.parse(text);
  } catch {}
  return { doors: [], lastChoice: null, history: [] };
}

function saveDoorState(state) {
  const dir = path.dirname(DOOR_STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DOOR_STATE_PATH, JSON.stringify(state, null, 2));
}

function saveDoorChoice(doorText, allDoors) {
  const state = loadDoorState();
  if (doorText) state.lastChoice = doorText;
  state.doors = allDoors;
  state.history.push({
    type: doorText ? "choice" : "offered",
    choice: doorText || null,
    doors: allDoors,
    ts: new Date().toISOString(),
  });
  if (state.history.length > 50) state.history = state.history.slice(-50);
  saveDoorState(state);
}

// Query tesseract research library — PDF titles + text snippets scored by relevance
let _tesseractCache = { docs: null, ts: 0 };
function queryResearchLibrary(message, limit = 3) {
  try {
    if (!fs.existsSync(TESSERACT_MANIFEST)) return [];
    const now = Date.now();
    if (!_tesseractCache.docs || (now - _tesseractCache.ts) > 60_000) {
      const raw = JSON.parse(fs.readFileSync(TESSERACT_MANIFEST, "utf8"));
      _tesseractCache = { docs: raw.docs || [], ts: now };
    }
    const scored = _tesseractCache.docs.map(d => {
      const haystack = [d.pdfTitle || "", d.textSnippet || "", d.filename || ""].join(" ");
      return { doc: d, score: relevanceScore(haystack, message) };
    });
    return scored
      .filter(s => s.score >= 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.doc);
  } catch { return []; }
}

// Query RAG house knowledge base — returns relevant records by keyword matching
function queryRagHouse(message, limit = 2) {
  try {
    const text = _readText(RAG_HOUSE_PATH);
    if (!text) return [];
    const house = JSON.parse(text);
    if (!house?.ragRecords || !Array.isArray(house.ragRecords)) return [];

    const scored = house.ragRecords.map(r => ({
      ...r,
      score: Math.max(
        relevanceScore(r.content || "", message),
        relevanceScore(r.title || "", message),
        relevanceScore((r.tags || []).join(" "), message)
      ),
    }));

    return scored
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  } catch {
    return [];
  }
}

// Old broad context loader (cached, for backwards compat)
function buildCSFContext() {
  const now = Date.now();
  if (_cache.ts && (now - _cache.ts) < CACHE_TTL_MS) {
    return { memories: _cache.memories, ingest: _cache.ingest, doors: loadDoorState() };
  }
  const memories = readMemoryRecords(5);
  const ingest = readIngestDocs(3);
  _cache = { memories, ingest, ts: now };
  return { memories, ingest, doors: loadDoorState() };
}

// Cross-session chat memory: recall the most relevant PAST chat turns (across ALL sessions)
// for the current message, so the chat "remembers what we discussed" beyond the live history
// window. Reuses the existing conversation-store log (data/conversations/garage-conversations.jsonl)
// — NOT a new memory system. In-process, fail-safe.
function queryConversationMemory(message, limit = 4) {
  if (!message) return [];
  const text = _readText(CONVERSATION_LOG_PATH);
  if (!text) return [];
  const lines = text.trim().split("\n").filter(Boolean);
  const window = lines.slice(-600); // bounded scan; the log is rotated at ~5MB
  const cur = String(message).trim().toLowerCase();
  const seen = new Set();
  const scored = [];
  for (const line of window) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const t = e && typeof e.text === "string" ? e.text.trim() : "";
    if (!t || e.role === "system" || e.role === "note") continue;
    if (t.toLowerCase() === cur) continue;          // never recall the current question itself
    // #1276: a ratio alone lets one coincidental content word clear the bar on a
    // short query → confabulation. Require >=2 DISTINCT token hits AND a real ratio
    // before recalling a past turn as memory.
    if (distinctiveHitCount(t, message) < 2) continue;
    const score = relevanceScore(t, message);
    if (score < 0.4) continue;                        // require real topical overlap
    const key = t.slice(0, 80).toLowerCase();
    if (seen.has(key)) continue;                      // de-dup near-identical turns
    seen.add(key);
    scored.push({ role: e.role, text: t, score, at: e.recordedAt || "" });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

// New: query-time relevance-filtered context — compact, ~500-1500 chars max
function formatCSFContextForPrompt(message) {
  const parts = [];

  // Relevant memories only (scored by keyword match to message)
  if (message) {
    const memories = queryMemories(message, 3);
    if (memories.length > 0) {
      const memText = memories.map(m => {
        const text = m.content?.text || m.content?.raw_input || "";
        return `- ${text.slice(0, 120)}`;
      }).join("\n");
      parts.push(`Memories:\n${memText}`);
    }

    const ingest = queryIngestDocs(message, 1);
    if (ingest.length > 0) {
      parts.push(`Context: ${ingest[0].content.slice(0, 300)}`);
    }

    const dreams = queryDreamEntries(message, 2);
    if (dreams.length > 0) {
      const dreamText = dreams.map(e => `- ${e.text.slice(0, 100)}`).join("\n");
      parts.push(`Recent dreams:\n${dreamText}`);
    }

    // Cross-session chat memory — past turns recalled by keyword overlap. #1276: selection
    // is heuristic (token overlap), so the framing must NOT force the model to vouch for a
    // possibly-coincidental match as authoritative memory (that drove confabulation). Present
    // it as prior context the model MAY use when clearly on-topic, and explicitly allow it to
    // flag/discount a recall that looks coincidental.
    const convo = queryConversationMemory(message, 4);
    if (convo.length > 0) {
      const convoText = convo
        .map(c => `- ${c.role === "lantern" ? "You (Keystone) previously said" : "The user previously said"}: ${c.text.slice(0, 220)}`)
        .join("\n");
      parts.push(`Possibly-relevant excerpts from this user's earlier conversations with you, recalled by keyword overlap (persisted across sessions). Treat them as prior context, not verified fact: if they are clearly on-topic you may rely on and reference them; if a match looks coincidental or you are unsure, say so rather than vouching for the details:\n${convoText}`);
    }
  }

  // Door state — compact, always included
  const doors = loadDoorState();
  if (doors.lastChoice || doors.doors.length > 0) {
    const last3 = doors.history.slice(-3).map(h =>
      h.choice ? `chose "${h.choice}"` : `offered [${h.doors.join(" | ")}]`
    ).join("; ");
    parts.push(`Doors: ${last3 || "none yet"}`);
  }

  // Research library (CSF tesseract) — PDF titles + snippets scored by relevance
  if (message) {
    const researchDocs = queryResearchLibrary(message, 3);
    if (researchDocs.length > 0) {
      const researchText = researchDocs.map(d => {
        const title = d.pdfTitle || d.filename;
        const date = d.publishedAt ? ` (${d.publishedAt})` : "";
        const snippet = (d.textSnippet || "").slice(0, 300).trim();
        return `- **${title}**${date}${snippet ? ": " + snippet : ""}`;
      }).join("\n");
      parts.push(`Research library:\n${researchText}`);
    }
  }

  // RAG house knowledge base — relevant external records
  if (message) {
    const ragRecords = queryRagHouse(message, 2);
    if (ragRecords.length > 0) {
      const ragText = ragRecords.map(r =>
        `- ${r.title || "Knowledge"}: ${(r.content || "").slice(0, 150)}`
      ).join("\n");
      parts.push(`Knowledge base (RAG):\n${ragText}`);
    }
  }

  // CSF delta layer — recurring symbols, mood arc, convergence trend
  try {
    const { formatDeltaContextForPrompt } = require("./csf-delta-store");
    const deltaCtx = formatDeltaContextForPrompt(message);
    if (deltaCtx) parts.push(deltaCtx);
  } catch { /* non-fatal */ }

  // Σ₀ Framework context — for grounding requests that mention collapse, unification, or self-reference
  if (message && (message.includes("collapse") || message.includes("unification") || message.includes("self-reference") || message.includes("grounding"))) {
    try {
      const sigma0Path = path.join(repoRoot, "docs", "SIGMA0-QUANTUM-RELATIVITY-ANALYSIS.md");
      if (fs.existsSync(sigma0Path)) {
        const sigma0Text = fs.readFileSync(sigma0Path, "utf8");
        const summary = sigma0Text.split("\n").slice(0, 30).join("\n"); // First 30 lines as summary
        parts.push(`**Σ₀ Framework Context (Grounding):**\n${summary}`);
      }
    } catch { /* non-fatal */ }
  }

  return parts.join("\n\n");
}

module.exports = {
  relevanceScore,
  distinctiveHitCount,
  readMemoryRecords,
  readIngestDocs,
  queryMemories,
  queryMemoriesSemantic,
  queryIngestDocs,
  queryDreamEntries,
  queryRagHouse,
  queryResearchLibrary,
  queryConversationMemory,
  loadDoorState,
  saveDoorState,
  saveDoorChoice,
  buildCSFContext,
  formatCSFContextForPrompt,
};
