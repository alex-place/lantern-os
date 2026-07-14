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
// Fee-aware realized P&L (P1-5): settlement = entry fee only; early sell-back = round-trip.
const { realizedNetPnlCents } = require("./kalshi-fees");

// Legacy thresholds (deprecated — use evaluateExit instead)
const STOP_LOSS_PCT  = -30;
const TAKE_PROFIT_PCT = 40;

// Paper bankroll: a virtual starting balance so the game can "buy until no cash".
// Cash is DERIVED from the append-only ledger (single source of truth): you pay the
// entry cost on open and receive the exit proceeds on close.
const PAPER_START_CENTS = Number(process.env.KALSHI_PAPER_START_CENTS || 10000); // $100
// Auto stop-loss: a paper position is auto-closed once it falls this far, so the
// bankroll is protected without waiting for a manual swipe. Take-profit is NOT
// auto-closed — the player chooses to sell for profit or hold.
const AUTO_STOP_PCT = Number(process.env.KALSHI_PAPER_STOP_PCT || -25);

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

/**
 * Virtual paper wallet, derived entirely from the append-only ledger.
 *   cash = start − cost locked in still-open positions + net realized P&L of closed ones.
 * Lets the tinder game spend down to zero and refuse buys when broke.
 */
function getWallet() {
  const all = readAll();
  const opens = new Map();
  for (const e of all) if (e.event === "open") opens.set(e.id, e);
  const closedIds = new Set();
  let realizedCents = 0, investedCents = 0;
  const costOf = (o) => {
    const qty = Number(o.qty ?? o.count ?? 1) || 1;
    const entry = Number(o.limitCents ?? o.entryCents ?? 50);
    return entry * qty;
  };
  for (const e of all) {
    if (e.event !== "close") continue;
    closedIds.add(e.id);
    const o = opens.get(e.id);
    if (!o) continue;
    const exit = Number(e.exitPriceCents ?? 0);
    const qty = Number(o.qty ?? o.count ?? 1) || 1;
    const entry = Number(o.limitCents ?? o.entryCents ?? 50);
    // P1-5 (docs/TRADER-ANALYSIS-2026-07.md): realized P&L is NET of Kalshi fees, not gross.
    // Settlement (WON/LOST held to expiry) pays only the entry taker fee; an early sell-back
    // (STOP-LOSS / take-profit / manual / adaptive exit) pays the round-trip fee. Booking gross
    // overstated the bankroll by ~1.75¢/contract per early exit — exactly the EV leak the
    // analysis flagged.
    const tag = String(e.exitTag || "").toUpperCase();
    const settled = tag === "WON" || tag === "LOST" || tag === "RESOLVED";
    const r = realizedNetPnlCents({ entryCents: entry, exitCents: exit, contracts: qty, settled });
    realizedCents += r ? r.netCents : (exit - entry) * qty;
  }
  for (const [id, o] of opens) if (!closedIds.has(id)) investedCents += costOf(o);
  const cashCents = Math.max(0, PAPER_START_CENTS + realizedCents - investedCents);
  return {
    startCents: PAPER_START_CENTS,
    cashCents,
    investedCents,
    realizedCents,
    openCount: opens.size - closedIds.size,
    equityCents: cashCents + investedCents,  // cash + cost-basis still at risk
  };
}

function openPosition(o) {
  const id = o.id || `paper_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const entry = { event: "open", id, ts: new Date().toISOString(), ...o };
  append(entry);
  return entry;
}

function closePosition(id, { exitTag = "MANUAL", exitPriceCents = null, pnlPct = null,
  settledBucket = null, settledHigh = null } = {}) {
  const rec = { event: "close", id, exitTag, exitPriceCents, pnlPct, closedAt: new Date().toISOString() };
  // Weather-edge (#2218): stamp the observed outcome so kalshi-weather-verify can grade the
  // predictive distribution stamped at open. settledBucket is the ladder index that resolved
  // YES; settledHigh is the settled °F (either resolves through the ladder in the verifier).
  if (Number.isInteger(settledBucket)) rec.settledBucket = settledBucket;
  if (settledHigh != null) rec.settledHigh = settledHigh;
  append(rec);
  return { ok: true, id, exitTag };
}

/** Weather-edge close support (#2218): find which ladder bucket actually settled YES by
 *  polling the sibling tickers stamped at open. Returns the ladder index, or null if the
 *  outcome can't be resolved yet (leaves the verifier to skip this record rather than guess). */
async function resolveSettledBucket(pos) {
  const ladder = pos && pos.ladder;
  if (!Array.isArray(ladder) || !ladder.length) return null;
  const kalshi = require("./kalshi-api");
  for (let i = 0; i < ladder.length; i++) {
    const ticker = Array.isArray(ladder[i]) ? ladder[i][0] : null;
    if (!ticker) continue;
    try {
      const r = await kalshi.getMarket(ticker);
      const result = String(r.data?.market?.result || "").toLowerCase();
      if (result === "yes") return i;
    } catch { /* ignore; treat as unresolved */ }
  }
  return null; // no sibling reported YES yet
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
          // Weather-edge (#2218): stamp which ladder bucket settled YES so the distribution
          // verifier can grade the forecast. If we held the winning bucket its index is known
          // directly; otherwise poll the siblings stamped at open. No-op for non-weather rows.
          let settledBucket = null;
          if (Array.isArray(pos.ladder) && pos.ladder.length) {
            const heldIdx = pos.ladder.findIndex((b) => Array.isArray(b) && b[0] === pos.ticker);
            settledBucket = (won && heldIdx >= 0) ? heldIdx : await resolveSettledBucket(pos);
          }
          closePosition(pos.id, { exitTag: won ? "WON" : "LOST", exitPriceCents: exitCents, pnlPct: settledPnlPct, settledBucket });
          results.push({ ...pos, title: market.title || pos.ticker,
            resolved: true, won, pnlPct: settledPnlPct, exitPriceCents: exitCents, minsToClose: 0, status: "resolved" });
        } else {
          // closed, awaiting settlement — do NOT close at a fabricated -100%
          results.push({ ...pos, title: market.title || pos.ticker,
            pnlPct: null, minsToClose: 0, status: "closed-unsettled" });
        }
        continue;
      }

      // AUTO STOP-LOSS: close the losing position now rather than only flagging it,
      // so the paper bankroll is protected without the player catching a fast drop by
      // hand. Take-profit is deliberately NOT auto-closed below — the player decides to
      // sell for profit or hold.
      if (pnlPct <= AUTO_STOP_PCT) {
        closePosition(pos.id, { exitTag: "STOP-LOSS", exitPriceCents: currentBid, pnlPct });
        results.push({ ...pos, title: market.title || pos.ticker, entryCents, currentAsk, currentBid,
          pnlCents, pnlPct, autoExit: "STOP-LOSS", minsToClose, status: "stopped-out" });
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

module.exports = { openPosition, closePosition, getOpen, pollOpen, getHistory, getWallet };
