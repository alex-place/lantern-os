'use strict';

/**
 * options-shadow.js — the ASYMMETRIC OPTIONS trader, in SHADOW mode (loop stage: Verify).
 *
 * The strategy (operator-specified): on Mon–Thu nights where the underlying is
 * trend-aligned AND overnight volatility is measurable (not flat), "buy" a slightly
 * out-of-the-money next-day CALL at the close and "sell" it at the next open —
 * accepting a LOW win rate (~30–40% is the expected band: most nights the premium
 * burns) in exchange for convex payoffs on the nights the gap runs.
 *
 * WHY SHADOW: a win rate cannot be fixed by design — it is an OUTCOME. Our synthetic-
 * pricing model said OTM-on-this-edge bleeds theta; the operator's thesis says the
 * asymmetry pays anyway. Per the External Reality Rule the tie-break is MEASUREMENT:
 * this module places NO orders. It selects a real contract from the real Alpaca options
 * chain (free indicative feed), records real entry/exit quotes to an append-only
 * ledger, and reports measured win rate / expectancy. It is eligible for real (paper)
 * execution only after the measured expectancy is positive over ≥ MIN_N nights — the
 * "find the edge BEFORE placing time-sensitive trades" gate, enforced in code.
 *
 * Gates per night (all must hold, mirrors the measured overnight study):
 *   - Mon–Thu (avoid weekend holds)
 *   - trend-aligned: close > SMA-50 AND MACD line > 0 (daily bars)
 *   - vol measurable: 10d realized vol > its trailing 60d median (per-symbol; SPY's
 *     measured best regime — QQQ-style calm-night symbols can flip this via config)
 *
 * Config (env): OPTIONS_SHADOW (!=0 on), OPTIONS_SHADOW_SYMBOL (SPY),
 *   OPTIONS_SHADOW_OTM_PCT (0.25 = strike ≈ close×1.0025), OPTIONS_SHADOW_RISK_PCT
 *   (0.5 — % of equity notionally at risk per night, for stats scaling only).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..', '..', '..', 'data', 'lantern-garage', 'trading');
const LEDGER = path.join(ROOT, 'options-shadow.jsonl');
const STATE = path.join(ROOT, 'options-shadow-state.json');
const MIN_N = 30;                  // measured nights before any verdict is trusted

function cfg() {
  const n = (name, d) => { const v = parseFloat(process.env[name]); return Number.isFinite(v) ? v : d; };
  return {
    enabled: process.env.OPTIONS_SHADOW !== '0',
    symbol: (process.env.OPTIONS_SHADOW_SYMBOL || 'SPY').toUpperCase(),
    // STRIKE LADDER (% OTM): the shadow records EVERY depth each eligible night, so the
    // moneyness curve — near-OTM through DEEP OTM lottery strikes — is measured with
    // real premiums simultaneously. A 10y gap study put near-OTM EV negative but deep
    // OTM (1.5–2%) ambiguously positive on a 4–8-event tail; only real nightly quotes
    // can settle it. Env: OPTIONS_SHADOW_LADDER="0.25,0.5,1,1.5,2".
    ladder: String(process.env.OPTIONS_SHADOW_LADDER || '0.25,0.5,1,1.5,2')
      .split(',').map((x) => parseFloat(x)).filter((x) => Number.isFinite(x) && x >= 0).slice(0, 8),
    riskPct: n('OPTIONS_SHADOW_RISK_PCT', 0.5),     // % of equity at risk (premium) — stats only
    volMode: process.env.OPTIONS_SHADOW_VOL_MODE || 'notflat',  // notflat | flat | any (per-symbol regime)
    // ── PENNY mode (operator strategy): find the FIRST strike whose ask ≤ 1¢, take it
    //    ONLY when that strike is within reach of tonight's measured vol (selectivity:
    //    distance ≤ pennyMaxSigma × rv10 — the penny-strike distance is the market's
    //    implied-vol gauge; we buy when OUR vol read says the gap is achievable), and
    //    SELL next day the moment the bid is > 1¢ (target bid ≥ 2¢ = +100% gross),
    //    else record the expiry loss. Entries priced at the ASK, exits at the BID —
    //    the honest side of a 1¢ market.
    // PAPER BRIDGE (operator go, 2026-07-25): OPTIONS_PAPER=1 → the same tickets the
    // shadow measures are ALSO placed as real Alpaca PAPER option orders (account
    // options_trading_level 3, verified), so the ledger gains broker-verified fills
    // next to its quote-based estimates. Hard-gated to the paper host — a live-mode
    // auth refuses. Default OFF; qty is contracts per leg (premium ≈ $1-40/leg).
    paper: process.env.OPTIONS_PAPER === '1',
    paperQty: Math.max(1, Math.min(10, n('OPTIONS_PAPER_QTY', 1))),
    pennyEnabled: process.env.OPTIONS_SHADOW_PENNY !== '0',
    pennyAskMax: n('OPTIONS_SHADOW_PENNY_ASK_MAX', 0.01),   // "1 penny" entry ceiling
    pennyExitBid: n('OPTIONS_SHADOW_PENNY_EXIT_BID', 0.02), // sell when bid ≥ this (> 1¢)
    pennyMaxSigma: n('OPTIONS_SHADOW_PENNY_MAX_SIGMA', 3),  // strike must be ≤ N nightly sigmas away
  };
}

/** Next US trading day (ET calendar, skip Sat/Sun — holidays fall to the chain lookup).
 *  Fixes the UTC-roll bug where a late-evening ET run computed "tomorrow" in UTC and
 *  skipped Friday's expiry entirely (pricing weekend time value into the ladder). */
function nextTradingDayET(fromEt) {
  const d = new Date(fromEt.getTime());
  do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── pure gate math (exported for tests) ──────────────────────────────────────
function smaAt(a, nP, end) { if (end < nP - 1) return null; let s = 0; for (let i = end - nP + 1; i <= end; i++) s += a[i]; return s / nP; }
function emaAll(a, nP) { if (a.length < nP) return null; const k = 2 / (nP + 1); let e = a[0]; for (let i = 1; i < a.length; i++) e = a[i] * k + e * (1 - k); return e; }
function macdLine(closes) { if (closes.length < 35) return 0; const t = closes.slice(-35); return emaAll(t, 12) - emaAll(t, 26); }
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

/** All-gates check on a daily closes series ending "today at the close". */
// SINGLE SOURCE OF TRUTH (operator 2026-07-27): this gate was a byte-for-byte
// duplicate of overnight-trader's uptrendGate — same close>SMA50 & MACD>0, same
// rv10-vs-trailing-60d-median, same nightly window. The overnight book now OWNS the
// signal (options is its 4th execution tier); this wrapper delegates the pass/fail
// decision there and only adds the vol context the penny selector needs (rv10),
// so the two can never drift apart again.
function gates(closes, { volMode = 'notflat' } = {}) {
  const i = closes.length - 1;
  if (i < 70) return { eligible: false, why: 'insufficient history' };
  let delegated = null;
  try { delegated = require('./overnight-trader').uptrendGate(closes, volMode); } catch (_e) { delegated = null; }
  const px = closes[i];
  const s50 = smaAt(closes, 50, i);
  const trendOk = (s50 == null || px > s50) && macdLine(closes) > 0;
  if (delegated && delegated.pass === false) {
    return { eligible: false, why: delegated.why, trendOk, delegated: true };
  }
  if (!trendOk) return { eligible: false, why: 'not trend-aligned (need close>SMA50 & MACD>0)', trendOk };
  // 10d realized vol vs trailing 60d median of the same measure (causal)
  const dret = []; for (let k = 1; k <= i; k++) if (closes[k - 1] > 0) dret.push(closes[k] / closes[k - 1] - 1);
  const rvAt = (endIdx) => { if (endIdx < 10) return null; const w = dret.slice(endIdx - 10, endIdx); const m = w.reduce((s, x) => s + x, 0) / w.length; return Math.sqrt(w.reduce((s, x) => s + (x - m) * (x - m), 0) / w.length); };
  const v = rvAt(dret.length);
  const hist = []; for (let e = Math.max(10, dret.length - 60); e < dret.length; e++) hist.push(rvAt(e));
  const vm = median(hist.filter((x) => x != null));
  const notFlat = v != null && vm != null && v > vm;
  const volOk = volMode === 'any' ? true : volMode === 'flat' ? !notFlat : notFlat;
  if (!volOk) return { eligible: false, why: `vol regime wrong (want ${volMode}; rv10=${v && v.toExponential(2)}, med=${vm && vm.toExponential(2)})`, trendOk, notFlat, rv10: v, volMed: vm };
  return { eligible: true, trendOk, notFlat, rv10: v, volMed: vm };
}

/** Parse an OCC option symbol (e.g. SPY260727C00741000) → {root, expiry:'YYYY-MM-DD', type, strike}. */
function parseOcc(sym) {
  const m = String(sym || '').match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  return { root: m[1], expiry: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5], strike: parseInt(m[6], 10) / 1000 };
}

/**
 * Pure penny selection (exported for tests): from [{strike, ask, bid}] CALLS above spot
 * (any order), pick the FIRST (nearest) strike with 0 < ask ≤ askMax, then apply the
 * vol-selectivity: its distance must be ≤ maxSigma × rv10 (rv10 = daily-return std,
 * fraction). Returns { pick|null, reason }.
 */
function pickPenny(list, spot, { askMax = 0.01, rv10 = null, maxSigma = 3 } = {}) {
  const above = (list || []).filter((x) => x && x.strike > spot && Number(x.ask) > 0).sort((a, b) => a.strike - b.strike);
  if (!above.length) return { pick: null, reason: 'no priced calls above spot' };
  const first = above.find((x) => Number(x.ask) <= askMax);
  if (!first) return { pick: null, reason: `no strike at ≤ $${askMax.toFixed(2)} (cheapest ask ${Math.min(...above.map((x) => Number(x.ask))).toFixed(2)})` };
  const distFrac = first.strike / spot - 1;
  const sigma = rv10 > 0 ? distFrac / rv10 : null;
  if (sigma != null && sigma > maxSigma) {
    return { pick: null, reason: `penny strike too far for tonight's vol (${(distFrac * 100).toFixed(2)}% = ${sigma.toFixed(1)}σ > ${maxSigma}σ)`, sigma, distPct: distFrac * 100 };
  }
  return { pick: { ...first, distPct: +(distFrac * 100).toFixed(2), sigma: sigma != null ? +sigma.toFixed(2) : null }, reason: 'ok' };
}

/** Pick the first strike ABOVE spot×(1+otmPct/100) from a strike list (calls, slightly OTM). */
function pickStrike(spot, strikes, otmPct) {
  const floor = spot * (1 + Math.max(0, otmPct) / 100);
  const s = [...new Set(strikes.map(Number).filter((x) => x > 0))].sort((a, b) => a - b);
  for (const k of s) if (k >= floor) return k;
  return null;
}

/** Measured stats + the Σ₀ verdict for ONE set of closed rows. Win rate is an OUTPUT. */
function _stats(closed) {
  const n = closed.length;
  if (!n) return { n: 0, verdict: 'no data yet — shadow collecting' };
  const wins = closed.filter((r) => r.pl_pct > 0).length;
  const avg = closed.reduce((s, r) => s + r.pl_pct, 0) / n;
  const out = {
    n,
    win_rate_pct: +(wins / n * 100).toFixed(1),
    avg_pl_pct_of_premium: +avg.toFixed(1),
    total_pl_pct_of_premium: +(closed.reduce((s, r) => s + r.pl_pct, 0)).toFixed(0),
  };
  out.verdict = n < MIN_N
    ? `insufficient_data (${n}/${MIN_N} nights) — keep collecting, no arming`
    : avg <= 0
      ? 'negative_edge — measured expectancy ≤ 0; do NOT arm (theta wins, as modeled)'
      : 'positive_edge_candidate — measured expectancy > 0; still needs OOS + operator approval before ANY execution';
  return out;
}

/** Ladder-aware summary: overall + PER DEPTH, so the deep-OTM thesis is judged at each
 *  moneyness separately (deep strikes will show ~1–5% win rates with rare huge wins —
 *  only the measured expectancy decides, never the win rate). */
function summarize(rows) {
  const closed = rows.filter((r) => r.phase === 'close' && typeof r.pl_pct === 'number');
  const out = { overall: _stats(closed), by_depth: {} };
  const depths = [...new Set(closed.map((r) => (r.depth == null ? 'legacy' : r.depth)))];
  for (const d of depths) out.by_depth[d] = _stats(closed.filter((r) => (r.depth == null ? 'legacy' : r.depth) === d));
  // back-compat top-level fields (existing tests/telemetry read these)
  return { ...out.overall, ...out };
}

// ── Alpaca options data (free indicative feed) ───────────────────────────────
function _auth() {
  try { return require('./alpaca-adapter')._authFor('local-owner'); } catch (_e) { return null; }
}
function _get(host, p, headers) {
  return new Promise((resolve) => {
    const req = https.request({ host, path: p, method: 'GET', headers }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_e) { /* */ } resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: j }); });
    });
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.setTimeout(9000, () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
    req.end();
  });
}

/** Next-trading-day (or nearest later) call contracts for the symbol, ET-correct. */
async function listNextExpiryCalls(sym) {
  const auth = _auth();
  if (!auth) return { error: 'no alpaca auth' };
  const nextDay = nextTradingDayET(_etNow());
  const host = auth.env === 'live' ? 'api.alpaca.markets' : 'paper-api.alpaca.markets';
  const r = await _get(host, `/v2/options/contracts?underlying_symbols=${sym}&type=call&status=active&expiration_date_gte=${nextDay}&limit=300`, auth.headers);
  if (!r.ok || !r.json) return { error: `contracts ${r.status}` };
  const list = r.json.option_contracts || r.json.contracts || [];
  if (!list.length) return { error: 'no contracts' };
  const firstExp = list.map((c) => c.expiration_date).sort()[0];
  return { expiry: firstExp, contracts: list.filter((c) => c.expiration_date === firstExp) };
}

/** One-call chain snapshot: quotes for EVERY call of the underlying at one expiry
 *  (indicative feed). Returns [{symbol, strike, bid, ask}] or {error}. */
async function chainQuotes(sym, expiry) {
  const auth = _auth();
  if (!auth) return { error: 'no alpaca auth' };
  const out = [];
  let pageToken = null;
  for (let page = 0; page < 4; page++) {   // ≤4 pages ≈ plenty for one expiry's calls
    const q = `feed=indicative&type=call&limit=250&expiration_date=${expiry}` + (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '');
    const r = await _get('data.alpaca.markets', `/v1beta1/options/snapshots/${sym}?${q}`, auth.headers);
    if (!r.ok || !r.json || !r.json.snapshots) return out.length ? out : { error: `snapshots ${r.status}` };
    for (const [occ, snap] of Object.entries(r.json.snapshots)) {
      const meta = parseOcc(occ);
      if (!meta || meta.type !== 'C' || meta.expiry !== expiry) continue;
      const lq = snap && snap.latestQuote;
      if (!lq) continue;
      out.push({ symbol: occ, strike: meta.strike, bid: Number(lq.bp) || 0, ask: Number(lq.ap) || 0 });
    }
    pageToken = r.json.next_page_token;
    if (!pageToken) break;
  }
  return out;
}

/** Indicative quote (mid) for one option contract symbol from the DATA API. */
async function quoteOption(occSymbol) {
  const auth = _auth();
  if (!auth) return null;
  const r = await _get('data.alpaca.markets', `/v1beta1/options/quotes/latest?symbols=${encodeURIComponent(occSymbol)}&feed=indicative`, auth.headers);
  const q = r.ok && r.json && r.json.quotes && r.json.quotes[occSymbol];
  if (!q) return null;
  const bid = Number(q.bp) || 0, ask = Number(q.ap) || 0;
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (ask || bid || null);
  return mid ? { bid, ask, mid } : null;
}

// ── paper bridge (Alpaca PAPER options orders — never the live host) ─────────
function _post(host, p, body, headers) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = https.request({ host, path: p, method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_e) { /* */ } resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: j }); });
    });
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.setTimeout(9000, () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
    req.write(data); req.end();
  });
}
/** Place ONE paper option order (marketable limit). Returns {order_id}|{error}.
 *  Refuses anything but the paper trading host — this bridge never touches live. */
async function placePaperOrder({ contract, side, qty, limit, tif }) {
  const auth = _auth();
  if (!auth) return { error: 'no alpaca auth' };
  if (auth.env === 'live') return { error: 'refused: live auth — the options bridge is paper-only' };
  // tif: 'day' (default) for immediate entries/exits; 'gtc' for a RESTING
  // protective exit that must outlive the process (verified accepted by the
  // Alpaca options API on a far-dated contract, 2026-07-30).
  const timeInForce = String(tif || 'day').toLowerCase() === 'gtc' ? 'gtc' : 'day';
  const body = { symbol: contract, qty: String(qty), side, type: 'limit', time_in_force: timeInForce, limit_price: String(limit) };
  const r = await _post('paper-api.alpaca.markets', '/v2/orders', body, auth.headers);
  if (!r.ok) return { error: `order ${r.status}: ${(r.json && (r.json.message || r.json.error)) || ''}`.trim() };
  return { order_id: r.json && r.json.id, status: r.json && r.json.status };
}
/** Cancel one resting paper order. Returns { ok } | { error }. Used to retire a
 *  protective exit BEFORE the primary exit sells — a resting sell that survives
 *  its position would go naked short on the next fill. */
async function cancelPaperOrder(orderId) {
  const auth = _auth();
  if (!auth) return { error: 'no alpaca auth' };
  if (auth.env === 'live') return { error: 'refused: live auth — paper-only' };
  if (!orderId) return { error: 'no order id' };
  const r = await _del('paper-api.alpaca.markets', '/v2/orders/' + encodeURIComponent(orderId), auth.headers);
  // 404 = already gone (filled/expired/canceled) — that is a successful outcome
  // for our purposes: nothing is resting any more.
  if (r.status === 404) return { ok: true, alreadyGone: true };
  if (!r.ok && r.status !== 204) return { error: `cancel ${r.status}` };
  return { ok: true };
}
function _del(host, p, headers) {
  return new Promise((resolve) => {
    const req = https.request({ host, path: p, method: 'DELETE', headers }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
    });
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.setTimeout(9000, () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    req.end();
  });
}
/** Best-effort fill lookup for a paper order id → {filled_avg_price, status}|null. */
async function paperOrderFill(orderId) {
  const auth = _auth();
  if (!auth || auth.env === 'live' || !orderId) return null;
  const r = await _get('paper-api.alpaca.markets', `/v2/orders/${encodeURIComponent(orderId)}`, auth.headers);
  if (!r.ok || !r.json) return null;
  return { status: r.json.status, filled_avg_price: r.json.filled_avg_price != null ? Number(r.json.filled_avg_price) : null };
}

// ── shadow orchestration ─────────────────────────────────────────────────────
function _readState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_e) { return {}; } }
function _writeState(s) { try { fs.mkdirSync(ROOT, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s)); } catch (_e) { /* */ } }
function _append(rec) { try { fs.mkdirSync(ROOT, { recursive: true }); fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n'); } catch (_e) { /* */ } }
function _readLedger() {
  try { return fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean); }
  catch (_e) { return []; }
}
function _etNow() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })); }

/** The would-trade selection for RIGHT NOW (also the live probe): gates + the full
 *  strike LADDER with a real contract + quote per depth. */
async function probe() {
  const c = cfg();
  const yahoo = require('./market-data-yahoo');
  let closes = [];
  try { const r = await yahoo.getBars(c.symbol, '1d'); closes = ((r && r.bars) || []).map((b) => b.close).filter((x) => x > 0); } catch (_e) { /* */ }
  const g = closes.length ? gates(closes, { volMode: c.volMode }) : { eligible: false, why: 'no daily bars' };
  const spot = closes[closes.length - 1] || 0;
  const out = { symbol: c.symbol, spot, gates: g, ladder: c.ladder };
  const chain = await listNextExpiryCalls(c.symbol);
  if (chain.error) return { ...out, data: 'unavailable', reason: chain.error };
  const strikes = chain.contracts.map((x) => x.strike_price);
  const legs = [];
  for (const depth of c.ladder) {
    const strike = pickStrike(spot, strikes, depth);
    const contract = strike != null ? chain.contracts.find((x) => Number(x.strike_price) === strike) : null;
    if (!contract) { legs.push({ depth, reason: 'no strike' }); continue; }
    const q = await quoteOption(contract.symbol);
    legs.push({ depth, strike, contract: contract.symbol, quote: q });
  }
  // PENNY selection (operator strategy): first ask ≤ 1¢ strike, vol-selective.
  let penny = null;
  if (c.pennyEnabled) {
    const cq = await chainQuotes(c.symbol, chain.expiry);
    penny = Array.isArray(cq)
      ? pickPenny(cq, spot, { askMax: c.pennyAskMax, rv10: (g && g.rv10) || null, maxSigma: c.pennyMaxSigma })
      : { pick: null, reason: cq.error };
  }
  return { ...out, data: 'ok', expiry: chain.expiry, legs, penny };
}

/** Sell a leg's paper position (marketable limit at the bid, floor 1¢) and log the
 *  entry order's actual fill next to it. No-op unless the bridge is on AND this leg
 *  carries an order_id from its own paper entry. */
async function _paperClose(c, l, bid, rule) {
  if (!c.paper || !l.order_id) return;
  try {
    const entryFill = await paperOrderFill(l.order_id);
    // An unfilled entry (limit never touched) has nothing to sell — record that.
    if (entryFill && entryFill.status !== 'filled') {
      _append({ phase: 'paper_close', date: (new Date()).toISOString().slice(0, 10), contract: l.contract, depth: l.depth, entry_order: l.order_id, entry_status: entryFill.status, note: 'entry never filled — nothing to sell' });
      return;
    }
    const limit = Math.max(0.01, +(bid || 0.01).toFixed(2));
    const r = await placePaperOrder({ contract: l.contract, side: 'sell', qty: c.paperQty, limit });
    _append({ phase: 'paper_close', date: (new Date()).toISOString().slice(0, 10), contract: l.contract, depth: l.depth, exit_rule: rule, qty: c.paperQty, limit,
      entry_order: l.order_id, entry_fill: entryFill && entryFill.filled_avg_price,
      ...(r.order_id ? { order_id: r.order_id, order_status: r.status } : { error: r.error }) });
  } catch (_e) { /* the bridge must never break the shadow measurement */ }
}

/** Called every scan tick (fail-soft). Opens the shadow at the close window on eligible
 *  nights; closes it at the next open window. The paper bridge (OPTIONS_PAPER=1)
 *  mirrors the tickets to the Alpaca PAPER account; otherwise nothing is placed. */
async function tick() {
  const c = cfg();
  if (!c.enabled) return;
  const et = _etNow();
  const dow = et.getDay(); const hm = et.getHours() * 100 + et.getMinutes();
  // ET calendar date (not UTC — a 15:50 ET open and a 19:55 UTC timestamp must key the
  // same night, and the 09:31 close-next-morning must key a DIFFERENT date).
  const today = `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
  const st = _readState();

  // The overnight book owns the LADDER when its 4th exec tier is options — running
  // both would double-expose the SAME nightly signal on the same underlying (and the
  // direction lock can't catch it: both legs are long the same family). The PENNY
  // sleeve stays here either way — its intraday 2c-target exit is a genuinely
  // different holding period, not a duplicate of the close->open trade.
  const _overnightOwnsLadder = process.env.OVERNIGHT_TRADER === '1' &&
    String(process.env.OVERNIGHT_EXEC || '').toLowerCase() === 'options';

  // CLOSE WINDOW (15:45–15:59 ET, Mon–Thu): open tonight's shadow LADDER (one leg per depth)
  // + the vol-selective PENNY leg (entry priced at the ASK — the honest side of a 1¢ market).
  if (dow >= 1 && dow <= 4 && hm >= 1545 && hm <= 1559 && st.lastOpenDate !== today && !st.open) {
    const p = await probe();
    const legs = _overnightOwnsLadder ? []
      : ((p && p.legs) || []).filter((l) => l.contract && l.quote && l.quote.mid > 0);
    const _pennyOnly = _overnightOwnsLadder && p.penny && p.penny.pick;
    if (p.gates && p.gates.eligible && (legs.length || _pennyOnly)) {
      st.open = { date: today, symbol: c.symbol, expiry: p.expiry, spot_close: p.spot,
        legs: legs.map((l) => ({ depth: l.depth, strike: l.strike, contract: l.contract, entry_mid: l.quote.mid, entry_ask: l.quote.ask || null })) };
      if (p.penny && p.penny.pick) {
        st.open.legs.push({ depth: 'penny', strike: p.penny.pick.strike, contract: p.penny.pick.symbol,
          entry_mid: p.penny.pick.ask, entry_ask: p.penny.pick.ask, sigma: p.penny.pick.sigma, dist_pct: p.penny.pick.distPct });
      }
      // PAPER BRIDGE: buy the same tickets on the paper account (limit at the ask —
      // the honest side). Order ids ride on the legs so the exits can close them.
      if (c.paper) {
        for (const l of st.open.legs) {
          const limit = +(l.entry_ask || l.entry_mid).toFixed(2);
          if (!(limit > 0)) continue;
          const r = await placePaperOrder({ contract: l.contract, side: 'buy', qty: c.paperQty, limit });
          if (r.order_id) l.order_id = r.order_id;
          _append({ phase: 'paper_open', date: today, symbol: c.symbol, depth: l.depth, contract: l.contract, qty: c.paperQty, limit, ...(r.order_id ? { order_id: r.order_id, order_status: r.status } : { error: r.error }) });
        }
      }
      st.lastOpenDate = today; _writeState(st);
      for (const l of st.open.legs) _append({ phase: 'open', date: today, symbol: c.symbol, expiry: p.expiry, spot_close: p.spot, ...l, gates: p.gates });
      if (p.penny && !p.penny.pick) _append({ phase: 'skip_penny', date: today, symbol: c.symbol, why: p.penny.reason });
    } else {
      st.lastOpenDate = today; _writeState(st);   // one decision per night
      _append({ phase: 'skip', date: today, symbol: c.symbol, why: (p.gates && p.gates.why) || p.reason || 'no contract/quote', gates: p.gates || null });
    }
    return;
  }

  // PENNY WATCH (expiry day, 09:31–15:44 ET): sell the moment the bid clears the target
  // (> 1¢, default 2¢ = +100% gross); force-settle at the bid (usually 0 → −100%) at
  // 15:30+ so the book is flat before the next entry window. Runs every tick.
  if (st.open && Array.isArray(st.open.legs) && st.open.expiry === today && hm >= 931) {
    const keep = [];
    for (const l of st.open.legs) {
      if (l.depth !== 'penny') { keep.push(l); continue; }
      const q = await quoteOption(l.contract);
      const bid = (q && q.bid) || 0;
      if (bid >= c.pennyExitBid) {
        const pl = ((bid - l.entry_mid) / l.entry_mid) * 100;
        await _paperClose(c, l, bid, 'target_bid');
        _append({ phase: 'close', date: st.open.date, symbol: st.open.symbol, expiry: st.open.expiry, spot_close: st.open.spot_close, ...l, exit_mid: bid, exit_rule: 'target_bid', pl_pct: +pl.toFixed(1) });
      } else if (hm >= 1530) {
        const pl = ((bid - l.entry_mid) / l.entry_mid) * 100;   // usually −100 (bid 0 at expiry)
        await _paperClose(c, l, bid, 'expiry');
        _append({ phase: 'close', date: st.open.date, symbol: st.open.symbol, expiry: st.open.expiry, spot_close: st.open.spot_close, ...l, exit_mid: bid, exit_rule: 'expiry', pl_pct: +pl.toFixed(1) });
      } else {
        keep.push(l);   // still watching
      }
    }
    st.open.legs = keep;
    if (!keep.length) st.open = null;
    _writeState(st);
  }

  // OPEN WINDOW (09:31–09:50 ET): close the LADDER legs from a PRIOR date at the open
  // (mid). PENNY legs are deliberately skipped — the intraday watcher above owns them
  // (they ride until bid ≥ target or expiry settle).
  if (hm >= 931 && hm <= 950 && st.open && st.open.date !== today) {
    // Back-compat: a pre-ladder single-contract state closes as one leg.
    const legs = Array.isArray(st.open.legs) ? st.open.legs
      : (st.open.contract ? [{ depth: null, strike: st.open.strike, contract: st.open.contract, entry_mid: st.open.entry_mid }] : []);
    const remaining = [];
    for (const l of legs) {
      if (l.depth === 'penny') { remaining.push(l); continue; }   // watcher's job
      const q = await quoteOption(l.contract);
      if (q && q.mid > 0) {
        const pl = ((q.mid - l.entry_mid) / l.entry_mid) * 100;
        await _paperClose(c, l, q.bid || q.mid, 'open');
        _append({ phase: 'close', date: st.open.date, symbol: st.open.symbol || c.symbol, expiry: st.open.expiry, spot_close: st.open.spot_close, ...l, exit_mid: q.mid, pl_pct: +pl.toFixed(1) });
      } else {
        remaining.push(l);   // no quote yet → retry next tick within the window
      }
    }
    if (remaining.length) { st.open.legs = remaining; _writeState(st); }
    else { st.open = null; _writeState(st); }
  }
}

function status() {
  const rows = _readLedger();
  return { ...cfg(), minNights: MIN_N, state: _readState(), measured: summarize(rows), lastRows: rows.slice(-5) };
}

module.exports = { cfg, gates, cancelPaperOrder, pickStrike, pickPenny, parseOcc, summarize, nextTradingDayET, probe, tick, status, placePaperOrder, paperOrderFill, LEDGER, MIN_N,
  // options EXECUTION ADAPTER surface — the overnight book's 4th exec tier calls these
  listNextExpiryCalls, chainQuotes, quoteOption };
