"use strict";
/**
 * options-strategies.js — direct options-strategy PROPOSAL engine (#2589).
 *
 * Loop stage: Reason. Pure, deterministic functions over a NORMALIZED options
 * chain (the `contracts` rows returned by lib/options-data.js). No network in
 * this module — callers fetch the chain; this module only reasons over it.
 *
 * ADVISORY ONLY. This engine proposes and prices strategies from real chain
 * data; it NEVER places, simulates placing, or recommends executing orders —
 * Act stays behind lib/trading-guard.js and the ADR-0020 gates. Covered /
 * cash-secured structures ONLY: every short option here is fully backed by
 * shares (covered call, collar) or cash collateral (cash-secured put). Naked
 * short options are permanently out of scope and are refused, not approximated.
 *
 * HONESTY CONTRACT (Σ₀ External Reality Rule):
 *  - Every function returns { ok: true, ...proposal } or { ok: false, reason }.
 *    It never throws at a caller and never invents a contract, a premium, or a
 *    greek that the chain does not carry.
 *  - Premiums are quote MARKS ((bid+ask)/2), never fills. The half-spread
 *    (ask−bid)/2 is reported as an explicit cost line because real option
 *    bid-ask spreads are the dominant execution cost (arXiv:2511.02518).
 *  - Strike selection prefers the delta path (|delta| closest to target inside
 *    the DTE window). When the chain carries no greeks it FALLS BACK to
 *    moneyness ranking (~3-7% OTM) and SAYS SO via `selectionPath` — the two
 *    paths are never silently conflated.
 *  - Assignment risk is labeled a PROXY (|delta| ≈ risk-neutral P(ITM), or raw
 *    moneyness when greeks are absent) — a model artifact, not a forecast.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TARGET_DELTA = 0.30;
const DEFAULT_MIN_DTE = 21;
const DEFAULT_MAX_DTE = 60;
// Moneyness fallback band when greeks are absent: ~3-7% OTM, centered at 5%.
const MONEYNESS_BAND = { min: 0.03, max: 0.07, center: 0.05 };

const SPREAD_COST_NOTE =
  "Half-spread ((ask−bid)/2) at the quote, per share; ×100 per contract. " +
  "Real option bid-ask spreads are the dominant execution cost of retail option strategies (arXiv:2511.02518) — " +
  "marks are quotes, not fills.";

const OPT_DISCLAIMER =
  "Evidence basis: latest-session listed-option quotes from the reported chain source (connected Alpaca account, keyless Yahoo chain, or Alpha Vantage); " +
  "premiums are quote marks ((bid+ask)/2), not fills — real spreads are the dominant cost (arXiv:2511.02518); " +
  "assignment/greek figures are model proxies (delta source is labeled provider vs model(bs-from-iv)), not forecasts; taxes, dividends, and early assignment not modeled. " +
  "Decision support only, NOT personalized investment advice — this proposes and prices; it never places or executes anything. The user always decides.";

// ── small helpers ────────────────────────────────────────────────────────────

function _round(x, dp = 6) {
  if (!Number.isFinite(x)) return null;
  const f = Math.pow(10, dp);
  return Math.round(x * f) / f;
}

function _nowMs(now) {
  if (now === undefined || now === null) return Date.now();
  if (typeof now === "number") return now;
  const t = Date.parse(String(now));
  return Number.isFinite(t) ? t : Date.now();
}

function _dte(expiration, nowMs) {
  const t = Date.parse(String(expiration || ""));
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - nowMs) / DAY_MS);
}

/** Quote is live enough to price a leg: real bid, real ask, sane ordering. */
function _hasLiveQuote(row) {
  return Number.isFinite(row.bid) && Number.isFinite(row.ask) && row.bid > 0 && row.ask >= row.bid;
}

function _markOf(row) {
  return (row.bid + row.ask) / 2;
}

function _halfSpread(row) {
  return (row.ask - row.bid) / 2;
}

/**
 * Filter chain rows to one option type inside the DTE window with live quotes.
 * Returns rows annotated with `dte`.
 */
function _candidates(chain, type, minDte, maxDte, nowMs) {
  const out = [];
  for (const row of Array.isArray(chain) ? chain : []) {
    if (!row || row.type !== type || !Number.isFinite(row.strike)) continue;
    if (!_hasLiveQuote(row)) continue;
    const dte = _dte(row.expiration, nowMs);
    if (dte === null || dte < minDte || dte > maxDte) continue;
    out.push({ row, dte });
  }
  return out;
}

/**
 * Pick one candidate: delta path when any candidate carries a delta, else the
 * ~3-7% OTM moneyness band. `otmSign` is +1 for calls (strike above price) and
 * -1 for puts (strike below price). Deterministic tie-breaks: fit, then lower
 * DTE, then lower strike.
 * → { pick, dte, selectionPath } | { reason }
 */
function _selectLeg(cands, { targetDelta, price, otmSign }) {
  const withDelta = cands.filter((c) => Number.isFinite(c.row.delta));
  if (withDelta.length > 0) {
    withDelta.sort((a, b) =>
      Math.abs(Math.abs(a.row.delta) - targetDelta) - Math.abs(Math.abs(b.row.delta) - targetDelta) ||
      a.dte - b.dte || a.row.strike - b.row.strike);
    return { pick: withDelta[0].row, dte: withDelta[0].dte, selectionPath: "delta" };
  }
  // Greeks absent → moneyness fallback, and we say so.
  const inBand = cands.filter((c) => {
    const m = otmSign * (c.row.strike / price - 1); // OTM distance in the right direction
    return m >= MONEYNESS_BAND.min && m <= MONEYNESS_BAND.max;
  });
  if (inBand.length === 0) {
    return {
      reason:
        `chain carries no greeks and no ${otmSign > 0 ? "call strike above" : "put strike below"} spot in the ` +
        `~${Math.round(MONEYNESS_BAND.min * 100)}-${Math.round(MONEYNESS_BAND.max * 100)}% OTM band — no qualifying strike`,
    };
  }
  inBand.sort((a, b) =>
    Math.abs(otmSign * (a.row.strike / price - 1) - MONEYNESS_BAND.center) -
    Math.abs(otmSign * (b.row.strike / price - 1) - MONEYNESS_BAND.center) ||
    a.dte - b.dte || a.row.strike - b.row.strike);
  return { pick: inBand[0].row, dte: inBand[0].dte, selectionPath: "moneyness" };
}

/** Labeled assignment-risk PROXY: |delta| when present, raw moneyness otherwise. */
function _assignmentRiskProxy(row, price) {
  if (Number.isFinite(row.delta)) {
    const src = _deltaSourceOf(row);
    return {
      basis: "delta",
      deltaSource: src,
      value: _round(Math.abs(row.delta), 4),
      note:
        "|delta| ≈ risk-neutral probability of finishing in the money — a model PROXY, not a forecast" +
        (src === "provider" ? "" : `; this delta is ${src}, derived from the feed's own IV because the feed carries no greeks`),
    };
  }
  return {
    basis: "moneyness",
    value: _round(Math.abs(row.strike / price - 1), 4),
    note: "greeks absent — OTM distance from spot is the only available proxy; it is NOT a probability",
  };
}

function _validatePrice(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) {
    return { ok: false, reason: "underlying price is required (positive number) — resolve it from the chain or pass it explicitly" };
  }
  return { ok: true, price: p };
}

function _validateChain(chain) {
  if (!Array.isArray(chain) || chain.length === 0) {
    return { ok: false, reason: "no chain rows provided — nothing to propose from" };
  }
  return { ok: true };
}

/** Shared per-leg pricing block (marks + explicit half-spread cost). */
function _legQuote(row) {
  return {
    contract: row.contract,
    type: row.type,
    strike: row.strike,
    expiration: row.expiration,
    bid: row.bid,
    ask: row.ask,
    premium: _round(_markOf(row), 4), // MARK = (bid+ask)/2, per share
    spreadCost: _round(_halfSpread(row), 4), // per share
    spreadCostPerContract: _round(_halfSpread(row) * 100, 2),
    ...(Number.isFinite(row.delta) ? { delta: row.delta, deltaSource: _deltaSourceOf(row) } : {}),
    ...(Number.isFinite(row.implied_volatility) ? { implied_volatility: row.implied_volatility } : {}),
    ...(Number.isFinite(row.open_interest) ? { open_interest: row.open_interest } : {}),
  };
}

/**
 * Where a row's delta came from: "provider" (real feed greeks) or
 * "model(bs-from-iv)" (Black–Scholes from the provider's own IV — a labeled
 * selection proxy the data layer computes when the feed has no greeks).
 * Unlabeled deltas are treated as provider data (the pre-chain row shape).
 */
function _deltaSourceOf(row) {
  return row && typeof row.delta_source === "string" ? row.delta_source : "provider";
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * proposeCoveredCall(chain, { shares, targetDelta, minDte, maxDte, price, now })
 *
 * Sell calls fully backed by shares (1 contract per 100 shares). Refuses under
 * 100 shares — an uncovered short call is out of scope, not a degraded mode.
 * → { ok: true, ...proposal } | { ok: false, reason }
 */
function proposeCoveredCall(chain, opts = {}) {
  const {
    shares, targetDelta = DEFAULT_TARGET_DELTA,
    minDte = DEFAULT_MIN_DTE, maxDte = DEFAULT_MAX_DTE, price, now,
  } = opts;

  const vc = _validateChain(chain);
  if (!vc.ok) return vc;
  const vp = _validatePrice(price);
  if (!vp.ok) return vp;
  const px = vp.price;

  const nShares = Math.floor(Number(shares));
  if (!Number.isFinite(nShares) || nShares < 100) {
    return {
      ok: false,
      reason:
        `covered calls require at least 100 shares per contract (have ${Number.isFinite(nShares) ? nShares : 0}) — ` +
        "writing the call without the shares would be a NAKED short call, which is permanently out of scope",
    };
  }

  const nowMs = _nowMs(now);
  const cands = _candidates(chain, "call", minDte, maxDte, nowMs);
  if (cands.length === 0) {
    return { ok: false, reason: `no call contracts with a live bid inside the ${minDte}-${maxDte} DTE window — no qualifying strike` };
  }
  const sel = _selectLeg(cands, { targetDelta, price: px, otmSign: +1 });
  if (!sel.pick) return { ok: false, reason: `${sel.reason} inside the ${minDte}-${maxDte} DTE window` };

  const row = sel.pick;
  const premium = _markOf(row);
  const contractsWritable = Math.floor(nShares / 100);

  return {
    ok: true,
    strategy: "covered_call",
    selectionPath: sel.selectionPath, // "delta" | "moneyness" — which ranking picked the strike
    ...(sel.selectionPath === "delta" ? { deltaSource: _deltaSourceOf(row) } : {}),
    targetDelta,
    price: px,
    ...(sel.selectionPath === "delta"
      ? {}
      : { selectionNote: `chain carries no greeks — strike ranked by ~${Math.round(MONEYNESS_BAND.center * 100)}% OTM moneyness instead of delta` }),
    ..._legQuote(row),
    dte: sel.dte,
    premiumPerContract: _round(premium * 100, 2),
    premiumTotal: _round(premium * 100 * contractsWritable, 2),
    // Annualized yield of the premium on the underlying's price, per the DTE.
    premiumYieldAnnualized: _round((premium / px) * (365 / sel.dte), 6),
    yieldBasis: "premium / underlying price × 365/DTE",
    breakeven: _round(px - premium, 4), // effective downside breakeven on the covered position
    assignmentRiskProxy: _assignmentRiskProxy(row, px),
    spreadCostNote: SPREAD_COST_NOTE,
    contractsWritable,
    sharesCovered: contractsWritable * 100,
    disclaimer: OPT_DISCLAIMER,
  };
}

/**
 * proposeCashSecuredPut(chain, { cash, targetDelta, minDte, maxDte, price, now })
 *
 * Sell puts fully collateralized by cash (strike × 100 per contract). If the
 * cash cannot secure even one contract, refuse — partial collateral would be a
 * naked put, out of scope.
 */
function proposeCashSecuredPut(chain, opts = {}) {
  const {
    cash, targetDelta = DEFAULT_TARGET_DELTA,
    minDte = DEFAULT_MIN_DTE, maxDte = DEFAULT_MAX_DTE, price, now,
  } = opts;

  const vc = _validateChain(chain);
  if (!vc.ok) return vc;
  const vp = _validatePrice(price);
  if (!vp.ok) return vp;
  const px = vp.price;

  const cashN = Number(cash);
  if (!Number.isFinite(cashN) || cashN <= 0) {
    return { ok: false, reason: "a positive cash amount is required — cash-secured means the collateral exists up front" };
  }

  const nowMs = _nowMs(now);
  const cands = _candidates(chain, "put", minDte, maxDte, nowMs);
  if (cands.length === 0) {
    return { ok: false, reason: `no put contracts with a live bid inside the ${minDte}-${maxDte} DTE window — no qualifying strike` };
  }
  const sel = _selectLeg(cands, { targetDelta, price: px, otmSign: -1 });
  if (!sel.pick) return { ok: false, reason: `${sel.reason} inside the ${minDte}-${maxDte} DTE window` };

  const row = sel.pick;
  const premium = _markOf(row);
  const collateralPerContract = _round(row.strike * 100, 2);
  const contractsWritable = Math.floor(cashN / (row.strike * 100));
  if (contractsWritable < 1) {
    return {
      ok: false,
      reason:
        `cash $${cashN} cannot fully secure one contract at the selected $${row.strike} strike ` +
        `($${collateralPerContract} collateral per contract) — partial collateral would be a NAKED short put, which is permanently out of scope`,
    };
  }

  return {
    ok: true,
    strategy: "cash_secured_put",
    selectionPath: sel.selectionPath,
    ...(sel.selectionPath === "delta" ? { deltaSource: _deltaSourceOf(row) } : {}),
    targetDelta,
    price: px,
    ...(sel.selectionPath === "delta"
      ? {}
      : { selectionNote: `chain carries no greeks — strike ranked by ~${Math.round(MONEYNESS_BAND.center * 100)}% OTM moneyness instead of delta` }),
    ..._legQuote(row),
    dte: sel.dte,
    premiumPerContract: _round(premium * 100, 2),
    premiumTotal: _round(premium * 100 * contractsWritable, 2),
    // Yield on the capital actually at risk: the cash securing the strike.
    premiumYieldAnnualized: _round((premium / row.strike) * (365 / sel.dte), 6),
    yieldBasis: "premium / strike (collateral) × 365/DTE",
    breakeven: _round(row.strike - premium, 4), // effective purchase price if assigned
    assignmentRiskProxy: _assignmentRiskProxy(row, px),
    spreadCostNote: SPREAD_COST_NOTE,
    contractsWritable,
    collateralPerContract,
    collateralRequired: _round(row.strike * 100 * contractsWritable, 2),
    cashUncommitted: _round(cashN - row.strike * 100 * contractsWritable, 2),
    disclaimer: OPT_DISCLAIMER,
  };
}

/**
 * proposeCollar(chain, { shares, putDelta, callDelta, minDte, maxDte, price, now })
 *
 * Matched-expiry protective put + covered call around long shares. The short
 * call is covered by the shares; the put is bought. Legs are ALWAYS from the
 * same expiration; the expiration with the best combined leg fit wins.
 */
function proposeCollar(chain, opts = {}) {
  const {
    shares, putDelta = 0.25, callDelta = DEFAULT_TARGET_DELTA,
    minDte = DEFAULT_MIN_DTE, maxDte = DEFAULT_MAX_DTE, price, now,
  } = opts;

  const vc = _validateChain(chain);
  if (!vc.ok) return vc;
  const vp = _validatePrice(price);
  if (!vp.ok) return vp;
  const px = vp.price;

  const nShares = Math.floor(Number(shares));
  if (!Number.isFinite(nShares) || nShares < 100) {
    return {
      ok: false,
      reason:
        `a collar needs at least 100 shares per contract to cover its short call (have ${Number.isFinite(nShares) ? nShares : 0}) — ` +
        "an uncovered call leg would be a NAKED short call, which is permanently out of scope",
    };
  }

  const nowMs = _nowMs(now);
  const callCands = _candidates(chain, "call", minDte, maxDte, nowMs);
  const putCands = _candidates(chain, "put", minDte, maxDte, nowMs);

  // Group candidates by expiration — collar legs must share one.
  const byExp = new Map();
  for (const c of callCands) {
    const k = c.row.expiration;
    if (!byExp.has(k)) byExp.set(k, { calls: [], puts: [] });
    byExp.get(k).calls.push(c);
  }
  for (const p of putCands) {
    const k = p.row.expiration;
    if (!byExp.has(k)) byExp.set(k, { calls: [], puts: [] });
    byExp.get(k).puts.push(p);
  }

  // For each matched expiration, select both legs and score the combined fit.
  let best = null;
  const expirations = [...byExp.keys()].sort();
  for (const exp of expirations) {
    const g = byExp.get(exp);
    if (!g.calls.length || !g.puts.length) continue;
    const callSel = _selectLeg(g.calls, { targetDelta: callDelta, price: px, otmSign: +1 });
    const putSel = _selectLeg(g.puts, { targetDelta: putDelta, price: px, otmSign: -1 });
    if (!callSel.pick || !putSel.pick) continue;
    const fitOf = (sel, target) =>
      sel.selectionPath === "delta"
        ? Math.abs(Math.abs(sel.pick.delta) - target)
        : Math.abs(Math.abs(sel.pick.strike / px - 1) - MONEYNESS_BAND.center);
    const fit = fitOf(callSel, callDelta) + fitOf(putSel, putDelta);
    if (!best || fit < best.fit - 1e-12) {
      best = { exp, dte: callSel.dte, callSel, putSel, fit };
    }
  }

  if (!best) {
    return {
      ok: false,
      reason:
        `no expiration inside the ${minDte}-${maxDte} DTE window has BOTH a qualifying put and call with live bids — ` +
        "a collar needs matched-expiry legs",
    };
  }

  const callRow = best.callSel.pick;
  const putRow = best.putSel.pick;
  const callMark = _markOf(callRow);
  const putMark = _markOf(putRow);
  const netCost = putMark - callMark; // per share: >0 debit, <0 credit
  const contractsWritable = Math.floor(nShares / 100);
  const paths = new Set([best.callSel.selectionPath, best.putSel.selectionPath]);
  const selectionPath = paths.size === 1 ? [...paths][0] : "mixed";

  return {
    ok: true,
    strategy: "collar",
    selectionPath, // "delta" | "moneyness" | "mixed" (per-leg paths below)
    price: px,
    expiration: best.exp,
    dte: best.dte,
    put: { ..._legQuote(putRow), selectionPath: best.putSel.selectionPath, targetDelta: putDelta },
    call: { ..._legQuote(callRow), selectionPath: best.callSel.selectionPath, targetDelta: callDelta },
    netCost: _round(netCost, 4), // per share at marks; positive = debit, negative = credit
    netCostPerContract: _round(netCost * 100, 2),
    netDirection: netCost > 0 ? "debit" : netCost < 0 ? "credit" : "even",
    spreadCost: _round(_halfSpread(putRow) + _halfSpread(callRow), 4), // both legs, per share
    spreadCostPerContract: _round((_halfSpread(putRow) + _halfSpread(callRow)) * 100, 2),
    spreadCostNote: SPREAD_COST_NOTE,
    floor: putRow.strike,
    floorPct: _round(putRow.strike / px - 1, 4), // % of price (negative = below spot)
    ceiling: callRow.strike,
    ceilingPct: _round(callRow.strike / px - 1, 4),
    maxLossPerShare: _round(px - putRow.strike + netCost, 4),
    maxGainPerShare: _round(callRow.strike - px - netCost, 4),
    assignmentRiskProxy: _assignmentRiskProxy(callRow, px), // on the short call leg
    contractsWritable,
    sharesCovered: contractsWritable * 100,
    tradeoffNote:
      "A collar TRADES UPSIDE FOR A FLOOR: gains above the call strike are forfeited in exchange for a hard floor at the put strike — " +
      "it is protection, not free yield.",
    disclaimer: OPT_DISCLAIMER,
  };
}

/**
 * inferUnderlyingPrice(chain, { now }) — put-call-parity estimate of spot from
 * the chain itself: at the nearest expiration, find the strike where the call
 * and put marks are closest (ATM), then price ≈ strike + callMark − putMark
 * (C − P = S − K with carry ≈ 0 at short DTE).
 * → { price, method, strike, expiration } | null (never invents a price)
 */
function inferUnderlyingPrice(chain, opts = {}) {
  if (!Array.isArray(chain) || chain.length === 0) return null;
  const nowMs = _nowMs(opts.now);

  const usableMark = (row) => {
    if (Number.isFinite(row.bid) && Number.isFinite(row.ask) && row.ask > 0 && row.ask >= row.bid) return (row.bid + row.ask) / 2;
    if (Number.isFinite(row.mark) && row.mark > 0) return row.mark;
    return null;
  };

  // expiration → strike → { call, put } marks
  const table = new Map();
  for (const row of chain) {
    if (!row || !Number.isFinite(row.strike) || (row.type !== "call" && row.type !== "put")) continue;
    const m = usableMark(row);
    if (m === null) continue;
    if (!table.has(row.expiration)) table.set(row.expiration, new Map());
    const strikes = table.get(row.expiration);
    if (!strikes.has(row.strike)) strikes.set(row.strike, {});
    strikes.get(row.strike)[row.type] = m;
  }

  // Nearest non-expired expiration first (least carry error), then later ones.
  const exps = [...table.keys()]
    .map((e) => ({ e, dte: _dte(e, nowMs) }))
    .filter((x) => x.dte !== null && x.dte >= 0)
    .sort((a, b) => a.dte - b.dte);
  for (const { e } of exps) {
    let bestStrike = null;
    let bestGap = Infinity;
    let bestPair = null;
    for (const [strike, pair] of table.get(e)) {
      if (!Number.isFinite(pair.call) || !Number.isFinite(pair.put)) continue;
      const gap = Math.abs(pair.call - pair.put);
      if (gap < bestGap) { bestGap = gap; bestStrike = strike; bestPair = pair; }
    }
    if (bestStrike !== null) {
      return {
        price: _round(bestStrike + bestPair.call - bestPair.put, 4),
        method: "put-call parity at the ATM strike (C−P ≈ S−K, nearest expiration)",
        strike: bestStrike,
        expiration: e,
      };
    }
  }
  return null;
}

module.exports = {
  proposeCoveredCall,
  proposeCashSecuredPut,
  proposeCollar,
  inferUnderlyingPrice,
  OPT_DISCLAIMER,
  SPREAD_COST_NOTE,
  DEFAULT_TARGET_DELTA,
  DEFAULT_MIN_DTE,
  DEFAULT_MAX_DTE,
  MONEYNESS_BAND,
};
