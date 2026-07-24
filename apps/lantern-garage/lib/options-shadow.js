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
function gates(closes, { volMode = 'notflat' } = {}) {
  const i = closes.length - 1;
  if (i < 70) return { eligible: false, why: 'insufficient history' };
  const px = closes[i];
  const s50 = smaAt(closes, 50, i);
  const trendOk = (s50 == null || px > s50) && macdLine(closes) > 0;
  if (!trendOk) return { eligible: false, why: 'not trend-aligned (need close>SMA50 & MACD>0)', trendOk };
  // 10d realized vol vs trailing 60d median of the same measure (causal)
  const dret = []; for (let k = 1; k <= i; k++) if (closes[k - 1] > 0) dret.push(closes[k] / closes[k - 1] - 1);
  const rvAt = (endIdx) => { if (endIdx < 10) return null; const w = dret.slice(endIdx - 10, endIdx); const m = w.reduce((s, x) => s + x, 0) / w.length; return Math.sqrt(w.reduce((s, x) => s + (x - m) * (x - m), 0) / w.length); };
  const v = rvAt(dret.length);
  const hist = []; for (let e = Math.max(10, dret.length - 60); e < dret.length; e++) hist.push(rvAt(e));
  const vm = median(hist.filter((x) => x != null));
  const notFlat = v != null && vm != null && v > vm;
  const volOk = volMode === 'any' ? true : volMode === 'flat' ? !notFlat : notFlat;
  if (!volOk) return { eligible: false, why: `vol regime wrong (want ${volMode}; rv10=${v && v.toExponential(2)}, med=${vm && vm.toExponential(2)})`, trendOk, notFlat };
  return { eligible: true, trendOk, notFlat };
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
  return { ...out, data: 'ok', expiry: chain.expiry, legs };
}

/** Called every scan tick (fail-soft). Opens the shadow at the close window on eligible
 *  nights; closes it at the next open window. Never places an order anywhere. */
async function tick() {
  const c = cfg();
  if (!c.enabled) return;
  const et = _etNow();
  const dow = et.getDay(); const hm = et.getHours() * 100 + et.getMinutes();
  // ET calendar date (not UTC — a 15:50 ET open and a 19:55 UTC timestamp must key the
  // same night, and the 09:31 close-next-morning must key a DIFFERENT date).
  const today = `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
  const st = _readState();

  // CLOSE WINDOW (15:45–15:59 ET, Mon–Thu): open tonight's shadow LADDER (one leg per depth).
  if (dow >= 1 && dow <= 4 && hm >= 1545 && hm <= 1559 && st.lastOpenDate !== today && !st.open) {
    const p = await probe();
    const legs = ((p && p.legs) || []).filter((l) => l.contract && l.quote && l.quote.mid > 0);
    if (p.gates && p.gates.eligible && legs.length) {
      st.open = { date: today, symbol: c.symbol, expiry: p.expiry, spot_close: p.spot,
        legs: legs.map((l) => ({ depth: l.depth, strike: l.strike, contract: l.contract, entry_mid: l.quote.mid })) };
      st.lastOpenDate = today; _writeState(st);
      for (const l of st.open.legs) _append({ phase: 'open', date: today, symbol: c.symbol, expiry: p.expiry, spot_close: p.spot, ...l, gates: p.gates });
    } else {
      st.lastOpenDate = today; _writeState(st);   // one decision per night
      _append({ phase: 'skip', date: today, symbol: c.symbol, why: (p.gates && p.gates.why) || p.reason || 'no contract/quote', gates: p.gates || null });
    }
    return;
  }

  // OPEN WINDOW (09:31–09:50 ET): close a shadow ladder from a PRIOR date, leg by leg.
  if (hm >= 931 && hm <= 950 && st.open && st.open.date !== today) {
    // Back-compat: a pre-ladder single-contract state closes as one leg.
    const legs = Array.isArray(st.open.legs) ? st.open.legs
      : (st.open.contract ? [{ depth: null, strike: st.open.strike, contract: st.open.contract, entry_mid: st.open.entry_mid }] : []);
    const remaining = [];
    for (const l of legs) {
      const q = await quoteOption(l.contract);
      if (q && q.mid > 0) {
        const pl = ((q.mid - l.entry_mid) / l.entry_mid) * 100;
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

module.exports = { cfg, gates, pickStrike, summarize, nextTradingDayET, probe, tick, status, LEDGER, MIN_N };
