"use strict";
/**
 * adaptive-depth.js — the washout threshold follows the strategy's OWN recent result.
 *
 * WHY (2026-09-26): on four consolidated out-of-sample windows the armed stack made
 * +10% (Apr-Jul 2026), +18% (Jul-Sep 2026), +5% (Q1 2026) and LOST 5% (Q4 2025). No
 * static knob protected the losing quarter without taxing the trending ones at ~1:3,
 * and keying the depth to SPY's trend failed too (a falling SPY marks the best bounces
 * in a bull tape). Keying it to the trader's own trailing P&L did not: with
 * N=10 sessions, trigger 0%, 0.30 -> 0.15 the losing quarter went -4.86% -> -1.27% at
 * half the drawdown, Apr-Jul cost 0.15pp, Jul-Sep was untouched (the throttle never
 * fires in a winning stretch), Q1 cost 0.48pp at a 1.3pp lower drawdown
 * (ledger: adaptive-trailing-pnl-depth).
 *
 * WHAT: after 11:00 ET the IBS washout threshold used by the scan is the normal
 * TRADER_IBS_MAX while the account's MTM return over the last N completed sessions is
 * >= X percent, and TRADER_ADAPTIVE_IBS_PNL's deep value while it is below. The morning
 * threshold (TRADER_IBS_MAX_MORNING) is never touched.
 *
 * SHADOW FIRST. Unset = off, no behaviour change. TRADER_ADAPTIVE_IBS_PNL="N:X:up:dn"
 * with TRADER_ADAPTIVE_IBS_MODE=shadow (the default) computes the rule, journals its
 * state once per session and every entry signal it WOULD have blocked, and changes
 * nothing. MODE=live blocks those signals. The harness that validated the rule modeled
 * it at the signal level (experiments/replay_two_sleeve.js REPLAY_ADAPTIVE_PNL); the
 * shadow journal is the parity check against the live scan before any arm.
 *
 * The trailing return is read from the `session` rows the brain writes at the close
 * (date + equity). Explicit TRADER_ADAPTIVE_JOURNAL wins; else the engine's scan worker
 * (whose TRADER_TRADES_LOG is <id>.scan.jsonl) is mapped to its <id>.autopilot-trades.jsonl;
 * else TRADER_TRADES_LOG; else the default ledger.
 */
const fs = require("fs");
const path = require("path");

const DEFAULT_LEDGER = require('../app-paths').dataPath('lantern-garage', 'trading', 'autopilot-trades.jsonl');

function parseSpec(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return null;
  const parts = s.split(":").map((x) => Number(x));
  const [n, x, up, dn] = parts;
  if (!Number.isFinite(n) || n < 1) return null;
  const spec = { n: Math.floor(n), x: Number.isFinite(x) ? x : 0, up: Number.isFinite(up) && up > 0 ? up : null, dn: Number.isFinite(dn) && dn > 0 ? dn : 0.15 };
  return spec;
}

function mode() {
  const m = String(process.env.TRADER_ADAPTIVE_IBS_MODE || "shadow").toLowerCase();
  return m === "live" ? "live" : "shadow";
}

function journalPath() {
  if (process.env.TRADER_ADAPTIVE_JOURNAL) return path.resolve(process.env.TRADER_ADAPTIVE_JOURNAL);
  const t = process.env.TRADER_TRADES_LOG;
  if (t) { const r = path.resolve(t); return /\.scan\.jsonl$/i.test(r) ? r.replace(/\.scan\.jsonl$/i, ".autopilot-trades.jsonl") : r; }
  return DEFAULT_LEDGER;
}

// The writer for the shadow rows: same ledger the scan's polarity rows use (TRADER_TRADES_LOG
// honored, so tests never touch production). Own writer, no require of auto-trader (cycle).
function shadowLogPath() {
  return process.env.TRADER_TRADES_LOG ? path.resolve(process.env.TRADER_TRADES_LOG) : DEFAULT_LEDGER;
}

const etDate = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** Session equities by ET date from the ledger's `session` rows (last row per date wins), ascending. */
function readSessions(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (_e) { return []; }
  const byDate = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.indexOf('"session"') < 0) continue;
    let r; try { r = JSON.parse(line); } catch (_e) { continue; }
    if (!r || r.event !== "session") continue;
    const d = r.date || (r.ts ? etDate(Date.parse(r.ts)) : null);
    const eq = Number(r.equity);
    if (!d || !Number.isFinite(eq) || eq <= 0) continue;
    byDate.set(d, eq);
  }
  return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, equity]) => ({ date, equity }));
}

/**
 * MTM return (percent) over the last n completed sessions strictly before `today` (ET date).
 * null when fewer than n+1 sessions exist — the rule then stays at the normal threshold.
 */
function trailingReturnPct(sessions, n, today) {
  const done = today ? sessions.filter((s) => s.date < today) : sessions;
  if (done.length < n + 1) return null;
  const a = done[done.length - 1].equity, b = done[done.length - 1 - n].equity;
  return b > 0 ? (a / b - 1) * 100 : null;
}

let _cache = { file: null, mtimeMs: 0, sessions: [] };
function sessionsCached(file) {
  let st; try { st = fs.statSync(file); } catch (_e) { return []; }
  if (_cache.file === file && _cache.mtimeMs === st.mtimeMs) return _cache.sessions;
  const sessions = readSessions(file);
  _cache = { file, mtimeMs: st.mtimeMs, sessions };
  return sessions;
}

/**
 * The rule's state for this scan. null when the knob is unset.
 *   { spec, mode, journal, today, trailingPct, deep, thrDeep }
 */
function current(opts = {}) {
  const spec = parseSpec(process.env.TRADER_ADAPTIVE_IBS_PNL);
  if (!spec) return null;
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const journal = opts.journal || journalPath();
  const sessions = opts.sessions || sessionsCached(journal);
  const today = etDate(nowMs);
  const trailingPct = trailingReturnPct(sessions, spec.n, today);
  const deep = trailingPct != null && trailingPct < spec.x;
  return { spec, mode: mode(), journal, today, trailingPct, deep, thrDeep: spec.dn, sessions: sessions.length };
}

/**
 * Pure decision for one signal: given the live threshold and IBS reading, would the
 * adaptive rule block this washout? Only after 11:00 ET, only when deep, only for a
 * signal the live threshold admits, and only when the IBS sits above the deep threshold.
 */
function decide({ ibs, thrLive, state, etMin }) {
  const admits = ibs != null && ibs <= thrLive;
  if (!state || !state.deep || etMin == null || etMin < 660 || !admits) return { admits, wouldBlock: false, thrEffective: thrLive };
  const wouldBlock = ibs > state.thrDeep;
  return { admits, wouldBlock, thrEffective: state.thrDeep };
}

// ---- shadow journal: one state row per session, one row per (symbol, session hour) that would be blocked
const _logged = new Set();
function _append(row) {
  try { fs.appendFileSync(shadowLogPath(), JSON.stringify(row) + "\n"); } catch (_e) { /* instrumentation never breaks the scan */ }
}
function journalState(state, nowMs) {
  if (!state) return false;
  const key = `state:${state.today}:${state.deep ? 1 : 0}`;
  if (_logged.has(key)) return false;
  _logged.add(key);
  _append({ ts: new Date(nowMs != null ? nowMs : Date.now()).toISOString(), event: "adaptive_depth_state", date: state.today, mode: state.mode,
    n: state.spec.n, x: state.spec.x, thr_deep: state.thrDeep, trailing_pct: state.trailingPct == null ? null : +state.trailingPct.toFixed(3), deep: state.deep, sessions_seen: state.sessions });
  return true;
}
function journalDecision({ symbol, ibs, thrLive, state, etMin, price, nowMs }) {
  if (!state || !state.deep || etMin == null || etMin < 570 || etMin >= 960) return false;   // in-session only: the veto-ledger lesson
  const ms = nowMs != null ? nowMs : Date.now();
  const key = `${symbol}:${state.today}:${Math.floor(etMin / 60)}`;
  if (_logged.has(key)) return false;
  _logged.add(key);
  _append({ ts: new Date(ms).toISOString(), event: state.mode === "live" ? "adaptive_depth_block" : "adaptive_depth_shadow", symbol, price: Number(price) || null,
    ibs: ibs == null ? null : +Number(ibs).toFixed(3), thr_live: thrLive, thr_deep: state.thrDeep, trailing_pct: state.trailingPct == null ? null : +state.trailingPct.toFixed(3), et_min: etMin, mode: state.mode, would_block: true });
  return true;
}
function _resetForTests() { _logged.clear(); _cache = { file: null, mtimeMs: 0, sessions: [] }; }

module.exports = { parseSpec, mode, journalPath, shadowLogPath, readSessions, trailingReturnPct, current, decide, journalState, journalDecision, _resetForTests };
