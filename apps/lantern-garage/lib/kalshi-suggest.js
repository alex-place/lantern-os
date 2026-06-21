/**
 * Kalshi suggestion engine — NOW-SLICE favorability for the swipe deck.
 *
 * Each card carries ONE favorable position the AI picks for *this instant*:
 * buy YES or buy NO, chosen from the current data slice only —
 *   - tick      : current yes_ask vs the previous tick (live momentum)
 *   - spread    : bid/ask tightness (how cleanly you can enter)
 *   - liquidity : resting size / liquidity on the book
 *   - urgency   : time to close (shorter game times rank first)
 * No historical trajectory is used — the decision is "only relevant to now's
 * data slice", so it stays valid under a tight (~6s) refresh.
 *
 * The deck is a binary: GREEN/right takes the favorable position, RED/left
 * passes. Nothing is sent here — the take routes through the existing dry-run /
 * kill-switch-gated /order endpoint.
 */

"use strict";

const kalshi = require("./kalshi-api");
const { getWinRate, getCategory, getCategoryStats } = require("./kalshi-winrate-tracker");
const { evaluateExit, getMarketState, scoreHold } = require("./kalshi-adaptive-exits");

// ── exit thresholds (DEPRECATED - replaced by adaptive exits) ──────────────────
// Kept for reference only; adaptive exits now use convergence-based logic
const STOP_LOSS_PCT = -25;
const TAKE_PROFIT_PCT = 25;
const FLATTEN_MINS = 30;     // NOW BLOCKED — no flatten-at-close, let convergence play

// ── entry filters (profitability-driven) ────────────────────────────────────
const MIN_CONVICTION = 65;   // only enter if ≥65% confidence (was 40%)
const MAX_SPREAD_CENTS = 2;  // only enter if spread ≤2¢ (was 6¢)
const MIN_CATEGORY_WINRATE = 45;  // skip category if <45% historical win rate
const MAX_ENTRY_PRICE_PCT = 5;  // only enter if entry within ±5% of fair value

function num(v) {
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : null;
}

function prevYesCents(m) {
  const f = parseFloat(m.previous_yes_ask_dollars);
  return Number.isFinite(f) ? Math.round(f * 100) : null;
}

// Structural guard: only single-outcome binary markets are tradeable entries.
// Two market structures bled the live account (Jun 2026) and no pricing model
// here can value them, so they must never reach a tradeable entry card:
//   1. Multivariate / parlay series (KXMV*) — all legs must hit; e.g.
//      KXMVESPORTSMULTIGAMEEXTENDED (8-leg), KXMVECROSSCATEGORY.
//   2. Price-BAND range markets — resolve YES only inside a [floor, cap] band
//      (e.g. "price range … $0.085 to 0.0899999"); identified by a cap_strike
//      alongside floor_strike, or a "between" strike_type.
// Returns { ok, reason }. Keep this conservative: when in doubt, exclude.
function isSupportedEntryMarket(m) {
  const ticker = String(m.ticker || "");
  if (/^KXMV/i.test(ticker)) {
    return { ok: false, reason: "multivariate/parlay series (KXMV*)" };
  }
  const st = String(m.strike_type || "").toLowerCase();
  if (st === "between") {
    return { ok: false, reason: `range-band market (strike_type=${st})` };
  }
  const cap = num(m.cap_strike);
  const floor = num(m.floor_strike);
  if (cap != null && floor != null && cap > floor) {
    return { ok: false, reason: "range-band market (floor+cap strike)" };
  }
  // Belt-and-suspenders: parlay titles are comma-joined multi-leg strings.
  const title = String(m.title || "");
  if ((title.match(/,/g) || []).length >= 2 && /\b(yes|no)\b/i.test(title)) {
    return { ok: false, reason: "multi-leg parlay title" };
  }
  return { ok: true };
}

// Check if entry passes profitability filters
function isEntryTradeable(m, conviction, spread) {
  // 0. Structure gate: parlays and range bands are never tradeable here.
  const supported = isSupportedEntryMarket(m);
  if (!supported.ok) return supported;

  // 1. Conviction threshold: must be ≥65%
  if (conviction < MIN_CONVICTION) return { ok: false, reason: `conviction ${conviction}% < ${MIN_CONVICTION}%` };

  // 2. Spread constraint: must be ≤2¢
  if (spread > MAX_SPREAD_CENTS) return { ok: false, reason: `spread ${spread}¢ > ${MAX_SPREAD_CENTS}¢` };

  // 3. Category win rate: category must have >45% historical win rate
  const cat = getCategory(m.ticker);
  const winRate = getWinRate(m.ticker);
  if (winRate < MIN_CATEGORY_WINRATE) return { ok: false, reason: `${cat} win rate ${winRate}% < ${MIN_CATEGORY_WINRATE}%` };

  // 4. Fair value bounds: entry price must be within ±5% of mid-price
  const yesA = m.yes_ask || 0, noA = m.no_ask || 0;
  const mid = (yesA + noA) / 2;
  const yesOffPct = mid > 0 ? Math.abs(yesA - mid) / mid * 100 : 0;
  const noOffPct = mid > 0 ? Math.abs(noA - mid) / mid * 100 : 0;
  if (yesOffPct > MAX_ENTRY_PRICE_PCT || noOffPct > MAX_ENTRY_PRICE_PCT) {
    return { ok: false, reason: `entry off fair value by >5%` };
  }

  return { ok: true };
}

function favorability(m, nowMs) {
  const yesA = m.yes_ask, yesB = m.yes_bid, noA = m.no_ask, noB = m.no_bid;
  const prevYes = prevYesCents(m);
  const tick = (yesA != null && prevYes != null) ? yesA - prevYes : 0;
  const spreadYes = (yesA != null && yesB != null) ? yesA - yesB : 99;
  const spreadNo = (noA != null && noB != null) ? noA - noB : 99;

  // favorable side from the now-slice: follow the live tick; tie → tighter book
  let side;
  if (tick > 0) side = "yes";
  else if (tick < 0) side = "no";
  else side = spreadYes <= spreadNo ? "yes" : "no";
  const sideAsk = side === "yes" ? yesA : noA;
  const spread = side === "yes" ? spreadYes : spreadNo;

  const close = m.close_time ? Date.parse(m.close_time) : NaN;
  const minsToClose = Number.isFinite(close) ? Math.max(0, (close - nowMs) / 60000) : Infinity;

  // conviction (all current-slice): momentum + book tightness + liquidity + urgency
  const mom = Math.min(20, Math.abs(tick) * 6);
  const tight = spread <= 1 ? 16 : spread <= 2 ? 9 : spread <= 4 ? 3 : 0;
  const liq = Math.min(14, Math.log10((parseFloat(m.liquidity_dollars) || 0) + 1) * 5);
  const urgency = minsToClose < 60 ? 12 : minsToClose < 240 ? 7 : minsToClose < 1440 ? 3 : 0;
  const conviction = Math.round(Math.min(82, 28 + mom + tight + liq + urgency));

  const dir = tick > 0 ? `YES ticked +${tick}¢`
            : tick < 0 ? `YES ticked ${tick}¢`
            : "flat tick";
  const tt = minsToClose === Infinity ? ""
           : minsToClose < 60 ? `closes ${Math.round(minsToClose)}m`
           : minsToClose < 1440 ? `closes ${Math.round(minsToClose / 60)}h`
           : `closes ${Math.round(minsToClose / 1440)}d`;
  const reason = [dir, `${spread}¢ spread`, tt].filter(Boolean).join(" · ");

  return { side, sideAsk, spread, tick, conviction, reason, minsToClose };
}

// average entry price per contract, in cents (best-effort across schema variants)
function costBasisCents(p, qty) {
  const expD = num(p.market_exposure_dollars);
  if (expD != null && qty > 0) return Math.round((Math.abs(expD) / qty) * 100);
  const exp = num(p.market_exposure);                 // total cost, cents
  if (exp != null && qty > 0) return Math.round(Math.abs(exp) / qty);
  const avg = num(p.average_price_dollars) ?? num(p.avg_price_dollars);
  if (avg != null) return Math.round(avg * 100);
  return null;
}

/**
 * Exit cards — held positions that should be SOLD now. These are the highest-
 * priority items and go on top: stop-losses first, then take-profits at the
 * acceptable band, then pre-close flattening. Each is a SELL of the held side.
 */
async function buildExits(mkByTicker, nowMs) {
  const posRes = await kalshi.getPositions({});
  const positions = (posRes.data && posRes.data.market_positions) || [];
  const exits = [];

  for (const p of positions) {
    const count = num(p.position) || 0;
    if (!count) continue;

    const ticker = p.ticker || p.market_ticker;
    const m = mkByTicker[ticker];
    const heldSide = count > 0 ? "yes" : "no";
    const qty = Math.abs(count);
    const cost = costBasisCents(p, qty);

    // Use adaptive exit logic (convergence-driven, not mechanical)
    const exitEval = evaluateExit(
      { side: heldSide, limitCents: cost || 50 },
      m,
      p.conviction || 50  // entry conviction if tracked
    );

    if (!exitEval.shouldExit) continue;  // position holding — no exit signal

    const sellBid = exitEval.exitPrice || (m ? (heldSide === "yes" ? m.yes_bid : m.no_bid) : null);
    const pnlPct = exitEval.pnlPct;

    const heldLabel = heldSide === "yes"
      ? (m && m.yes_sub_title) || "YES" : (m && m.no_sub_title) || "NO";

    // Urgency mapping: CONVERGENCE-DETERMINED is highest priority (let winners run)
    const urgencyMap = {
      "CONVERGENCE-DETERMINED": 95,
      "TAKE-PROFIT": 90,
      "STOP-LOSS": 100,
      "CONFIDENCE-COLLAPSE": 85,
    };
    const urgency = urgencyMap[exitEval.tag] || 80;

    exits.push({
      kind: "exit", action: "sell",
      ticker, title: (m && m.title) || ticker,
      yesLabel: (m && m.yes_sub_title) || "YES",
      noLabel: (m && m.no_sub_title) || "NO",
      yesPct: m && m.yes_ask != null && m.no_ask != null && m.yes_ask + m.no_ask > 0
        ? Math.round((m.yes_ask / (m.yes_ask + m.no_ask)) * 100) : null,
      favSide: heldSide, favLabel: heldLabel, favAsk: sellBid, qty,
      conviction: urgency, exitTag: exitEval.tag, pnlPct: pnlPct != null ? +pnlPct.toFixed(1) : null,
      reason: exitEval.reason,
      minsToClose: m && m.close_time ? Math.round((new Date(m.close_time).getTime() - nowMs) / 60000) : null,
      close: (m && m.close_time) || "",
    });
  }

  // Sort by urgency: STOP-LOSS first (protect capital), then TAKE-PROFIT (lock gains), then CONVERGENCE
  exits.sort((a, b) => {
    const priority = { "STOP-LOSS": 3, "CONFIDENCE-COLLAPSE": 2, "TAKE-PROFIT": 1, "CONVERGENCE-DETERMINED": 0 };
    const pa = priority[a.exitTag] ?? 0;
    const pb = priority[b.exitTag] ?? 0;
    if (pa !== pb) return pb - pa;
    return b.conviction - a.conviction;
  });

  return exits;
}

async function getSuggestions({ limit = 60, series_ticker = "KXMLBGAME", collector = null, exitsOnly = false } = {}) {
  let markets = [];

  // Prefer tight-band snapshot from collector (6s fresh, no API call)
  if (collector) {
    const latest = collector.getLatestMarkets();
    if (latest && latest.length > 0) {
      markets = latest;
    }
  }

  // Fall back to fresh API call if no cached snapshot
  if (markets.length === 0) {
    const mk = await kalshi.getMarkets({ series_ticker, status: "open", limit: 200 });
    markets = (mk.data && mk.data.markets) || [];
  }

  const nowMs = Date.now();
  const mkByTicker = {};
  for (const m of markets) mkByTicker[m.ticker] = m;

  // exits first — held positions to sell ASAP (best-effort; empty if no positions)
  let exits = [];
  try { exits = await buildExits(mkByTicker, nowMs); } catch { exits = []; }
  const exitTickers = new Set(exits.map((e) => e.ticker));

  const entries = [];
  for (const m of markets) {
    if (m.yes_ask == null && m.no_ask == null) continue;
    if (exitTickers.has(m.ticker)) continue;           // already an exit card
    const f = favorability(m, nowMs);
    const spread = Math.abs((m.yes_ask || 0) - (m.no_ask || 0));

    // Apply profitability filters — Phase 1 optimization
    const check = isEntryTradeable(m, f.conviction, spread);
    if (!check.ok) continue;  // skip non-tradeable entries

    const denom = (m.yes_ask || 0) + (m.no_ask || 0);
    const yesPct = denom > 0 ? Math.round((m.yes_ask / denom) * 100) : (m.yes_ask || 0);
    const favLabel = f.side === "yes" ? (m.yes_sub_title || "YES") : (m.no_sub_title || "NO");
    entries.push({
      kind: "entry", action: "buy",
      ticker: m.ticker,
      title: m.title || m.ticker,
      yesLabel: m.yes_sub_title || "YES",
      noLabel: m.no_sub_title || "NO",
      yesCents: m.yes_ask, noCents: m.no_ask, yesPct,
      favSide: f.side,                                   // 'yes' | 'no'
      favLabel,
      favAsk: f.sideAsk,
      conviction: f.conviction,
      reason: f.reason,
      minsToClose: Number.isFinite(f.minsToClose) ? Math.round(f.minsToClose) : null,
      close: m.close_time || "",
    });

    // Reason → Act: emit one ConvergenceRecord per tradeable entry suggestion.
    // This reasoner has a RESOLVABLE outcome — the trade settles win/lose — so the
    // record gives the convergence loop something real to grade later (Verify).
    // Mirrors routes/dream.js: guarded so a failed record never breaks a suggestion.
    try {
      const { emitConvergenceRecord } = require("./convergence-records");
      await emitConvergenceRecord({
        hypothesis: `buy ${f.side.toUpperCase()} (${favLabel}) @ ${f.sideAsk}¢ — ${m.title || m.ticker} [${m.ticker}]`,
        evidence_ids: [m.ticker],
        result: `entry ${f.side} ${favLabel} @ ${f.sideAsk}¢ · ${f.reason}`,
        confidence: Math.max(0, Math.min(1, f.conviction / 100)), // conviction is 0..100
        reasoner: "kalshi-suggest",
        source: `kalshi-market/${m.ticker}`,
      });
    } catch { /* convergence record non-critical */ }
  }

  // entries: time-sensitive — soonest-closing first, then conviction
  entries.sort((a, b) => {
    const ma = a.minsToClose == null ? 1e9 : a.minsToClose;
    const mb = b.minsToClose == null ? 1e9 : b.minsToClose;
    if (ma !== mb) return ma - mb;
    return b.conviction - a.conviction;
  });

  // EXITS ON TOP (sell ASAP), then entries (unless exitsOnly is true)
  const cards = exitsOnly ? exits : [...exits, ...entries];
  return {
    count: cards.length,
    exitCount: exits.length,
    entryCount: entries.length,
    generatedAt: new Date().toISOString(),
    note: exitsOnly
      ? "EXITS ONLY — sell positions immediately (stop-loss / take-profit / convergence-determined). No entries shown."
      : "Exits (stop-loss / take-profit / convergence) first — sell ASAP — then now-slice favorable entries.",
    cards: cards.slice(0, limit),
  };
}

module.exports = { getSuggestions, isSupportedEntryMarket };
