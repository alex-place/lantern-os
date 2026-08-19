/**
 * Kalshi tight-band snapshot codec — v2 keyframe + delta JSONL.
 *
 * WHY: the v1 format re-serialized every field of every market on every 6s
 * poll. Measured on data/kalshi/tight-band-2026-08-18.jsonl (300 lines):
 * 218,403 bytes/line, of which the mutable fields account for ~4%. At ~1.5-2.5
 * GB/day that filled the 30 GB GCE disk to 100% on 2026-08-06 and broke every
 * write on the box for five days; a 14-day retention sweep was the stopgap.
 *
 * v2 emits a periodic KEYFRAME (full markets array) followed by DELTA lines
 * carrying only the fields that actually changed, per ticker, since that
 * ticker was last emitted.
 *
 * The diff is GENERIC — it compares every key rather than a hardcoded
 * "volatile fields" list. That matters: an empirical pass over 400 lines found
 * 19 fields mutating, but fields like `status` and `result` change exactly
 * once per market lifetime and can trivially fall outside any sample window.
 * A hardcoded list would silently drop them. Generic diffing is lossless by
 * construction and survives Kalshi adding fields.
 *
 * Line shapes:
 *   keyframe {v:2, ts, kf:1, c, x, markets:[ ...full market objects... ]}
 *   delta    {v:2, ts, c, x, d:{ticker:{changedField:value}}, r:[goneTicker]}
 *
 * A new ticker appearing mid-stream lands in `d` with all of its fields, which
 * the decoder merges into empty state — no special case needed.
 *
 * Decoding replays keyframe → deltas and yields rows in the ORIGINAL v1 shape
 * ({ts, markets, exitCount, snapshot:{markets}}) so existing readers need only
 * swap their line loop, not their analysis logic. v1 files decode unchanged.
 */

"use strict";

const fs = require("fs");
const zlib = require("zlib");
const readline = require("readline");

/** Lines between keyframes. 240 ≈ 24 min at the 6s cadence. */
const KEYFRAME_EVERY = parseInt(process.env.KALSHI_KEYFRAME_EVERY || "240", 10);

class SnapshotEncoder {
  constructor({ keyframeEvery = KEYFRAME_EVERY } = {}) {
    this.keyframeEvery = keyframeEvery > 0 ? keyframeEvery : 240;
    this.reset();
  }

  /** Drop all state so the next encode() emits a keyframe (use on day rollover). */
  reset() {
    this.prev = new Map();
    this.sinceKeyframe = Infinity;
  }

  /**
   * Encode one snapshot into a single JSONL line (no trailing newline).
   * Returns the string to append.
   */
  encode(snapshot, ts = new Date().toISOString()) {
    const markets = Array.isArray(snapshot?.markets) ? snapshot.markets : [];
    const c = markets.length;
    const x = snapshot?.exitCount || 0;

    if (this.sinceKeyframe >= this.keyframeEvery) {
      this.prev = new Map();
      for (const m of markets) if (m && m.ticker) this.prev.set(m.ticker, m);
      this.sinceKeyframe = 1;
      return JSON.stringify({ v: 2, ts, kf: 1, c, x, markets });
    }

    const d = {};
    const live = new Set();
    for (const m of markets) {
      if (!m || !m.ticker) continue;
      live.add(m.ticker);
      const p = this.prev.get(m.ticker);
      if (!p) {
        d[m.ticker] = m; // first sighting — full object
        this.prev.set(m.ticker, m);
        continue;
      }
      const diff = {};
      // Changed or newly-present keys.
      for (const k of Object.keys(m)) {
        if (JSON.stringify(m[k]) !== JSON.stringify(p[k])) diff[k] = m[k];
      }
      // Keys that disappeared — record an explicit null so decode stays lossless.
      for (const k of Object.keys(p)) {
        if (!(k in m)) diff[k] = null;
      }
      if (Object.keys(diff).length) {
        d[m.ticker] = diff;
        this.prev.set(m.ticker, m);
      }
    }

    const r = [];
    for (const ticker of this.prev.keys()) if (!live.has(ticker)) r.push(ticker);
    for (const ticker of r) this.prev.delete(ticker);

    this.sinceKeyframe++;
    const row = { v: 2, ts, c, x, d };
    if (r.length) row.r = r;
    return JSON.stringify(row);
  }
}

/** Open a .jsonl or .jsonl.gz path as a line stream. */
function lineStream(filePath) {
  let input = fs.createReadStream(filePath);
  if (filePath.endsWith(".gz")) input = input.pipe(zlib.createGunzip());
  return readline.createInterface({ input, crlfDelay: Infinity });
}

/**
 * Async-iterate a tight-band file, yielding rows in the v1 shape:
 *   {ts, markets, exitCount, snapshot: {markets, count, generatedAt}}
 * Handles v1 files, v2 files, and gzipped variants of both.
 */
async function* iterateSnapshots(filePath) {
  const rl = lineStream(filePath);
  const state = new Map();
  let sawKeyframe = false;

  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // tolerate a torn final line from an unclean shutdown
    }

    // v1 passthrough.
    if (row.v !== 2) {
      if (row.snapshot) yield row;
      continue;
    }

    if (row.kf) {
      state.clear();
      for (const m of row.markets || []) if (m && m.ticker) state.set(m.ticker, { ...m });
      sawKeyframe = true;
    } else {
      if (!sawKeyframe && state.size === 0) {
        // File opened mid-stream (truncated head). Deltas carry full objects
        // for first-sighting tickers, so we can still rebuild progressively.
        sawKeyframe = true;
      }
      for (const [ticker, diff] of Object.entries(row.d || {})) {
        const cur = state.get(ticker) || {};
        for (const [k, v] of Object.entries(diff)) {
          if (v === null) delete cur[k];
          else cur[k] = v;
        }
        cur.ticker = cur.ticker || ticker;
        state.set(ticker, cur);
      }
      for (const ticker of row.r || []) state.delete(ticker);
    }

    const markets = [...state.values()];
    yield {
      ts: row.ts,
      markets: row.c ?? markets.length,
      exitCount: row.x || 0,
      snapshot: {
        count: markets.length,
        exitCount: row.x || 0,
        generatedAt: row.ts,
        markets,
      },
    };
  }
}

module.exports = { SnapshotEncoder, iterateSnapshots, lineStream, KEYFRAME_EVERY };
