"use strict";

/**
 * Kalshi fill / slippage model — the Act-stage honesty layer (P1-4, docs/TRADER-ANALYSIS-2026-07.md).
 *
 * Every P&L number the trader reports rests on an ASSUMED fill price. The paper ledger and
 * backtests silently hard-code "enter at the ask, exit at the bid" — the top-of-book taker
 * assumption. That's the honest default for a 1-lot, but it is still an assumption, and it is
 * OPTIMISTIC for size (you walk the book) and PESSIMISTIC if you actually rest a maker order.
 * Baking one assumption into the math makes the reported edge unfalsifiable.
 *
 * This module makes the assumption (a) explicit, (b) swappable, and (c) measurable:
 *   - expectedFillCents(order, book, opts) — what price a given model predicts you fill at.
 *   - reconcile({expectedCents, actualCents, ...}) — realized slippage once a real fill lands,
 *     so the dry-run assumption can be graded against live reality instead of trusted forever.
 *
 * Models (registry, so a caller/env can swap without touching call sites):
 *   topOfBook  — taker at the touch (buy=ask, sell=bid). The current, honest 1-lot default.
 *   mid        — midpoint of the spread. Optimistic; useful as a best-case bound.
 *   slippage   — top-of-book PLUS a configurable adverse move (cents), models book-walking
 *                for size / latency. Conservative; useful as a worst-case bound.
 *
 * Nothing here fabricates a fill: if the book lacks the side we need, expectedFillCents
 * returns null and the caller keeps its own fallback rather than trusting a made-up price.
 */

const fs = require("fs");
const path = require("path");

const KALSHI_DIR = path.resolve(__dirname, "../../../data/kalshi");
const RECON_FILE = path.join(KALSHI_DIR, "fill-reconciliation.jsonl");

// Default adverse slippage (cents) for the `slippage` model; override per-call.
const DEFAULT_SLIPPAGE_CENTS = Number(process.env.KALSHI_SLIPPAGE_CENTS || 1);

function _num(x) {
  if (x == null || x === "") return null;   // Number(null)===0 / Number("")===0 would lie
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pull the four touch prices for the relevant side out of a Kalshi market object, tolerating
 * both cents fields (yes_ask) and dollar fields (yes_ask_dollars).
 * side: 'yes' | 'no'. Returns { ask, bid } in cents, or nulls where unavailable.
 */
function touch(book, side) {
  if (!book) return { ask: null, bid: null };
  const centField = (base) => _num(book[base]);
  const dollarField = (base) => { const d = _num(book[base + "_dollars"]); return d == null ? null : Math.round(d * 100); };
  const pick = (base) => centField(base) ?? dollarField(base);
  const yes = side === "yes";
  return {
    ask: pick(yes ? "yes_ask" : "no_ask"),
    bid: pick(yes ? "yes_bid" : "no_bid"),
  };
}

const FILL_MODELS = {
  // Taker at the touch — buy lifts the ask, sell hits the bid.
  topOfBook(order, book) {
    const { ask, bid } = touch(book, order.side);
    if (order.action === "sell") return bid;
    return ask;
  },
  // Midpoint of the spread — an optimistic best case.
  mid(order, book) {
    const { ask, bid } = touch(book, order.side);
    if (ask == null || bid == null) return null;
    return Math.round((ask + bid) / 2);
  },
  // Top-of-book plus an adverse move — conservative for size / latency.
  slippage(order, book, { slippageCents = DEFAULT_SLIPPAGE_CENTS } = {}) {
    const base = FILL_MODELS.topOfBook(order, book);
    if (base == null) return null;
    // A buy fills WORSE = higher; a sell fills WORSE = lower.
    const adverse = order.action === "sell" ? -Math.abs(slippageCents) : Math.abs(slippageCents);
    return Math.min(99, Math.max(1, base + adverse));
  },
};

const DEFAULT_MODEL = process.env.KALSHI_FILL_MODEL && FILL_MODELS[process.env.KALSHI_FILL_MODEL]
  ? process.env.KALSHI_FILL_MODEL
  : "topOfBook";

function getFillModelName() { return DEFAULT_MODEL; }

/**
 * expectedFillCents — the price `model` predicts this order fills at, in cents.
 * order: { side:'yes'|'no', action:'buy'|'sell' }  (action defaults to 'buy')
 * Returns an integer cents price, or null if the book can't support the model (never guesses).
 */
function expectedFillCents(order, book, { model = DEFAULT_MODEL, slippageCents } = {}) {
  const fn = FILL_MODELS[model];
  if (!fn) throw new Error(`unknown fill model: ${model}`);
  const o = { side: (order && order.side) || "yes", action: (order && order.action) || "buy" };
  const px = fn(o, book, { slippageCents });
  if (px == null || !Number.isFinite(px)) return null;
  return Math.round(px);
}

/**
 * reconcile — grade a dry-run assumption against a real fill. Positive `slippageCents` means
 * the actual fill was ADVERSE relative to what the model expected (paid more on a buy, got
 * less on a sell). Best-effort appends the record so realized slippage can be tracked over
 * time; returns the record regardless.
 */
function reconcile({ ticker, side = "yes", action = "buy", expectedCents, actualCents, model = DEFAULT_MODEL, contracts = 1, ts = null, log = true } = {}) {
  const exp = _num(expectedCents), act = _num(actualCents);
  const adverseSign = action === "sell" ? -1 : 1;   // buys: higher = adverse; sells: lower = adverse
  const slippageCents = (exp == null || act == null) ? null : Number(((act - exp) * adverseSign).toFixed(2));
  const rec = {
    ts: ts || null, ticker: ticker || null, side, action, model, contracts,
    expectedCents: exp, actualCents: act, slippageCents,
  };
  if (log && slippageCents != null) {
    try { fs.mkdirSync(KALSHI_DIR, { recursive: true }); fs.appendFileSync(RECON_FILE, JSON.stringify(rec) + "\n"); }
    catch { /* best-effort — never let telemetry break a trade */ }
  }
  return rec;
}

/** Summarize recorded reconciliations: mean/median adverse slippage, n, by model. Honest n=0. */
function reconciliationStats({ file = RECON_FILE } = {}) {
  let rows = [];
  try {
    rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && Number.isFinite(r.slippageCents));
  } catch { rows = []; }
  const n = rows.length;
  if (!n) return { n: 0, meanSlippageCents: null, note: "no live fills reconciled yet" };
  const vals = rows.map((r) => r.slippageCents).sort((a, b) => a - b);
  const mean = vals.reduce((s, v) => s + v, 0) / n;
  const median = n % 2 ? vals[(n - 1) / 2] : (vals[n / 2 - 1] + vals[n / 2]) / 2;
  return {
    n,
    meanSlippageCents: Number(mean.toFixed(3)),
    medianSlippageCents: Number(median.toFixed(3)),
    worstAdverseCents: vals[vals.length - 1],
    note: `reconciled ${n} fills · mean adverse slippage ${mean.toFixed(2)}¢`,
  };
}

module.exports = {
  FILL_MODELS, expectedFillCents, reconcile, reconciliationStats,
  touch, getFillModelName, RECON_FILE, DEFAULT_SLIPPAGE_CENTS,
};
