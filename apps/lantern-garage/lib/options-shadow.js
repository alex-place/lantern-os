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
    otmPct: n('OPTIONS_SHADOW_OTM_PCT', 0.25),      // % OTM for the call strike
    riskPct: n('OPTIONS_SHADOW_RISK_PCT', 0.5),     // % of equity at risk (premium) — stats only
    volMode: process.env.OPTIONS_SHADOW_VOL_MODE || 'notflat',  // notflat | flat | any (per-symbol regime)
  };
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

/** Measured stats + the Σ₀ verdict. Win rate here is an OUTPUT — never a target. */
function summarize(rows) {
  const closed = rows.filter((r) => r.phase === 'close' && typeof r.pl_pct === 'number');
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

/** Next-day (or nearest later) call contracts for the symbol from the TRADING API. */
async function listNextExpiryCalls(sym) {
  const auth = _auth();
  if (!auth) return { error: 'no alpaca auth' };
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const host = auth.env === 'live' ? 'api.alpaca.markets' : 'paper-api.alpaca.markets';
  const r = await _get(host, `/v2/options/contracts?underlying_symbols=${sym}&type=call&status=active&expiration_date_gte=${tomorrow}&limit=300`, auth.headers);
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

/** The would-trade selection for RIGHT NOW (also the live probe): gates + contract + quote. */
async function probe() {
  const c = cfg();
  const yahoo = require('./market-data-yahoo');
  let closes = [];
  try { const r = await yahoo.getBars(c.symbol, '1d'); closes = ((r && r.bars) || []).map((b) => b.close).filter((x) => x > 0); } catch (_e) { /* */ }
  const g = closes.length ? gates(closes, { volMode: c.volMode }) : { eligible: false, why: 'no daily bars' };
  const spot = closes[closes.length - 1] || 0;
  const out = { symbol: c.symbol, spot, gates: g, otmPct: c.otmPct };
  const chain = await listNextExpiryCalls(c.symbol);
  if (chain.error) return { ...out, data: 'unavailable', reason: chain.error };
  const strike = pickStrike(spot, chain.contracts.map((x) => x.strike_price), c.otmPct);
  const contract = chain.contracts.find((x) => Number(x.strike_price) === strike);
  if (!contract) return { ...out, data: 'ok', expiry: chain.expiry, reason: 'no OTM strike found' };
  const q = await quoteOption(contract.symbol);
  return { ...out, data: 'ok', expiry: chain.expiry, contract: contract.symbol, strike, quote: q };
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

  // CLOSE WINDOW (15:45–15:59 ET, Mon–Thu): open tonight's shadow position.
  if (dow >= 1 && dow <= 4 && hm >= 1545 && hm <= 1559 && st.lastOpenDate !== today && !st.open) {
    const p = await probe();
    if (p.gates && p.gates.eligible && p.contract && p.quote && p.quote.mid > 0) {
      st.open = { date: today, symbol: c.symbol, contract: p.contract, strike: p.strike, expiry: p.expiry, spot_close: p.spot, entry_mid: p.quote.mid };
      st.lastOpenDate = today; _writeState(st);
      _append({ phase: 'open', ...st.open, gates: p.gates });
    } else {
      st.lastOpenDate = today; _writeState(st);   // one decision per night
      _append({ phase: 'skip', date: today, symbol: c.symbol, why: (p.gates && p.gates.why) || p.reason || 'no contract/quote', gates: p.gates || null });
    }
    return;
  }

  // OPEN WINDOW (09:31–09:50 ET): close a shadow position from a PRIOR date.
  if (hm >= 931 && hm <= 950 && st.open && st.open.date !== today) {
    const q = await quoteOption(st.open.contract);
    if (q && q.mid > 0) {
      const pl = ((q.mid - st.open.entry_mid) / st.open.entry_mid) * 100;
      _append({ phase: 'close', ...st.open, exit_mid: q.mid, pl_pct: +pl.toFixed(1) });
      st.open = null; _writeState(st);
    }
    // no quote → leave open; retry next tick within the window (else it carries, honestly visible in status)
  }
}

function status() {
  const rows = _readLedger();
  return { ...cfg(), minNights: MIN_N, state: _readState(), measured: summarize(rows), lastRows: rows.slice(-5) };
}

module.exports = { cfg, gates, pickStrike, summarize, probe, tick, status, LEDGER, MIN_N };
