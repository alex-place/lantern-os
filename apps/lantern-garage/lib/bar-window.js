'use strict';
/**
 * bar-window.js — read a TIME WINDOW out of the archived bar corpus (#3561).
 *
 * `bar-archive.js` writes the corpus; nothing has ever read it back. Every consumer so
 * far wanted "the latest bars", which `getBars` fetches live. A replay wants the
 * opposite: a fixed window around a trade that closed days ago, which no live range
 * request can express.
 *
 * The corpus is append-only and written in ascending time, so a window is a filter over
 * one file. Files run ~300KB, so the read is cheap — but a reader stepping through one
 * trade will ask repeatedly, so a parse is cached against the file's (size, mtime) and
 * thrown away the moment the archiver appends.
 *
 * COVERAGE IS PART OF THE ANSWER. A replay that silently returns three bars looks
 * identical to one that returned thirty, so every read reports what the archive actually
 * holds for that symbol — the caller needs it to say "we have no bars before Aug 24"
 * rather than drawing a flat line.
 */
const fs = require('fs');
const path = require('path');

const DIR = process.env.BAR_ARCHIVE_DIR
  ? path.resolve(process.env.BAR_ARCHIVE_DIR)
  : path.join(__dirname, '..', '..', '..', 'data', 'lantern-garage', 'trading', 'bars');

const _cache = new Map();   // file -> { key, bars }
const CACHE_MAX = 8;

function fileFor(sym, tf) {
  const safe = String(sym).toUpperCase().replace(/[^A-Z0-9.\-^]/g, '');
  return path.join(DIR, `${safe}-${tf}.jsonl`);
}

/** Whole corpus for one (symbol, timeframe), ascending. [] when there is no file. */
function load(sym, tf) {
  const f = fileFor(sym, tf);
  let st;
  try { st = fs.statSync(f); } catch (_e) { return []; }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = _cache.get(f);
  if (hit && hit.key === key) return hit.bars;

  const bars = [];
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch (_e) { return []; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch (_e) { continue; }   // torn tail line
    const t = Date.parse(d && d.t);
    if (!Number.isFinite(t)) continue;
    // Number(null) is 0, and a finite 0. A row with a missing price would become a candle
    // at zero, which would take the whole chart's scale with it -- so the absence has to
    // be tested before the coercion, not after it.
    const px = (v) => (v == null || v === '' ? NaN : Number(v));
    const o = px(d.o), h = px(d.h), l = px(d.l), c = px(d.c);
    if (![o, h, l, c].every(Number.isFinite)) continue;
    bars.push({ t, o, h, l, c, v: d.v == null ? null : Number(d.v) });
  }
  // Appended in order, but a re-run against a stale cursor could interleave; sorting
  // once here is cheaper than every consumer wondering.
  bars.sort((a, b) => a.t - b.t);
  if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
  _cache.set(f, { key, bars });
  return bars;
}

/** What the archive holds for one symbol, for saying WHY a window came back short. */
function have(sym, tf = '5m') {
  const bars = load(sym, tf);
  if (!bars.length) return { count: 0, first: null, last: null };
  return { count: bars.length, first: bars[0].t, last: bars[bars.length - 1].t };
}

/**
 * Bars with `from <= t <= to`, plus what the archive holds either side of the ask.
 * Binary search rather than a filter: the corpus is years-shaped and the window is minutes.
 */
function readWindow(sym, tf, from, to) {
  const bars = load(sym, tf);
  const held = bars.length
    ? { count: bars.length, first: bars[0].t, last: bars[bars.length - 1].t }
    : { count: 0, first: null, last: null };
  if (!bars.length) return { bars: [], held };

  let lo = 0, hi = bars.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].t < from) lo = m + 1; else hi = m; }
  const out = [];
  for (let i = lo; i < bars.length && bars[i].t <= to; i++) out.push(bars[i]);
  return { bars: out, held };
}

/*
 * The archiver keeps whatever timeframes the server fetches, so a long hold may have real
 * 1h bars on disk. Prefer them: rolling 1h up out of 5m papers over any hole in the 5m
 * corpus with a bar that looks complete, which is exactly the lie this feature exists to
 * avoid. Fall to finer data only when the coarse file does not cover the window.
 */
const FINER = { '1h': ['1h', '15m', '5m'], '15m': ['15m', '5m'], '5m': ['5m'] };

/** The best archive we hold for this window, and which timeframe it came from. */
function bestWindow(sym, wantTf, from, to) {
  const chain = FINER[wantTf] || ['5m'];
  // When nothing covers the window, report the RICHEST archive we hold for the symbol —
  // the caller turns it into "our bars run X to Y", which must name a real file.
  let widest = { count: 0, first: null, last: null };
  for (const tf of chain) {
    const w = readWindow(sym, tf, from, to);
    if (w.bars.length) return { bars: w.bars, held: w.held, tf };
    if (w.held.count > widest.count) widest = w.held;
  }
  return { bars: [], held: widest, tf: wantTf };
}

/** Test seam — the cache is keyed on mtime, which has ~ms resolution on some filesystems. */
function _clearCache() { _cache.clear(); }

module.exports = { readWindow, bestWindow, have, load, fileFor, DIR, FINER, _clearCache };
