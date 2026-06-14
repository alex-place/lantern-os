/**
 * kalshi-paper-ledger.js — Paper position tracker + history for Kalshi terminal
 *
 * Paper positions are stored in data/kalshi/paper-positions.jsonl
 * Each line is a JSON event:
 *   { event: 'open',  id, ticker, title, side, entryCents, count, openedAt }
 *   { event: 'close', id, ticker, title, side, entryCents, exitPriceCents, pnlPct, exitTag, closedAt }
 *
 * Stop-loss:   pnlPct <= -30
 * Take-profit: pnlPct >= +40
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const REPO_ROOT      = path.resolve(__dirname, '..', '..', '..');
const LEDGER_PATH    = path.join(REPO_ROOT, 'data', 'kalshi', 'paper-positions.jsonl');
const STOP_LOSS_PCT  = -30;
const TAKE_PROFIT_PCT = 40;

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDir() {
  const dir = path.dirname(LEDGER_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function appendEvent(record) {
  ensureDir();
  fs.appendFileSync(LEDGER_PATH, JSON.stringify(record) + '\n', 'utf8');
}

function readAllEvents() {
  if (!fs.existsSync(LEDGER_PATH)) return [];
  return fs.readFileSync(LEDGER_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// ── Core operations ───────────────────────────────────────────────────────────

/**
 * Open a paper position.
 * @param {Object} p — { ticker, title, side, entryCents, count }
 * @returns {Object} the opened position record
 */
function openPosition(p) {
  const id = `paper_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const record = {
    event:       'open',
    id,
    ticker:      p.ticker,
    title:       p.title || p.ticker,
    side:        p.side || 'yes',
    entryCents:  Number(p.entryCents) || 50,
    count:       Number(p.count) || 1,
    openedAt:    new Date().toISOString(),
  };
  appendEvent(record);
  return record;
}

/**
 * Close a paper position by id.
 * @param {string} id — position id
 * @param {number} exitPriceCents — current bid/ask price in cents
 * @param {string} [exitTag] — 'MANUAL' | 'STOP-LOSS' | 'TAKE-PROFIT'
 * @returns {Object|null} the close record, or null if position not found
 */
function closePosition(id, exitPriceCents, exitTag = 'MANUAL') {
  const open = getOpenPositions().find(p => p.id === id);
  if (!open) return null;

  const pnlPct = Math.round(((exitPriceCents - open.entryCents) / open.entryCents) * 100);
  const record = {
    event:          'close',
    id,
    ticker:         open.ticker,
    title:          open.title,
    side:           open.side,
    entryCents:     open.entryCents,
    exitPriceCents: Number(exitPriceCents),
    pnlPct,
    exitTag,
    closedAt:       new Date().toISOString(),
  };
  appendEvent(record);
  return record;
}

/**
 * Get currently open positions (open events without a matching close).
 */
function getOpenPositions() {
  const events   = readAllEvents();
  const openMap  = new Map();
  const closedIds = new Set();

  for (const ev of events) {
    if (ev.event === 'open')  openMap.set(ev.id, ev);
    if (ev.event === 'close') closedIds.add(ev.id);
  }

  return [...openMap.values()].filter(p => !closedIds.has(p.id));
}

/**
 * Get closed trade history.
 * @param {number} limit — max results (newest first)
 * @returns {{ count, winRate, avgPnlPct, trades }}
 */
function getHistory(limit = 20) {
  const events = readAllEvents();
  const openMap = new Map();

  // Build a lookup of open events for enriching close records
  for (const ev of events) {
    if (ev.event === 'open') openMap.set(ev.id, ev);
  }

  const closed = events
    .filter(ev => ev.event === 'close')
    .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))
    .slice(0, limit)
    .map(ev => {
      const open = openMap.get(ev.id) || {};
      return {
        id:             ev.id,
        ticker:         ev.ticker || open.ticker,
        title:          ev.title  || open.title,
        side:           ev.side   || open.side,
        entryCents:     ev.entryCents,
        exitPriceCents: ev.exitPriceCents,
        pnlPct:         ev.pnlPct,
        exitTag:        ev.exitTag || 'MANUAL',
        closedAt:       ev.closedAt,
        openedAt:       open.openedAt,
      };
    });

  const wins    = closed.filter(t => t.pnlPct > 0).length;
  const winRate = closed.length > 0 ? Math.round((wins / closed.length) * 100) : 0;
  const avgPnl  = closed.length > 0
    ? Math.round(closed.reduce((s, t) => s + t.pnlPct, 0) / closed.length)
    : 0;

  return { count: closed.length, winRate, avgPnlPct: avgPnl, trades: closed };
}

/**
 * Evaluate open positions against current prices.
 * Marks autoExit if stop-loss or take-profit threshold is crossed.
 * @param {Map<string,number>} priceMap — ticker → currentBidCents
 * @returns {Array} enriched positions with pnlPct and autoExit flag
 */
function evaluatePositions(priceMap) {
  return getOpenPositions().map(p => {
    const currentBid = priceMap.get(p.ticker) ?? p.entryCents;
    const pnlPct = Math.round(((currentBid - p.entryCents) / p.entryCents) * 100);
    let autoExit = null;
    if (pnlPct <= STOP_LOSS_PCT)   autoExit = 'STOP-LOSS';
    if (pnlPct >= TAKE_PROFIT_PCT) autoExit = 'TAKE-PROFIT';
    return { ...p, currentBid, pnlPct, autoExit };
  });
}

module.exports = {
  openPosition,
  closePosition,
  getOpenPositions,
  getHistory,
  evaluatePositions,
  STOP_LOSS_PCT,
  TAKE_PROFIT_PCT,
  LEDGER_PATH,
};
