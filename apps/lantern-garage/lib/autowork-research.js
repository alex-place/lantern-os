/**
 * Autowork Research / Grounding (Σ₀ Remember + Verify stage)
 *
 * Shared grounding step for BOTH autonomous-work routes (the non-stream FLEET
 * path that auto-dispatch calls, and the SSE stream path). It exists to fix two
 * long-standing bugs:
 *
 *   1. "research always returns 20 files" — the old inline code took the first 10
 *      ≥4-char words from the issue (including stopwords like "this"/"with"/"test"),
 *      `git grep`-ed each, and kept the first 20 hits. Generic words match hundreds
 *      of files, so it nearly always returned 20 irrelevant paths and the model
 *      patched blind. Here we drop stopwords, prefer identifier-looking tokens, and
 *      RANK files by symbol/path relevance (repo-context.searchRepoFiles), keeping a
 *      small, relevant scope.
 *
 *   2. "web verify always returns 0" — the old code hit the DuckDuckGo *Instant
 *      Answer* endpoint and read `json.Results`, which is empty for almost every
 *      real query. Here we use the project's dependable web-search client (MCP →
 *      DuckDuckGo → Wikipedia fallback chain).
 *
 * Every sub-step is logged via `onStep` (the caller wires this to SSE and/or the
 * run log) AND appended to data/autowork-runs/<date>.jsonl so each autowork run is
 * reviewable after the fact.
 */

const fs = require("fs");
const path = require("path");
const { webSearch } = require("./web-search-client");

let searchRepoFiles = null;
try { ({ searchRepoFiles } = require("./repo-context")); } catch (_e) { /* optional */ }

const REPO_ROOT = path.resolve(__dirname, "../../..");
const RUN_LOG_DIR = path.join(REPO_ROOT, "data", "autowork-runs");

// Web grounding is best-effort and must NEVER block the run. The underlying search
// client guards SOCKET idle time but not DNS resolution, so a transient DNS stall
// can hang a fetch indefinitely. This absolute wall-clock deadline converts any
// such hang into a clean rejection the caller already handles (emit "skipped",
// proceed with whatever evidence was gathered). Override with AUTOWORK_WEB_TIMEOUT.
const WEB_PHASE_TIMEOUT = parseInt(process.env.AUTOWORK_WEB_TIMEOUT || "90000", 10);
function _withDeadline(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_res, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// English + boilerplate code words that match hundreds of files. Filtering these is
// what turns "20 generic files" into a small, relevant scope.
const STOPWORDS = new Set([
  "this", "that", "with", "from", "have", "will", "when", "what", "which", "there",
  "their", "would", "could", "should", "about", "into", "they", "them", "then", "than",
  "your", "yours", "been", "being", "were", "also", "more", "most", "some", "such",
  "only", "like", "just", "make", "made", "need", "want", "does", "done", "using", "used",
  "issue", "issues", "error", "errors", "file", "files", "code", "test", "tests", "fix",
  "fixes", "feature", "please", "title", "body", "null", "true", "false", "function",
  "return", "async", "await", "value", "data", "page", "name", "type", "item", "step",
  "should", "shall", "must", "each", "every", "here", "where", "after", "before", "while",
]);

// Looks like a code identifier (camelCase / snake_case / kebab-case / has digits) —
// far more likely to be the real subject of an issue than a plain English word.
function _identifierish(w) {
  return /[A-Z]/.test(w.slice(1)) || /[_-]/.test(w) || /\d/.test(w);
}

/**
 * Pull the most issue-specific keywords out of free text.
 * Drops stopwords, dedupes case-insensitively, ranks identifier-looking and
 * frequent tokens first.
 */
function extractKeywords(text, max = 10) {
  const freq = new Map();
  const tokens = String(text || "").match(/\b[A-Za-z_][A-Za-z0-9_-]{3,29}\b/g) || [];
  for (const raw of tokens) {
    if (STOPWORDS.has(raw.toLowerCase())) continue;
    freq.set(raw, (freq.get(raw) || 0) + 1);
  }
  const ranked = [...freq.entries()]
    .sort((a, b) => (_identifierish(b[0]) - _identifierish(a[0])) || (b[1] - a[1]));
  const out = [];
  for (const [w] of ranked) {
    if (!out.some((x) => x.toLowerCase() === w.toLowerCase())) out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

// Append one step record to data/autowork-runs/<date>.jsonl (best-effort).
function logStep(runId, issueNumber, phase, status, extra = {}) {
  try {
    fs.mkdirSync(RUN_LOG_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const rec = {
      ts: new Date().toISOString(),
      runId: runId || null,
      issue: issueNumber || null,
      phase,
      status,
      ...extra,
    };
    fs.appendFileSync(path.join(RUN_LOG_DIR, `${date}.jsonl`), JSON.stringify(rec) + "\n");
  } catch (_e) { /* logging is best-effort, never block the run */ }
}

function newRunId(issueNumber) {
  // No Math.random() needed — issue + ms is unique enough for a per-run log key.
  return `autowork-${issueNumber || "task"}-${Date.now()}`;
}

// Rank repo files for the issue. Prefer the symbol-aware ranker (repo-context);
// fall back to a stopword-filtered `git grep` in the worktree so a missing index
// never sends the model in blind.
async function _findScopeFiles(workRoot, keywords, emit, maxFiles) {
  // 1) Ranked, symbol-aware search (relevance-scored — fixes "always 20 files").
  if (searchRepoFiles && keywords.length) {
    try {
      const ranked = await searchRepoFiles(keywords.join(" "), maxFiles);
      const files = (ranked || []).map((r) => (typeof r === "string" ? r : r.path)).filter(Boolean);
      if (files.length) {
        emit("research", "scope_ranked", { source: "symbol-rank", filesFound: files.length, files });
        return files.slice(0, maxFiles);
      }
    } catch (e) {
      emit("research", "scope_rank_failed", { reason: e.message });
    }
  }

  // 2) Fallback: git grep the filtered keywords in the worktree.
  const { execFileSync } = require("child_process");
  const scopeFiles = [];
  for (const kw of keywords.slice(0, 5)) {
    if (scopeFiles.length >= maxFiles) break;
    if (!kw || kw.length < 4) continue;
    try {
      const out = execFileSync(
        "git",
        ["grep", "-l", "-i", "-e", kw, "--", "*.js", "*.json", "*.md", "*.py", "*.html"],
        { cwd: workRoot, encoding: "utf-8", timeout: 8000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }
      ).split("\n").filter(Boolean);
      for (const fp of out) {
        if (fp && !scopeFiles.includes(fp)) scopeFiles.push(fp);
        if (scopeFiles.length >= maxFiles) break;
      }
    } catch (_e) { /* no match for this keyword — fine */ }
  }
  emit("research", "scope_grep", { source: "git-grep", filesFound: scopeFiles.length, files: scopeFiles });
  return scopeFiles;
}

/**
 * Ground an issue in the codebase + external reality.
 *
 * @param {object} o
 * @param {string} o.workRoot     - worktree to grep in
 * @param {number} o.issueNumber
 * @param {string} o.issueTitle
 * @param {string} o.issueBody
 * @param {function} [o.onStep]   - (phase, status, extra) sink (e.g. SSE step()).
 * @param {string} [o.runId]
 * @param {number} [o.maxFiles=8]
 * @param {boolean} [o.web=true]  - run the external web grounding search.
 * @returns {Promise<{keywords, scopeFiles, webEvidence, researchContext}>}
 */
async function researchIssue(o) {
  const {
    workRoot, issueNumber, issueTitle = "", issueBody = "",
    onStep, runId = newRunId(issueNumber), maxFiles = 8, web = true,
    // Wide grounding: fan out angled sub-queries and escalate low→high fidelity
    // (lib/wide-search) instead of the single narrow query. ON by default for the
    // whole fleet — set AUTOWORK_WIDE_SEARCH=0 to fall back to the narrow single
    // query. Per-call `wide` overrides the env when provided.
    wide = process.env.AUTOWORK_WIDE_SEARCH !== "0",
  } = o || {};

  // Single sink: forward to the caller's onStep AND persist to the run log so every
  // step is reviewable whether or not the caller is streaming.
  const emit = (phase, status, extra = {}) => {
    try { if (typeof onStep === "function") onStep(phase, status, extra); } catch (_e) { /* ignore */ }
    logStep(runId, issueNumber, phase, status, extra);
  };

  const issueFullText = `${issueTitle}\n\n${issueBody}`;
  const keywords = extractKeywords(issueFullText, 10);
  emit("research", "keywords", { keywords });

  // Web grounding. Two paths:
  //   wide  → fan out angled sub-queries + escalate low→high fidelity (better recall,
  //           a synthesized grounded summary, and per-source citations).
  //   narrow→ the dependable single-query client (MCP → DDG → Wikipedia). Fixes the
  //           old "0 web sources" Instant-Answer-only bug; kept as the cheap default.
  let webEvidence = [];
  let webSummary = null;        // wide path only: synthesized grounded answer
  let webConfidence = null;     // wide path only: 0..1
  if (web && keywords.length) {
    if (wide) {
      try {
        // Lazy require — wide-search requires THIS module for extractKeywords, so a
        // top-level require here would be a cycle.
        const { wideSearch } = require("./wide-search");
        const wq = (issueTitle || keywords.slice(0, 6).join(" ")).slice(0, 200);
        const r = await _withDeadline(wideSearch({
          query: wq,
          breadth: 5,
          perQuery: 3,
          // Forward each wide-search sub-step under the research phase so the run log
          // and any SSE caller see the fan-out / low-pass / high-pass ladder.
          onStep: (stage, status, extra) => emit("research", `wide_${stage}_${status}`, extra),
        }), WEB_PHASE_TIMEOUT, "wide web search");
        webEvidence = (r.sources || []).slice(0, 5).map((s) => ({ title: s.title, url: s.url, snippet: s.snippet }));
        webSummary = r.answer || null;
        webConfidence = r.confidence != null ? r.confidence : null;
        emit("research", "web_search", { mode: "wide", query: wq, results: webEvidence.length, confidence: webConfidence, sources: webEvidence.map((w) => w.url) });
      } catch (e) {
        emit("research", "web_search", { mode: "wide", skipped: true, reason: e.message });
      }
    } else {
      const searchQuery = keywords.slice(0, 4).join(" ");
      try {
        const r = await _withDeadline(webSearch(searchQuery, 3), WEB_PHASE_TIMEOUT, "narrow web search");
        if (r && r.success && Array.isArray(r.results)) {
          webEvidence = r.results.slice(0, 3).map((x) => ({ title: x.title, url: x.url, snippet: x.snippet }));
          emit("research", "web_search", { mode: "narrow", query: searchQuery, source: r.source, results: webEvidence.length, sources: webEvidence.map((w) => w.url) });
        } else {
          emit("research", "web_search", { mode: "narrow", query: searchQuery, results: 0, reason: (r && r.error) || "no results" });
        }
      } catch (e) {
        emit("research", "web_search", { mode: "narrow", skipped: true, reason: e.message });
      }
    }
  }

  const scopeFiles = await _findScopeFiles(workRoot, keywords, emit, maxFiles);

  const researchContext = {
    keywords,
    scopeFiles: scopeFiles.slice(0, maxFiles),
    // Wide grounding returns up to 5 cited sources; narrow returns up to 3. Keep all
    // returned evidence so the model sees the full grounded set.
    webEvidence: webEvidence.slice(0, 5),
    ...(webSummary ? { webSummary, webConfidence } : {}),
    timestamp: new Date().toISOString(),
  };
  emit("research", "done", {
    filesFound: scopeFiles.length,
    webSourcesFound: webEvidence.length,
    webMode: wide ? "wide" : "narrow",
    context: researchContext,
  });

  return { keywords, scopeFiles, webEvidence, webSummary, webConfidence, researchContext, runId };
}

module.exports = {
  extractKeywords,
  researchIssue,
  logStep,
  newRunId,
  STOPWORDS,
};
