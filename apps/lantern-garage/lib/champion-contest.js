'use strict';

/**
 * champion-contest.js — the paper-trading CONTEST. Every signed-in user (Free, Pro,
 * or Pilot) can start/stop a virtual Champion book with a goal and compete in ONE
 * shared leaderboard. Loop stage: Act (paper) + Verify (measured, ranked).
 *
 * Design: each user's book is a VIRTUAL paper portfolio — at start it "buys" the
 * Champion target mix (champion-book.targetWeights × the streaming brake's gross)
 * with a fixed starting equity, then is marked to market against REAL prices on
 * every read. No per-user Alpaca account, no real orders, no real money — so the
 * pool can include everyone. Rank = realized+unrealized return %.
 *
 * One book per user (starting again resets it). State persists in a single JSON map
 * so the leaderboard is a cheap read. The pure math (buildHoldings / markBook /
 * rankBooks) is unit-tested; IO (store, price fetch) wraps it.
 */

const fs = require('fs');
const path = require('path');
const champion = require('./champion-book');

const STORE = process.env.CHAMPION_CONTEST_STORE
  ? path.resolve(process.env.CHAMPION_CONTEST_STORE)
  : path.join(__dirname, '..', 'data', 'lantern-garage', 'trading', 'champion-contest.json');
const START_EQUITY = 100000;   // every contestant starts with the same virtual $100k
const UNIVERSE = champion.UNIVERSE;

// Resolve a Free/Pro/Pilot badge from a session user's role/tier. Robust to the
// plan-matrix gap where the `pilot` ROLE has no ROLE_TO_PLAN entry (→ would default
// to 'free'): a role or tier that IS a plan name is honored directly, else fall back
// to planForRole. Display-only — it does not gate anything (the pool is inclusive).
function planBadge(role, tier) {
  const t = String(tier || '').toLowerCase();
  if (t === 'free' || t === 'pro' || t === 'pilot') return t;
  const r = String(role || '').toLowerCase();
  if (r === 'free' || r === 'pro' || r === 'pilot') return r;
  if (r === 'admin' || r === 'tech_support') return 'pilot';
  return require('./plan-matrix').planForRole(r);
}

// ── store (single JSON map: userId → book) ──────────────────────────────────
function _readStore() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')) || {}; } catch (_e) { return {}; }
}
function _writeStore(obj) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  const tmp = STORE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, STORE);   // atomic replace
}

// ── pure math ────────────────────────────────────────────────────────────────
/** "Buy" the target mix with `equity`: holdings[sym] = shares (fractional). */
function buildHoldings(weights, prices, equity, gross = 1) {
  const g = Math.max(0, Math.min(champion.MAX_GROSS, gross));
  const holdings = {};
  for (const [s, w] of Object.entries(weights)) {
    const px = Number(prices[s]) || 0;
    if (px > 0 && w > 0) holdings[s] = (equity * g * w) / px;
  }
  return holdings;
}

/** Mark a book to market: equity = cash + Σ shares·price. Cash models the un-invested
 *  remainder (gross<1) and is carried flat (no interest, keeps the contest simple). */
function markBook(book, prices) {
  let invested = 0;
  for (const [s, sh] of Object.entries(book.holdings || {})) invested += sh * (Number(prices[s]) || 0);
  const equity = (Number(book.cash) || 0) + invested;
  const ret = book.startEquity > 0 ? (equity / book.startEquity - 1) : 0;
  return { equity: Math.round(equity * 100) / 100, returnPct: Math.round(ret * 1000) / 10 };
}

/** Rank marked books best-return-first. Ties broken by later start (newer effort). */
function rankBooks(books) {
  return [...books].sort((a, b) => (b.returnPct - a.returnPct) || (new Date(b.startedAt) - new Date(a.startedAt)))
    .map((b, i) => ({ rank: i + 1, ...b }));
}

// ── prices + gross ────────────────────────────────────────────────────────────
async function _prices() {
  const yahoo = require('./market-data-yahoo');
  const bm = await yahoo.getBarsMulti(UNIVERSE, '1d').catch(() => ({ bars: {} }));
  const bars = (bm && bm.bars) || {};
  const prices = {}; const closesBySym = {};
  for (const s of UNIVERSE) {
    const b = (bars[s] && bars[s].bars) || [];
    closesBySym[s] = b.map((x) => x.close);
    if (b.length) prices[s] = b[b.length - 1].close;
  }
  return { prices, closesBySym };
}

// ── public API ─────────────────────────────────────────────────────────────
/** Start (or restart) a user's contest book. Returns the started book. */
async function start(userId, { name, role, tier, goal = null } = {}) {
  if (!userId) return { ok: false, reason: 'not_signed_in' };
  const { prices, closesBySym } = await _prices();
  const { weights } = champion.targetWeights(closesBySym);
  if (!Object.keys(weights).length) return { ok: false, reason: 'no_market_data' };
  // Contest books are UNLEVERAGED (#2552): clamp gross to ≤1 so a book never buys
  // more than its starting equity. The live operator book uses gross up to 2× for
  // vol-targeting, but markBook values the whole position as equity without booking
  // the borrowed half — which showed every fresh book at an absurd +100%. Clamping
  // keeps the risk-OFF behaviour (gross<1 → a cash buffer, still marks to startEquity)
  // while removing the phantom leverage, so returns reflect real price movement.
  const gross = Math.min(1, champion._liveGross());
  const holdings = buildHoldings(weights, prices, START_EQUITY, gross);
  let invested = 0; for (const [s, sh] of Object.entries(holdings)) invested += sh * prices[s];
  const book = {
    userId, name: name || 'Anonymous', plan: planBadge(role, tier),
    goal, status: 'running', startEquity: START_EQUITY, cash: Math.max(0, START_EQUITY - invested),
    holdings, weights, gross, startedAt: new Date().toISOString(), stoppedAt: null,
  };
  const store = _readStore(); store[userId] = book; _writeStore(store);
  return { ok: true, book: { ...book, ...markBook(book, prices) } };
}

/** Stop a user's book (freeze it at the last mark). */
async function stop(userId) {
  const store = _readStore(); const book = store[userId];
  if (!book) return { ok: false, reason: 'no_book' };
  const { prices } = await _prices();
  const m = markBook(book, prices);
  book.status = 'stopped'; book.stoppedAt = new Date().toISOString();
  book.finalEquity = m.equity; book.finalReturnPct = m.returnPct;
  _writeStore(store);
  return { ok: true, book: { ...book, ...m } };
}

/** A user's own book, marked live. */
async function myBook(userId) {
  const store = _readStore(); const book = store[userId];
  if (!book) return { ok: true, book: null };
  const { prices } = await _prices();
  return { ok: true, book: { ...book, ...markBook(book, prices) } };
}

/** The whole pool, marked live and ranked — Free, Pro, Pilot together. */
async function leaderboard({ limit = 100 } = {}) {
  const store = _readStore();
  const { prices } = await _prices();
  const rows = Object.values(store).map((b) => {
    const m = b.status === 'stopped' && b.finalEquity != null
      ? { equity: b.finalEquity, returnPct: b.finalReturnPct }   // frozen at stop
      : markBook(b, prices);
    return { name: b.name, plan: b.plan, goal: b.goal, status: b.status, startedAt: b.startedAt, ...m };
  });
  const ranked = rankBooks(rows).slice(0, limit);
  const byPlan = { free: 0, pro: 0, pilot: 0 };
  for (const r of rows) if (byPlan[r.plan] != null) byPlan[r.plan]++;
  return { ok: true, count: rows.length, byPlan, leaderboard: ranked, generatedAt: new Date().toISOString() };
}

module.exports = { start, stop, myBook, leaderboard, buildHoldings, markBook, rankBooks, planBadge, START_EQUITY, STORE };
