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
const { breakevenWinProb, netEvCents } = require("./kalshi-fees");

// ── exit thresholds (DEPRECATED - replaced by adaptive exits) ──────────────────
// Kept for reference only; adaptive exits now use convergence-based logic
const STOP_LOSS_PCT = -25;
const TAKE_PROFIT_PCT = 25;
const FLATTEN_MINS = 30;     // NOW BLOCKED — no flatten-at-close, let convergence play

// ── entry filters (profitability-driven) ────────────────────────────────────
const MIN_CONVICTION = 65;   // only enter if ≥65% confidence (was 40%)
const MAX_SPREAD_CENTS = 2;  // only enter if spread ≤2¢ (was 6¢)
const MAX_ENTRY_PRICE_PCT = 5;  // only enter if entry within ±5% of fair value

// ── Σ₀ evidence gate (replaces the old flat 45% win-rate gate) ───────────────
// A "buy" card is an important claim → it needs evidence. Win rate alone is a trap
// (the live crypto ledger ran 53% wins but −46% EXPECTANCY: small wins, full losses).
// So we gate on the resolved-trade EXPECTANCY and a fee-aware break-even, not win%.
const MIN_RESOLVED_SAMPLE = 30;   // resolved closes needed before an edge is "proven"
const MIN_EXPECTANCY = 0;         // measured expectancy must clear 0 (after the fact)
const WINRATE_MARGIN = 0.02;      // proven win% must beat fee break-even by ≥2pts
// External reality beats internal consistency: by default we SUPPRESS a card whose own
// resolved ledger proves it loses money. Set KALSHI_ALLOW_NEGATIVE_EV=1 to show it anyway
// (still clearly labelled "−EV / unproven" in the reason + provenance).
const ALLOW_NEGATIVE_EV = process.env.KALSHI_ALLOW_NEGATIVE_EV === "1";

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

/**
 * Build the Σ₀ evidence record for a candidate entry: what the resolved-trade ledger
 * actually says about this market's category. This is the [claim, evidence, confidence,
 * source] the suggestion must carry instead of a bare heuristic conviction %.
 */
function entryProvenance(m, f) {
  const cat = getCategory(m.ticker);
  const stats = getCategoryStats(cat); // {trades, winRate, expectancy, ...} | null
  const n = stats ? stats.trades : 0;
  const proven = !!stats && n >= MIN_RESOLVED_SAMPLE;
  const winRate = stats ? stats.winRate : null;          // %
  const expectancy = stats ? stats.expectancy : null;    // % per trade
  const breakeven = Math.round(breakevenWinProb(f.sideAsk) * 100); // fee-aware, %
  // Grounded confidence: only a proven, +expectancy edge earns a high number. Heuristic
  // conviction is downgraded to a tie-breaker, never the source of confidence.
  let confidence;
  if (proven && expectancy > MIN_EXPECTANCY && winRate / 100 >= breakevenWinProb(f.sideAsk) + WINRATE_MARGIN) {
    confidence = Math.min(0.9, 0.5 + Math.min(0.4, expectancy / 100)); // edge-scaled
  } else if (proven) {
    confidence = 0.15; // proven but losing/thin — low, honest
  } else {
    confidence = 0.25; // unproven — no resolved evidence either way
  }
  return {
    category: cat,
    proven,
    sampleN: n,
    winRate,
    expectancy,
    breakevenPct: breakeven,
    source: "paper-ledger:data/kalshi/paper-positions.jsonl",
    confidence,
  };
}

// Check if entry passes profitability filters. `f` is the favorability() result.
function isEntryTradeable(m, f, spread) {
  const conviction = f.conviction;
  // 0. Structure gate: parlays and range bands are never tradeable here.
  const supported = isSupportedEntryMarket(m);
  if (!supported.ok) return supported;

  // 1. Conviction threshold: must be ≥65%
  if (conviction < MIN_CONVICTION) return { ok: false, reason: `conviction ${conviction}% < ${MIN_CONVICTION}%` };

  // 2. Spread constraint: must be ≤2¢
  if (spread > MAX_SPREAD_CENTS) return { ok: false, reason: `spread ${spread}¢ > ${MAX_SPREAD_CENTS}¢` };

  // 3. Σ₀ EVIDENCE GATE — the binding signal is MEASURED resolved-trade expectancy,
  // because that is what actually happened (it already prices the real exit discipline:
  // tiny wins, full losses → the crypto ledger's 53% win / −46% expectancy trap). The
  // fee-aware break-even is computed too, but only for the provenance label — measured
  // expectancy overrides a theoretical price model when the two disagree.
  const prov = entryProvenance(m, f);
  if (prov.proven && prov.expectancy <= MIN_EXPECTANCY && !ALLOW_NEGATIVE_EV) {
    // Its own resolved ledger proves it loses money after fees. Don't present the claim.
    return {
      ok: false,
      reason: `${prov.category} expectancy ${prov.expectancy}% ≤ 0 (n=${prov.sampleN} resolved, fee break-even ${prov.breakevenPct}% @ ${f.sideAsk}¢)`,
      provenance: prov,
      suppressedNegEv: true,
    };
  }

  // 4. Fair value bounds: entry price must be within ±5% of mid-price
  const yesA = m.yes_ask || 0, noA = m.no_ask || 0;
  const mid = (yesA + noA) / 2;
  const yesOffPct = mid > 0 ? Math.abs(yesA - mid) / mid * 100 : 0;
  const noOffPct = mid > 0 ? Math.abs(noA - mid) / mid * 100 : 0;
  if (yesOffPct > MAX_ENTRY_PRICE_PCT || noOffPct > MAX_ENTRY_PRICE_PCT) {
    return { ok: false, reason: `entry off fair value by >5%`, provenance: prov };
  }

  return { ok: true, provenance: prov };
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
  let suppressedNegEv = 0;
  for (const m of markets) {
    if (m.yes_ask == null && m.no_ask == null) continue;
    if (exitTickers.has(m.ticker)) continue;           // already an exit card
    const f = favorability(m, nowMs);
    const spread = Math.abs((m.yes_ask || 0) - (m.no_ask || 0));

    // Apply profitability filters + Σ₀ evidence gate
    const check = isEntryTradeable(m, f, spread);
    if (!check.ok) {
      if (check.suppressedNegEv) suppressedNegEv++;
      continue;  // skip non-tradeable entries
    }
    const prov = check.provenance;

    // Honest provenance suffix the deck renders (it shows card.reason verbatim): the
    // user sees the resolved-trade basis, never just a heuristic conviction %.
    const evNote = prov.proven
      ? `paper-edge ${prov.winRate}% exp ${prov.expectancy >= 0 ? "+" : ""}${prov.expectancy}% n=${prov.sampleN}`
      : `⚠ unproven — no resolved-trade edge (n=${prov.sampleN})`;
    const reason = `${f.reason} · ${evNote}`;

    const denom = (m.yes_ask || 0) + (m.no_ask || 0);
    const yesPct = denom > 0 ? Math.round((m.yes_ask / denom) * 100) : (m.yes_ask || 0);
    const favLabel = f.side === "yes" ? (m.yes_sub_title || "YES") : (m.no_sub_title || "NO");
    const evCents = prov.winRate != null ? netEvCents(f.sideAsk, prov.winRate / 100) : null;
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
      conviction: f.conviction,                          // heuristic now-slice score (NOT a probability)
      confidence: prov.confidence,                       // grounded [0..1] from resolved ledger
      provenance: prov,                                  // {proven, sampleN, winRate, expectancy, breakevenPct, source}
      netEvCents: evCents,                               // fee-aware EV per contract at the measured win%
      reason,
      minsToClose: Number.isFinite(f.minsToClose) ? Math.round(f.minsToClose) : null,
      close: m.close_time || "",
    });

    // Reason → Act: emit one ConvergenceRecord per tradeable entry suggestion.
    // This reasoner has a RESOLVABLE outcome — the trade settles win/lose — so the
    // record gives the convergence loop something real to grade later (Verify).
    // Confidence is the GROUNDED ledger-derived number, not the heuristic conviction.
    try {
      const { emitConvergenceRecord } = require("./convergence-records");
      await emitConvergenceRecord({
        hypothesis: `buy ${f.side.toUpperCase()} (${favLabel}) @ ${f.sideAsk}¢ — ${m.title || m.ticker} [${m.ticker}]`,
        evidence_ids: [m.ticker, prov.source],
        result: `entry ${f.side} ${favLabel} @ ${f.sideAsk}¢ · ${reason}`,
        confidence: Math.max(0, Math.min(1, prov.confidence)),
        reasoner: "kalshi-suggest",
        source: prov.proven
          ? `paper-ledger n=${prov.sampleN} winRate=${prov.winRate}% exp=${prov.expectancy}%`
          : `unproven (n=${prov.sampleN})`,
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
  const suppressNote = suppressedNegEv > 0
    ? ` ${suppressedNegEv} entr${suppressedNegEv === 1 ? "y" : "ies"} suppressed by the Σ₀ EV gate (resolved-ledger expectancy ≤ 0 after fees; set KALSHI_ALLOW_NEGATIVE_EV=1 to show).`
    : "";
  return {
    count: cards.length,
    exitCount: exits.length,
    entryCount: entries.length,
    suppressedNegEv,
    generatedAt: new Date().toISOString(),
    note: (exitsOnly
      ? "EXITS ONLY — sell positions immediately (stop-loss / take-profit / convergence-determined). No entries shown."
      : "Exits (stop-loss / take-profit / convergence) first — sell ASAP — then now-slice favorable entries.") + suppressNote,
    cards: cards.slice(0, limit),
  };
}

module.exports = { getSuggestions, isSupportedEntryMarket, isEntryTradeable, entryProvenance };
