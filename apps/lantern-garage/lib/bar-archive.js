'use strict';
/**
 * bar-archive.js — rolling intraday bar corpus (Observe stage, #3165).
 *
 * WHY: free intraday history is capped (~30 days of 15m bars from Yahoo), so
 * every entry-quality experiment is stuck testing against ONE market window —
 * on 2026-08-04 that single window couldn't distinguish "bad filter" from
 * "bad month". The server already fetches these bars all day for the charts
 * and the scanner; archiving the completed ones costs ~nothing and compounds
 * into a multi-regime corpus the backtests can actually learn from.
 *
 * WHAT: append-only JSONL per (symbol, timeframe) under
 * data/lantern-garage/trading/bars/ (override: BAR_ARCHIVE_DIR). Only bars
 * STRICTLY NEWER than the last archived row are appended, and the newest
 * fetched bar is dropped as possibly still forming. Disable: BAR_ARCHIVE=0.
 *
 * Fail-soft everywhere: an archive error must never break a price fetch.
 */
const fs = require('fs');
const path = require('path');

const DIR = process.env.BAR_ARCHIVE_DIR
  ? path.resolve(process.env.BAR_ARCHIVE_DIR)
  : path.join(__dirname, '..', '..', '..', 'data', 'lantern-garage', 'trading', 'bars');
// Research timeframes only — 1m is noise-heavy bulk, daily is freely re-fetchable.
const TFS = new Set(['5m', '15m', '1h']);
const _lastTs = new Map();   // "SYM|tf" -> newest archived bar time (ms)
let _dirReady = false;

function fileFor(sym, tf) {
  const safe = String(sym).toUpperCase().replace(/[^A-Z0-9.\-^]/g, '');
  return path.join(DIR, `${safe}-${tf}.jsonl`);
}

// Newest archived timestamp: read only the file's tail — the corpus grows
// unbounded and must never be re-read whole on every boot.
function lastArchivedTs(sym, tf) {
  const key = `${String(sym).toUpperCase()}|${tf}`;
  if (_lastTs.has(key)) return _lastTs.get(key);
  let ts = 0;
  try {
    const f = fileFor(sym, tf);
    const st = fs.statSync(f);
    const len = Math.min(st.size, 4096);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(f, 'r');
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const t = Date.parse(JSON.parse(lines[i]).t); if (t) { ts = t; break; } } catch (_e) { /* torn tail line */ }
    }
  } catch (_e) { /* no file yet */ }
  _lastTs.set(key, ts);
  return ts;
}

/** Append the COMPLETED bars newer than what's already on disk. Never throws. */
function archive(sym, tf, bars) {
  try {
    if (process.env.BAR_ARCHIVE === '0') return 0;
    if (!TFS.has(tf) || !Array.isArray(bars) || bars.length < 2) return 0;
    const done = bars.slice(0, -1);              // last bar may still be forming
    const since = lastArchivedTs(sym, tf);
    const fresh = done.filter((b) => b && b.timestamp && Date.parse(b.timestamp) > since);
    if (!fresh.length) return 0;
    if (!_dirReady) { fs.mkdirSync(DIR, { recursive: true }); _dirReady = true; }
    const rows = fresh.map((b) =>
      JSON.stringify({ t: b.timestamp, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume ?? null })).join('\n') + '\n';
    fs.appendFileSync(fileFor(sym, tf), rows);
    _lastTs.set(`${String(sym).toUpperCase()}|${tf}`, Date.parse(fresh[fresh.length - 1].timestamp));
    return fresh.length;
  } catch (_e) { return 0; }
}

module.exports = { archive, lastArchivedTs, DIR };
