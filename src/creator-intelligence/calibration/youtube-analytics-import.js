// Creator Intelligence — YouTube Studio analytics importer
// Parses a YouTube Studio "Table data" CSV export (the per-video table you get
// from Analytics → Advanced mode → Export → CSV) into normalized OUTCOME rows.
//
// HONESTY: this only ever reports metrics that physically appear in the export.
// A column that is absent is OMITTED from the outcome (never defaulted to 0).
// The aggregate "Total" row and any row without a real video identity are
// skipped. This is the operator's OWN first-party analytics — the only honest
// ground-truth reward signal for calibration (see docs/creator-v10/learning-pipeline-research.md).

"use strict";

// Map normalized header text -> canonical outcome field. Matched by substring so
// locale/report variations ("Views", "Views (Shorts)") still resolve. Order
// matters: more specific patterns are tested before generic ones.
const COLUMN_MATCHERS = [
  { field: "ctrPercent", test: (h) => h.includes("click-through") || h.includes("click through") || (h.includes("ctr")) },
  { field: "impressions", test: (h) => h.includes("impressions") },
  { field: "avgPercentViewed", test: (h) => h.includes("average percentage viewed") || (h.includes("average") && h.includes("percentage")) },
  { field: "avgViewDurationSec", test: (h) => h.includes("average view duration") },
  { field: "watchTimeHours", test: (h) => h.includes("watch time") && h.includes("hour") },
  { field: "subscribersGained", test: (h) => h.includes("subscriber") },
  { field: "shares", test: (h) => h.includes("shares") },
  { field: "likes", test: (h) => h === "likes" || h.includes("likes (") || h.includes("like count") },
  { field: "comments", test: (h) => h.includes("comments added") || h === "comments" },
  { field: "views", test: (h) => h === "views" || h.includes("views") },
  { field: "publishTime", test: (h) => h.includes("publish") },
  { field: "title", test: (h) => h.includes("video title") || h === "title" },
  // "Content" is YouTube's column for the video id in table exports.
  { field: "videoId", test: (h) => h === "content" || h.includes("video id") || h === "video" },
];

// Fields whose values are plain numbers (after stripping separators).
const NUMERIC_FIELDS = new Set([
  "views", "impressions", "watchTimeHours", "avgPercentViewed",
  "ctrPercent", "subscribersGained", "shares", "likes", "comments",
]);

function stripBom(s) {
  return s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function normalizeHeader(h) {
  return String(h).trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Parse one CSV line into fields, honoring double-quoted fields that may
 * contain commas and escaped ("") quotes. Minimal RFC-4180 subset.
 */
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Parse "1,234" / "12.3%" / "1 234" -> 1234 / 12.3. Returns null if not numeric. */
function parseNumber(raw) {
  if (raw === undefined || raw === null) return null;
  const cleaned = String(raw).replace(/[%,\s ]/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Parse "m:ss", "h:mm:ss", or a bare seconds count -> seconds. null if unparseable. */
function parseDurationToSeconds(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s === "" || s === "-") return null;
  if (s.includes(":")) {
    const parts = s.split(":").map((p) => Number(p));
    if (parts.some((p) => !Number.isFinite(p))) return null;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build header field -> column index map from the header row.
 * @returns {Object<string, number>}
 */
function mapColumns(headerCells) {
  const mapping = {};
  headerCells.forEach((cell, idx) => {
    const h = normalizeHeader(cell);
    for (const m of COLUMN_MATCHERS) {
      if (mapping[m.field] !== undefined) continue; // first match wins
      if (m.test(h)) { mapping[m.field] = idx; break; }
    }
  });
  return mapping;
}

function isAggregateRow(videoId, title) {
  const id = (videoId || "").toLowerCase();
  const t = (title || "").toLowerCase();
  return id === "total" || id === "" && (t === "total" || t === "");
}

/**
 * Parse a YouTube Studio table CSV into normalized outcome records.
 *
 * @param {string} text  raw CSV file contents
 * @returns {{
 *   rows: Array<{videoId, title, publishTime, outcome: Object, raw: Object}>,
 *   columns: Object<string,number>,
 *   skipped: Array<{line:number, reason:string}>,
 *   recognizedMetrics: string[]
 * }}
 */
function parseAnalyticsCsv(text) {
  const result = { rows: [], columns: {}, skipped: [], recognizedMetrics: [] };
  if (typeof text !== "string" || text.trim() === "") return result;

  const lines = stripBom(text).split(/\r?\n/);
  // Find the first non-empty line as the header.
  let headerIdx = lines.findIndex((l) => l.trim() !== "");
  if (headerIdx === -1) return result;

  const columns = mapColumns(parseCsvLine(lines[headerIdx]));
  result.columns = columns;

  const metricFields = Object.keys(columns).filter(
    (f) => f !== "videoId" && f !== "title" && f !== "publishTime"
  );
  result.recognizedMetrics = metricFields;

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const cells = parseCsvLine(line);

    const at = (field) => (columns[field] !== undefined ? cells[columns[field]] : undefined);
    const videoId = at("videoId");
    const title = at("title");

    if (isAggregateRow(videoId, title)) {
      result.skipped.push({ line: i + 1, reason: "aggregate/total row" });
      continue;
    }
    if (!videoId && !title) {
      result.skipped.push({ line: i + 1, reason: "no video identity (id or title)" });
      continue;
    }

    // Build the outcome from ONLY the metrics actually present.
    const outcome = {};
    for (const field of metricFields) {
      const rawVal = at(field);
      let val;
      if (field === "avgViewDurationSec") val = parseDurationToSeconds(rawVal);
      else if (NUMERIC_FIELDS.has(field)) val = parseNumber(rawVal);
      else continue;
      if (val !== null) outcome[field] = val;
    }

    if (Object.keys(outcome).length === 0) {
      result.skipped.push({ line: i + 1, reason: "row had no parseable metrics" });
      continue;
    }

    result.rows.push({
      videoId: videoId || null,
      title: title || null,
      publishTime: at("publishTime") || null,
      outcome,
      raw: cells,
    });
  }

  return result;
}

module.exports = {
  parseAnalyticsCsv,
  // exported for unit testing
  parseCsvLine, parseNumber, parseDurationToSeconds, mapColumns, normalizeHeader,
};
