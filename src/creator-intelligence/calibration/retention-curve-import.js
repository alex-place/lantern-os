// Creator Intelligence — audience-retention curve importer (A4)
// Parses a YouTube Studio "Audience retention" CSV export into a normalized
// second-by-second curve. This is the richest first-party outcome we can get:
// it shows exactly WHERE viewers leave, which (aligned to the edit timeline)
// tells the editing model which edits shed viewers.
//
// HONESTY: positions and retention are normalized to [0,1] from whatever the
// export provides (ratio or %); only columns that actually exist are used; a
// file we can't recognize yields an empty curve, never a fabricated one.
//
// See docs/creator-v10/editing-analysis-model-research.md (A4)

"use strict";

const { parseCsvLine, parseNumber, normalizeHeader } = require("./youtube-analytics-import");

function findColumns(headerCells) {
  let positionIdx, retentionIdx;
  headerCells.forEach((cell, idx) => {
    const h = normalizeHeader(cell);
    if (positionIdx === undefined &&
        (h.includes("position") || (h.includes("elapsed") && h.includes("time")))) {
      positionIdx = idx;
    }
    // "retention", "audience watch ratio", "audience watched" — first match wins.
    if (retentionIdx === undefined &&
        (h.includes("retention") || h.includes("watch ratio") || h.includes("watched"))) {
      retentionIdx = idx;
    }
  });
  return { positionIdx, retentionIdx };
}

// Normalize a column of raw values to [0,1]: if anything exceeds ~1.5 the column
// is almost certainly a percentage (0–100), so divide by 100.
function normalizeColumn(values) {
  const max = values.reduce((m, v) => (v > m ? v : m), 0);
  const scale = max > 1.5 ? 100 : 1;
  return values.map((v) => v / scale);
}

/**
 * Parse an audience-retention CSV into a sorted, normalized curve.
 * @param {string} text
 * @returns {{ points: Array<{position:number, retention:number}>,
 *             recognized: boolean, rows: number }}
 */
function parseRetentionCsv(text) {
  const empty = { points: [], recognized: false, rows: 0 };
  if (typeof text !== "string" || text.trim() === "") return empty;

  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.trim() !== "");
  if (headerIdx === -1) return empty;

  const { positionIdx, retentionIdx } = findColumns(parseCsvLine(lines[headerIdx]));
  if (positionIdx === undefined || retentionIdx === undefined) return empty;

  const rawPos = [];
  const rawRet = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    const cells = parseCsvLine(lines[i]);
    const p = parseNumber(cells[positionIdx]);
    const r = parseNumber(cells[retentionIdx]);
    if (p === null || r === null) continue;
    rawPos.push(p);
    rawRet.push(r);
  }
  if (rawPos.length === 0) return empty;

  const pos = normalizeColumn(rawPos);
  const ret = normalizeColumn(rawRet);
  const points = pos
    .map((p, i) => ({ position: Number(p.toFixed(4)), retention: Number(ret[i].toFixed(4)) }))
    .sort((a, b) => a.position - b.position);

  return { points, recognized: true, rows: points.length };
}

module.exports = { parseRetentionCsv, findColumns, normalizeColumn };
