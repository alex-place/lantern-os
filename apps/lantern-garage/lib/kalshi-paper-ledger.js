"use strict";

/**
 * Paper trading ledger for Kalshi dry-run positions.
 * Records entries, polls current market prices, auto-exits on stop-loss / take-profit.
 *
 * Stop-loss  : pnlPct <= -30  (e.g. bought YES @ 50¢, now bid 35¢ → -30%)
 * Take-profit: pnlPct >= +40  (e.g. bought YES @ 50¢, now bid 70¢ → +40%)
 */

const fs = require("fs");
const path = require("path");

const KALSHI_DIR = path.resolve(__dirname, "../../../data/kalshi");
const PAPER_FILE = path.join(KALSHI_DIR, "paper-positions.jsonl");

// Adaptive exits (no longer mechanical bands)
const { evaluateExit } = require("./kalshi-adaptive-exits");

// Legacy thresholds (deprecated — use evaluateExit instead)
const STOP_LOSS_PCT  = -30;
const TAKE_PROFIT_PCT = 40;

function readAll() {
  if (!fs.existsSync(PAPER_FILE)) return [];
  return fs.readFileSync(PAPER_FILE, "utf8")
    .trim().split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function append(entry) {
  fs.mkdirSync(KALSHI_DIR, { recursive: true });
  fs.appendFileSync(PAPER_FILE, JSON.stringify(entry) + "\n");
}

function getOpen() {
  const all = readAll();
  const closedIds = new Set(all.filter(e => e.event === "close").map(e => e.id));
  return all.filter(e => e.event === "open" && !closedIds.has(e.id));
}

/**
 * Full trade history: every opened paper position joined with its close (if any),
 * newest first. Used by the terminal's trade-history column.
 * → [{ id, ticker, side, entryCents, qty, status:'open'|'closed', exitTag, pnlPct, openedAt, closedAt }]
 */
function getHistory(limit = 50) {
  const all = readAll();
  const closes = new Map();
  for (const e of all) if (e.event === 'close') closes.set(e.id, e);
  const rows = [];
  for (const e of all) {
    if (e.event !== 'open') continue;
    const c = closes.get(e.id);
    rows.push({
      id: e.id,
      ticker: e.ticker || e.market_ticker || '',
      side: e.side || (e.favSide) || '',
      entryCents: e.limitCents ?? e.entryCents ?? null,
      qty: e.qty ?? e.count ?? 1,
      status: c ? 'closed' : 'open',
      exitTag: c ? (c.exitTag || null) : null,
      pnlPct: c ? (c.pnlPct ?? null) : null,
      openedAt: e.ts || null,
      closedAt: c ? (c.closedAt || null) : null,
    });
  }
  // newest first by open time (fallback: keep insertion order reversed)
  rows.sort((a, b) => String(b.openedAt || '').localeCompare(String(a.openedAt || '')));
  return rows.slice(0, limit);
}

function openPosition(o) {
  const id = o.id || `paper_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const entry = { event: "open", id, ts: new Date().toISOString(), ...o };
  append(entry);
  return entry;
}

function closePosition(id, { exitTag = "MANUAL", exitPriceCents = null, pnlPct = null } = {}) {
  append({ event: "close", id, exitTag, exitPriceCents, pnlPct, closedAt: new Date().toISOString() });
  return { ok: true, id, exitTag };
}

// Normalize price cents from Kalshi market object (API may return dollars or cents)
function toCents(market, centField, dollarField) {
  if (market[centField] != null) return market[centField];
  const d = parseFloat(market[dollarField]);
  return Number.isFinite(d) ? Math.round(d * 100) : null;
}

async function pollOpen() {
  const open = getOpen();
  if (open.length === 0) return [];

  const kalshi = require("./kalshi-api");
  const results = [];

  for (const pos of open) {
    try {
      const r = await kalshi.getMarket(pos.ticker);
      const market = r.data?.market;

      if (!market) {
        if (r.status === 404) {
          closePosition(pos.id, { exitTag: "RESOLVED" });
          results.push({ ...pos, resolved: true, pnlPct: null, status: "resolved" });
        } else {
          results.push({ ...pos, error: "market unavailable", status: "error" });
        }
        continue;
      }

      const entryCents = pos.limitCents || 50;
      const side = pos.side; // 'yes' | 'no'

      const currentAsk = toCents(market, side === "yes" ? "yes_ask" : "no_ask",
                                         side === "yes" ? "yes_ask_dollars" : "no_ask_dollars")
                         ?? entryCents;
      const currentBid = toCents(market, side === "yes" ? "yes_bid" : "no_bid",
                                         side === "yes" ? "yes_bid_dollars" : "no_bid_dollars")
                         ?? currentAsk;

      // P&L: entered at ask, exit at bid (realistic with spread)
      const pnlCents = currentBid - entryCents;
      const pnlPct   = Math.round((pnlCents / entryCents) * 100);

      const minsToClose = market.close_time
        ? Math.round((new Date(market.close_time).getTime() - Date.now()) / 60000)
        : null;

      // Past close → grade against the SETTLED RESULT, not the order book.
      // Once trading stops, a binary market's book empties (yes_bid ~ no_bid ~ 0),
      // so the old `exitPriceCents: currentBid` booked EVERY expired position — the
      // winners too — as a -100% total loss. A settled binary is worth 100¢ to the
      // winning side and 0¢ to the loser; grade on `market.result`. If the market is
      // closed but not yet settled (no result), leave it OPEN rather than fabricate a
      // loss — the next poll (or the crypto observer) grades it once it resolves.
      if (minsToClose !== null && minsToClose <= 0) {
        const result = String(market.result || "").toLowerCase(); // 'yes' | 'no' | ''
        if (result === "yes" || result === "no") {
          const won = result === side;
          const exitCents = won ? 100 : 0;
          const settledPnlPct = Math.round(((exitCents - entryCents) / entryCents) * 100);
          closePosition(pos.id, { exitTag: won ? "WON" : "LOST", exitPriceCents: exitCents, pnlPct: settledPnlPct });
          results.push({ ...pos, title: market.title || pos.ticker,
            resolved: true, won, pnlPct: settledPnlPct, exitPriceCents: exitCents, minsToClose: 0, status: "resolved" });
        } else {
          // closed, awaiting settlement — do NOT close at a fabricated -100%
          results.push({ ...pos, title: market.title || pos.ticker,
            pnlPct: null, minsToClose: 0, status: "closed-unsettled" });
        }
        continue;
      }

      // Use adaptive exit logic (convergence-driven)
      const exitEval = evaluateExit(
        { side, limitCents: entryCents },
        market,
        50  // default entry conviction if not tracked
      );

      const autoExit = exitEval.shouldExit ? exitEval.tag : null;

      results.push({
        ...pos,
        title: market.title || pos.ticker,
        entryCents, currentAsk, currentBid,
        pnlCents, pnlPct, autoExit, minsToClose,
        status: autoExit ? "exit-pending" : "open",
      });
    } catch (e) {
      results.push({ ...pos, error: e.message, status: "error" });
    }
  }
  return results;
}

module.exports = { openPosition, closePosition, getOpen, pollOpen, getHistory };
