'use strict';

/**
 * overnight-trader.js — the measured "best version" of the stock day-trader:
 * a close→open OVERNIGHT sleeve book (loop stage: Act).
 *
 * Every sleeve is a backtested, ledger-recorded edge (data/oracle/active-loop-runs.jsonl,
 * runs: bandits-trader-*, downtrend-decomposition-*, net-of-costs-23y-retest):
 *   LONG sleeves (uptrend nights, Mon–Thu):    hold overnight when price>SMA50, MACD>0,
 *     and the per-symbol vol regime matches — SPY/IWM/GLD want vol above its trailing
 *     median ("notflat"), QQQ wants calm ("flat"). 23y pooled: Sharpe ~1.2, DD −7%.
 *   CAPITULATION longs (SPY, QQQ):             downtrend (price<SMA50 & MACD<0) closing
 *     AT a 20-day low → overnight gaps UP (+18bp/night, t=3.5, both halves of 30y agree).
 *     The strongest single edge found in the research arc; disjoint from uptrend nights →
 *     added to the book it lifted Sharpe 1.20 → 1.66 and halved drawdown.
 *   BEAR-RALLY FADE (via SH):                  a ≥+1% up-day inside an SPY downtrend →
 *     next overnight averages −13bp (t=−2.1) — expressed long-only by holding SH
 *     (−1× SPY) overnight. Marginal edge (SPY-only signal); smallest sleeve weight.
 *
 * GOVERNANCE (mirrors the Sigma book): OPT-IN and DRY by default.
 *   OVERNIGHT_TRADER=1  → the tick runs (plans + ledger). Off: complete no-op.
 *   OVERNIGHT_ARM=1     → real (paper) orders are placed through the broker facade;
 *                          otherwise every decision is logged with dry:true and nothing
 *                          is sent. Live accounts stay gated by trading-guard as always.
 * Entries 15:45–15:59 ET (≈MOC), exits 09:31–09:50 ET next session (≈MOO) — the same
 * auction prints the backtests measured. Ledger: overnight-trades.jsonl (append-only).
 */

const fs = require('fs');
const path = require('path');

const LEDGER = path.join(__dirname, '..', 'data', 'lantern-garage', 'trading', 'overnight-trades.jsonl');
const STATE = path.join(__dirname, '..', 'data', 'lantern-garage', 'trading', 'overnight-state.json');

function cfg() {
  const n = (name, d) => { const v = parseFloat(process.env[name]); return Number.isFinite(v) ? v : d; };
  return {
    enabled: process.env.OVERNIGHT_TRADER === '1',      // opt-in
    armed: process.env.OVERNIGHT_ARM === '1',           // place (paper) orders vs dry-log
    // "Find the edge BEFORE entering" (operator rule): even when ARMED, a sleeve may
    // only place real orders after its OWN live ledger shows positive expectancy over
    // ≥ edgeMinN nights — until then that sleeve keeps trading dry, building the
    // evidence. A sleeve whose live expectancy turns NEGATIVE is auto-paused the same way.
    edgeGate: process.env.OVERNIGHT_EDGE_GATE !== '0',
    edgeMinN: n('OVERNIGHT_EDGE_MIN_N', 20),
    allocPct: n('OVERNIGHT_ALLOC_PCT', 30),             // % of equity deployed across tonight's sleeves
    userId: process.env.OVERNIGHT_USER || process.env.TRADER_AUTO_USER || 'local-owner',
  };
}

// ── pure gate math (exported for tests; identical to the backtests) ───────────
function smaAt(a, nP, end) { if (end < nP - 1) return null; let s = 0; for (let i = end - nP + 1; i <= end; i++) s += a[i]; return s / nP; }
function emaAll(a, nP) { if (a.length < nP) return null; const k = 2 / (nP + 1); let e = a[0]; for (let i = 1; i < a.length; i++) e = a[i] * k + e * (1 - k); return e; }
function macdLine(closes) { if (closes.length < 35) return 0; const t = closes.slice(-35); return emaAll(t, 12) - emaAll(t, 26); }
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function rv10At(closes, end) {
  if (end < 11) return null;
  const r = []; for (let i = end - 9; i <= end; i++) r.push(closes[i] / closes[i - 1] - 1);
  const m = r.reduce((s, x) => s + x, 0) / r.length;
  return Math.sqrt(r.reduce((s, x) => s + (x - m) * (x - m), 0) / r.length);
}
/** Trend + per-symbol vol-regime gate for the LONG sleeves. */
function uptrendGate(closes, volMode) {
  const i = closes.length - 1;
  if (i < 70) return { pass: false, why: 'insufficient history' };
  const s50 = smaAt(closes, 50, i); const mh = macdLine(closes);
  if (!((s50 == null || closes[i] > s50) && mh > 0)) return { pass: false, why: 'not trend-aligned' };
  const v = rv10At(closes, i);
  if (v == null) return { pass: false, why: 'no vol read' };
  const hist = []; for (let e = Math.max(11, i - 60); e < i; e++) { const x = rv10At(closes, e); if (x != null) hist.push(x); }
  const vm = median(hist); const notFlat = vm != null && v > vm;
  const ok = volMode === 'any' ? true : volMode === 'flat' ? !notFlat : notFlat;
  return ok ? { pass: true, rule: `uptrend+${volMode}` } : { pass: false, why: `vol regime wrong (want ${volMode})` };
}
/** Capitulation gate: DOWNTREND closing at a 20-day low → hold LONG overnight. */
function capitulationGate(closes) {
  const i = closes.length - 1;
  if (i < 70) return { pass: false, why: 'insufficient history' };
  const s50 = smaAt(closes, 50, i); const mh = macdLine(closes);
  const down = (s50 != null && closes[i] < s50) && mh < 0;
  if (!down) return { pass: false, why: 'not a downtrend' };
  const lo20 = Math.min(...closes.slice(i - 19, i + 1));
  return closes[i] <= lo20 * 1.001 ? { pass: true, rule: 'capitulation_20d_low' } : { pass: false, why: 'not at the 20d low' };
}
/** Bear-rally fade gate (signal on SPY): downtrend + a ≥+1% up-day → hold SH overnight. */
function fadeGate(closes) {
  const i = closes.length - 1;
  if (i < 70) return { pass: false, why: 'insufficient history' };
  const s50 = smaAt(closes, 50, i); const mh = macdLine(closes);
  const down = (s50 != null && closes[i] < s50) && mh < 0;
  if (!down) return { pass: false, why: 'not a downtrend' };
  return (closes[i] / closes[i - 1] - 1) >= 0.01 ? { pass: true, rule: 'bear_rally_fade' } : { pass: false, why: 'no ≥+1% rally day' };
}
/** Tonight's sleeve selection from {SYM: closes[]}. Pure. */
function selectSleeves(closesBySym) {
  const out = [];
  const L = [['SPY', 'notflat'], ['QQQ', 'flat'], ['IWM', 'notflat'], ['GLD', 'notflat']];
  for (const [sym, vm] of L) {
    const c = closesBySym[sym]; if (!c || !c.length) continue;
    const g = uptrendGate(c, vm); if (g.pass) out.push({ symbol: sym, sleeve: g.rule });
  }
  for (const sym of ['SPY', 'QQQ']) {
    const c = closesBySym[sym]; if (!c || !c.length) continue;
    const g = capitulationGate(c); if (g.pass) out.push({ symbol: sym, sleeve: g.rule });
  }
  const spy = closesBySym.SPY;
  if (spy && spy.length) { const g = fadeGate(spy); if (g.pass) out.push({ symbol: 'SH', sleeve: g.rule }); }
  return out;
}

// ── plumbing ──────────────────────────────────────────────────────────────────
function _append(rec) {
  try { fs.mkdirSync(path.dirname(LEDGER), { recursive: true }); fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n'); }
  catch (_e) { /* ledger must never break the tick */ }
}
function _readState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_e) { return {}; } }
function _writeState(st) { try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(st)); } catch (_e) { /* */ } }
function _etNow() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })); }
function _etParts() { const et = _etNow(); return { dow: et.getDay(), hm: et.getHours() * 100 + et.getMinutes(), today: `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}` }; }

/** Per-sleeve expectancy from the ledger's own exit rows (est. close→open P&L). */
function summarize(rows, { minN = 20 } = {}) {
  const exits = (rows || []).filter((r) => r.phase === 'exit' && typeof r.pl_pct_est === 'number');
  const bySleeve = {};
  for (const sl of [...new Set(exits.map((r) => r.sleeve || 'unknown'))]) {
    const v = exits.filter((r) => (r.sleeve || 'unknown') === sl);
    const avg = v.reduce((s, r) => s + r.pl_pct_est, 0) / v.length;
    bySleeve[sl] = {
      n: v.length,
      win_pct: +(v.filter((r) => r.pl_pct_est > 0).length / v.length * 100).toFixed(1),
      avg_pl_pct: +avg.toFixed(3),
      verdict: v.length < minN ? 'insufficient_data' : avg > 0 ? 'positive_edge' : 'negative_edge',
    };
  }
  return { n_exits: exits.length, by_sleeve: bySleeve };
}
/** May this sleeve place a REAL order right now? Pure. Dry until proven, per sleeve. */
function canArm(sleeve, summary, c) {
  if (!c.armed) return { arm: false, why: 'not armed' };
  if (!c.edgeGate) return { arm: true, why: 'edge gate disabled' };
  const s = summary && summary.by_sleeve && summary.by_sleeve[sleeve];
  if (!s || s.verdict === 'insufficient_data') return { arm: false, why: 'edge unproven (n=' + ((s && s.n) || 0) + '<' + c.edgeMinN + ') — trading dry to build evidence' };
  if (s.verdict === 'negative_edge') return { arm: false, why: 'edge measured NEGATIVE live (avg ' + s.avg_pl_pct + '% over n=' + s.n + ') — sleeve auto-paused' };
  return { arm: true, why: 'edge proven live (avg +' + s.avg_pl_pct + '% over n=' + s.n + ')' };
}
function _readLedger() {
  try { return fs.readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_e) { return []; }
}

/** One scheduler tick — called from the autoscan loop (fail-soft). */
async function tick({ bridge } = {}) {
  const c = cfg();
  if (!c.enabled || !bridge) return;
  const { dow, hm, today } = _etParts();
  const st = _readState();

  // EXIT WINDOW (09:31–09:50 ET): flatten last night's legs at ≈the open.
  if (hm >= 931 && hm <= 950 && st.open && st.open.date !== today) {
    const { brokerFacadeFor } = require('./broker-facade');
    const yahoo = require('./market-data-yahoo');
    const resolved = await brokerFacadeFor(c.userId, bridge).catch(() => null);
    // Today's OPEN per held symbol — the est. exit print for EVERY leg (armed or dry),
    // so the ledger measures each sleeve's live expectancy and feeds the edge gate.
    const openBySym = {};
    for (const sym of [...new Set((st.open.legs || []).map((l) => l.symbol))]) {
      try { const r = await yahoo.getBars(sym, '1d'); const b = ((r && r.bars) || []).slice(-1)[0]; if (b && b.open > 0) openBySym[sym] = b.open; } catch (_e) { /* */ }
    }
    // Live position qtys — never sell more than the account actually holds (the
    // intraday engine or a stop may have already reduced/closed a leg overnight).
    let heldQty = {};
    if (resolved) {
      const pos = await resolved.facade.getIBKRPositions(c.userId).catch(() => []);
      for (const p of (pos || [])) heldQty[String(p.symbol).toUpperCase()] = Number(p.qty) || 0;
    }
    for (const leg of (st.open.legs || [])) {
      const exitRef = openBySym[leg.symbol] || null;
      const pl = exitRef && leg.ref_close > 0 ? +(((exitRef - leg.ref_close) / leg.ref_close) * 100).toFixed(3) : null;
      if (leg.placed && resolved) {
        const sellQty = Math.min(leg.qty, heldQty[leg.symbol] || 0);
        if (sellQty > 0) {
          const r = await resolved.facade.placeIBKROrder(c.userId, { ticker: leg.symbol, side: 'sell', qty: sellQty, type: 'market' }).catch((e) => ({ status: 'error', reason: e.message }));
          _append({ phase: 'exit', date: st.open.date, ...leg, sold_qty: sellQty, exit_ref_open: exitRef, pl_pct_est: pl, status: r && r.status, dry: false });
        } else {
          _append({ phase: 'exit', date: st.open.date, ...leg, sold_qty: 0, exit_ref_open: exitRef, pl_pct_est: pl, status: 'already_flat', dry: false });
        }
        // Cancel any resting protective SELL-STOP on this symbol (the intraday
        // re-protect pass attaches one to every naked long). An orphaned GTC stop on
        // a now-flat position would fire later and open an unintended short.
        try {
          if (typeof resolved.facade.cancelIBKROrder === 'function') {
            const orders = await resolved.facade.getIBKROpenOrders(c.userId).catch(() => []);
            for (const o of (orders || [])) {
              if (String(o.symbol || '').toUpperCase() === leg.symbol && /stp|stop/i.test(o.orderType || '') && /sell/i.test(o.side || '')) {
                await resolved.facade.cancelIBKROrder(c.userId, o.orderId || o.order_id).catch(() => {});
              }
            }
          }
        } catch (_e) { /* fail-soft */ }
      } else {
        _append({ phase: 'exit', date: st.open.date, ...leg, exit_ref_open: exitRef, pl_pct_est: pl, dry: true });
      }
    }
    st.open = null; _writeState(st);
    return;
  }

  // ENTRY WINDOW (15:45–15:59 ET, Mon–Thu): select tonight's sleeves and enter.
  if (dow >= 1 && dow <= 4 && hm >= 1545 && hm <= 1559 && st.lastEnterDate !== today && !st.open) {
    const yahoo = require('./market-data-yahoo');
    const closesBySym = {};
    for (const sym of ['SPY', 'QQQ', 'IWM', 'GLD', 'SH']) {
      try { const r = await yahoo.getBars(sym, '1d'); closesBySym[sym] = ((r && r.bars) || []).map((b) => b.close).filter((x) => x > 0); }
      catch (_e) { closesBySym[sym] = []; }
    }
    const sleeves = selectSleeves(closesBySym);
    st.lastEnterDate = today;
    if (!sleeves.length) { _writeState(st); _append({ phase: 'skip', date: today, why: 'no sleeve gate passed' }); return; }

    const { brokerFacadeFor } = require('./broker-facade');
    const resolved = await brokerFacadeFor(c.userId, bridge).catch(() => null);
    const account = resolved ? await resolved.facade.getIBKRAccount(c.userId).catch(() => null) : null;
    const equity = (account && Number(account.equity)) || 0;
    const baseDry = !c.armed || !resolved || !(equity > 0);
    const edge = summarize(_readLedger(), { minN: c.edgeMinN });
    // No commingling: skip any sleeve whose symbol the account ALREADY holds (an
    // intraday position, say) — a shared position would make both engines' exits
    // ambiguous about whose shares they're selling.
    let preHeld = {};
    if (resolved) {
      const pos = await resolved.facade.getIBKRPositions(c.userId).catch(() => []);
      for (const p of (pos || [])) preHeld[String(p.symbol).toUpperCase()] = Number(p.qty) || 0;
    }
    const per = (equity > 0 ? equity : 100000) * (c.allocPct / 100) / sleeves.length;
    const legs = [];
    for (const s of sleeves) {
      if ((preHeld[s.symbol] || 0) > 0) { _append({ phase: 'skip_held', date: today, symbol: s.symbol, sleeve: s.sleeve, why: 'symbol already held by another strategy — no commingling' }); continue; }
      const px = closesBySym[s.symbol] && closesBySym[s.symbol].slice(-1)[0];
      if (!(px > 0)) continue;
      const qty = Math.max(1, Math.floor(per / px));
      // Per-sleeve edge gate: a sleeve trades REAL (paper) money only after its own
      // live ledger proves the edge; until then it runs dry and keeps measuring.
      const gate = canArm(s.sleeve, edge, c);
      const placeReal = !baseDry && gate.arm;
      let status = 'dry_run';
      if (placeReal) {
        const r = await resolved.facade.placeIBKROrder(c.userId, { ticker: s.symbol, side: 'buy', qty, type: 'market', equity }).catch((e) => ({ status: 'error', reason: e.message }));
        status = (r && r.status) || 'error';
      }
      legs.push({ symbol: s.symbol, sleeve: s.sleeve, qty, ref_close: px, placed: placeReal && status === 'placed' });
      _append({ phase: 'enter', date: today, symbol: s.symbol, sleeve: s.sleeve, qty, ref_close: px, status, dry: !placeReal, edge_gate: gate.why });
    }
    if (legs.length) { st.open = { date: today, legs }; }
    _writeState(st);
  }
}

/** Status for the HTTP route: config + open state + recent ledger rows. */
function status() {
  const c = cfg();
  let last = [];
  try { last = fs.readFileSync(LEDGER, 'utf8').trim().split('\n').slice(-12).map((l) => JSON.parse(l)); } catch (_e) { /* */ }
  return { enabled: c.enabled, armed: c.armed, edgeGate: c.edgeGate, edgeMinN: c.edgeMinN, allocPct: c.allocPct, userId: c.userId,
    edge: summarize(_readLedger(), { minN: c.edgeMinN }), state: _readState(), recent: last };
}

/** Symbols the overnight book currently owns (for the intraday engine's exclusion —
 *  each engine manages ONLY its own positions). Fail-soft empty set. */
function heldSymbols() {
  try {
    const st = _readState();
    return new Set(((st.open && st.open.legs) || []).map((l) => String(l.symbol).toUpperCase()));
  } catch (_e) { return new Set(); }
}

module.exports = { cfg, uptrendGate, capitulationGate, fadeGate, selectSleeves, summarize, canArm, heldSymbols, tick, status, LEDGER, STATE };
