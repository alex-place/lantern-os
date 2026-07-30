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
    // Execution leverage (OVERNIGHT_EXEC=1x|2x|3x): SAME signals, levered ETF
    // execution. Backtested 2010-03..2026-07 net of slippage (scripts/
    // overnight-leverage-backtest.js): 3x = 29.3% CAGR / Sharpe 1.24 / maxDD 26%
    // vs 1x 8.7%/1.02/16% and SPY 12.2%/0.76/34% — and MORE cost-robust (the
    // per-night edge scales 3x while slippage stays ~1x). Levered ETFs beat
    // synthetic margin at every level (institutional financing inside the fund).
    // 'options' is the 4th tier: the SAME nightly signal executed as a next-day OTM
    // CALL ladder instead of shares (operator 2026-07-27 — the options trader was a
    // duplicate of this book's SPY uptrend sleeve, so it folded in here as execution
    // rather than a second engine with its own copy of the gate).
    exec: ['1x', '2x', '3x', 'options'].includes(String(process.env.OVERNIGHT_EXEC || '1x').toLowerCase())
      ? String(process.env.OVERNIGHT_EXEC || '1x').toLowerCase() : '1x',
    // Call-ladder depths (% OTM) when exec='options', and contracts per leg.
    optionLadder: String(process.env.OVERNIGHT_OPTION_LADDER || '0.25,0.5,1,1.5,2')
      .split(',').map((x) => parseFloat(x)).filter((x) => Number.isFinite(x) && x > 0),
    optionQty: Math.max(1, Math.min(10, n('OVERNIGHT_OPTION_QTY', 1))),
    // "Find the edge BEFORE entering" (operator rule): even when ARMED, a sleeve may
    // only place real orders after its OWN live ledger shows positive expectancy over
    // ≥ edgeMinN nights — until then that sleeve keeps trading dry, building the
    // evidence. A sleeve whose live expectancy turns NEGATIVE is auto-paused the same way.
    edgeGate: process.env.OVERNIGHT_EDGE_GATE !== '0',
    edgeMinN: n('OVERNIGHT_EDGE_MIN_N', 20),
    // PER-SLEEVE evidence bar. edgeMinN=20 is far below what detecting these edges actually
    // requires: a one-sided power calc at alpha=.05 / power=.80 (n = (z_a+z_b)^2 s^2 / d^2)
    // gives ~155 nights for capitulation (+18bp/night, s~90bp) and ~330 for the bear-rally
    // fade (13bp/night, s~95bp). The fade is also the ONLY sleeve whose backtest |t| (2.1)
    // sits BELOW the Harvey-Liu |t|>3.0 bar for a new factor claim under multiple testing, so
    // it carries the weakest prior and needs the most live evidence before it risks anything.
    // Raising only the fade here; the others are flagged in the note rather than changed
    // silently. Override per sleeve with OVERNIGHT_EDGE_MIN_N_FADE.
    edgeMinNBySleeve: {
      bear_rally_fade: n('OVERNIGHT_EDGE_MIN_N_FADE', 330),
    },
    allocPct: n('OVERNIGHT_ALLOC_PCT', 30),             // % of equity deployed across tonight's sleeves
    // OWN ACCOUNT (operator rule 2026-07-27). The intraday day-trader and this book
    // must not share a book: entangled equity makes each engine's P&L unattributable,
    // and measurement is the whole point while the sleeves earn their edge. Defaults
    // to the dedicated 'overnight-book' identity (OVERNIGHT_ALPACA_* keys, no
    // fallback to the day-trader's account — same contract as Sigma/Champion).
    // OVERNIGHT_USER still pins a specific identity for testing/back-compat.
    userId: process.env.OVERNIGHT_USER || require('./alpaca-adapter').OVERNIGHT_USER,
    // Which broker runs this book: 'alpaca' (default — API keys never expire, so the
    // 09:31 exit can't be orphaned by a dead session) or 'ibkr' (needs a live CPAPI
    // gateway session; an expired one would strand an open overnight leg).
    broker: process.env.OVERNIGHT_BROKER === 'ibkr' ? 'ibkr' : 'alpaca',
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
/** Signal symbol → levered execution instrument, per OVERNIGHT_EXEC tier.
 *  Unmapped symbols (GLD at 2x/3x, IWM at 2x) execute 1x — no levered data/
 *  backtest support for them. All instruments are covered by direction-lock. */
const EXEC_MAPS = {
  '1x': {},
  '2x': { SPY: 'SSO', QQQ: 'QLD' },
  '3x': { SPY: 'UPRO', QQQ: 'TQQQ', IWM: 'TNA', SH: 'SPXS' },
};

/** OPTIONS execution tier: the next-expiry OTM call ladder for one sleeve symbol.
 *  Chain discovery / quotes / paper order placement all live in options-shadow —
 *  that module is the options EXECUTION ADAPTER; the signal lives here. Returns
 *  [{depth, strike, contract, ask, bid}] (only legs with a real quote), or [].
 */
async function optionLadderFor(symbol, spot, ladder) {
  const ox = require('./options-shadow');
  const chain = await ox.listNextExpiryCalls(symbol).catch(() => ({ error: 'chain failed' }));
  if (!chain || chain.error || !Array.isArray(chain.contracts)) return { expiry: null, legs: [], why: (chain && chain.error) || 'no chain' };
  // The trade being measured is CLOSE → NEXT OPEN. An option whose nearest expiry is
  // days or weeks out is a DIFFERENT instrument (multi-week theta/vega held for one
  // night), and silently substituting it would corrupt the sleeve's expectancy. Only
  // symbols listing a next-session expiry are tradable on this tier — measured
  // 2026-07-27: SPY/QQQ/IWM list next-day, GLD +1d, SH +24d (monthlies only).
  const nextSession = ox.nextTradingDayET(_etNow());
  if (chain.expiry !== nextSession) {
    return { expiry: chain.expiry, legs: [], why: `no next-session expiry (nearest ${chain.expiry}, need ${nextSession}) — this symbol lists no overnight option` };
  }
  const strikes = chain.contracts.map((x) => Number(x.strike_price)).filter((x) => x > 0);
  const legs = [];
  for (const depth of ladder) {
    const strike = ox.pickStrike(spot, strikes, depth);
    const contract = strike != null ? chain.contracts.find((x) => Number(x.strike_price) === strike) : null;
    if (!contract) continue;
    const q = await ox.quoteOption(contract.symbol).catch(() => null);
    if (q && q.ask > 0) legs.push({ depth, strike, contract: contract.symbol, ask: q.ask, bid: q.bid });
  }
  return { expiry: chain.expiry, legs };
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
// One heartbeat row per ET day: proof the scheduler reached the engine at all.
// Cheap (deduped by date) and the difference between "declined" and "never ran".
function _heartbeat(state) {
  try {
    const { today } = _etParts();
    _appendOnce('hb_' + today + '_' + state, { phase: 'heartbeat', date: today, state });
  } catch (_e) { /* never break the tick */ }
}
// Append a row at most once per key for the life of the process.
const _seenKeys = new Set();
function _appendOnce(key, rec) {
  if (_seenKeys.has(key)) return;
  _seenKeys.add(key);
  _append(rec);
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
/** The evidence bar for one sleeve: its own override, else the global default. Pure. */
function minNFor(sleeve, c) {
  const per = c && c.edgeMinNBySleeve && c.edgeMinNBySleeve[sleeve];
  return Number.isFinite(per) ? per : (c && c.edgeMinN) || 20;
}
function canArm(sleeve, summary, c) {
  if (!c.armed) return { arm: false, why: 'not armed' };
  if (!c.edgeGate) return { arm: true, why: 'edge gate disabled' };
  const s = summary && summary.by_sleeve && summary.by_sleeve[sleeve];
  const need = minNFor(sleeve, c);
  // Check n against THIS sleeve's bar first: summarize() labels verdicts with the global
  // minN, so a sleeve with a raised bar can read 'positive_edge' on too little evidence.
  if (!s || s.n < need) return { arm: false, why: 'edge unproven (n=' + ((s && s.n) || 0) + '<' + need + ') — trading dry to build evidence' };
  if (s.verdict === 'insufficient_data') return { arm: false, why: 'edge unproven (n=' + s.n + '<' + need + ') — trading dry to build evidence' };
  if (s.verdict === 'negative_edge') return { arm: false, why: 'edge measured NEGATIVE live (avg ' + s.avg_pl_pct + '% over n=' + s.n + ') — sleeve auto-paused' };
  return { arm: true, why: 'edge proven live (avg +' + s.avg_pl_pct + '% over n=' + s.n + ')' };
}
function _readLedger() {
  try { return fs.readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_e) { return []; }
}

/** One scheduler tick — called from the autoscan loop (fail-soft). */
async function tick({ bridge } = {}) {
  const c = cfg();
  if (!c.enabled || !bridge) {
    // Even a disabled/bridge-less tick is worth one line per day: silence is
    // indistinguishable from a dead scheduler (2026-07-29: the process died
    // before the exit window and the position expired worthless — nobody knew
    // until the next morning).
    _heartbeat(!c.enabled ? 'disabled' : 'no_bridge');
    return;
  }
  const { dow, hm, today } = _etParts();
  const st = _readState();
  _heartbeat('alive');

  // WINDOW EVALUATED — the entry window must ALWAYS record its verdict. It
  // previously logged only when it entered or when a gate failed, so a window
  // that never ran and a window that correctly declined looked identical in the
  // ledger (operator, 2026-07-30: an entry window produced no row at all).
  if (dow >= 1 && dow <= 4 && hm >= 1545 && hm <= 1559) {
    const already = st.lastEnterDate === today;
    const holding = !!st.open;
    if (already || holding) {
      _appendOnce('window_' + today, {
        phase: 'window', date: today, entered: already, holding,
        why: already ? 'already entered today' : 'still holding a prior night — no new entry',
      });
    }
  }

  // EXIT WINDOW (09:31–09:50 ET): flatten last night's legs at ≈the open.
  if (hm >= 931 && hm <= 950 && st.open && st.open.date !== today) {
    const { brokerFacadeFor } = require('./broker-facade');
    const yahoo = require('./market-data-yahoo');
    const resolved = await brokerFacadeFor(c.userId, c.broker === 'ibkr' ? bridge : null).catch(() => null);
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
      // OPTION legs settle against the CONTRACT's bid at the open (not the underlying's
      // print) — entry at the ask, exit at the bid, the honest sides of a thin market.
      if (leg.instrument === 'option') {
        const ox = require('./options-shadow');
        const q = await ox.quoteOption(leg.contract).catch(() => null);
        const bid = (q && q.bid) || 0;
        const pl = leg.ref_close > 0 ? +(((bid - leg.ref_close) / leg.ref_close) * 100).toFixed(2) : null;
        let status = 'dry';
        if (leg.placed) {
          const r = bid > 0
            ? await ox.placePaperOrder({ contract: leg.contract, side: 'sell', qty: leg.qty, limit: bid }).catch((e) => ({ error: e.message }))
            : { error: 'no bid — leg left to expire worthless' };
          status = r && r.order_id ? 'placed' : `error:${(r && r.error) || 'unknown'}`;
        }
        _append({ phase: 'exit', date: st.open.date, ...leg, exit_bid: bid, pl_pct_est: pl, status, dry: !leg.placed });
        continue;
      }
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
    if (!sleeves.length) { _writeState(st); _append({ phase: 'skip', date: today, exec: c.exec, why: 'no sleeve gate passed — no symbol met an uptrend/capitulation/fade condition' }); return; }

    const { brokerFacadeFor } = require('./broker-facade');
    const resolved = await brokerFacadeFor(c.userId, c.broker === 'ibkr' ? bridge : null).catch(() => null);
    const account = resolved ? await resolved.facade.getIBKRAccount(c.userId).catch(() => null) : null;
    const equity = (account && Number(account.equity)) || 0;
    const baseDry = !c.armed || !resolved || !(equity > 0);
    const edge = summarize(_readLedger(), { minN: c.edgeMinN });
    // No commingling: skip any sleeve whose symbol the account ALREADY holds (an
    // intraday position, say) — a shared position would make both engines' exits
    // ambiguous about whose shares they're selling.
    let preHeld = {};
    let posArr = [];
    if (resolved) {
      posArr = (await resolved.facade.getIBKRPositions(c.userId).catch(() => [])) || [];
      for (const p of posArr) preHeld[String(p.symbol).toUpperCase()] = Number(p.qty) || 0;
    }
    const dlock = require('./direction-lock');
    // Allocation: an explicit OVERNIGHT_ALLOC_PCT pins it; otherwise the capital
    // allocator's evidence-driven budget for this sleeve owns the number (one book,
    // one allocator — operator directive 2026-07-26).
    let allocPct = c.allocPct;
    if (process.env.OVERNIGHT_ALLOC_PCT === undefined) {
      try { allocPct = await require('./capital-allocator').budgetPctFor('overnight'); } catch (_e) { /* keep default */ }
    }
    const per = (equity > 0 ? equity : 100000) * (allocPct / 100) / sleeves.length;
    // Levered execution: the signal decides, the exec map picks the instrument.
    const execMap = EXEC_MAPS[c.exec] || {};
    const execCloseBySym = {};
    for (const execSym of new Set(sleeves.map((s) => execMap[s.symbol]).filter(Boolean))) {
      try { const r = await yahoo.getBars(execSym, '1d'); const b = ((r && r.bars) || []).slice(-1)[0]; if (b && b.close > 0) execCloseBySym[execSym] = b.close; } catch (_e) { /* */ }
    }
    const legs = [];
    for (const s of sleeves) {
      const execSym = execMap[s.symbol] || s.symbol;
      // NO-COMMINGLING applies to SHARE execution only, and only to positions THIS
      // book opened. Two fixes (2026-07-27, from the first live session):
      //  • OPTIONS tier: holding QQQ *shares* cannot make a QQQ *call* exit ambiguous
      //    — different instruments, different symbols at the broker. A share position
      //    blocked the QQQ capitulation sleeve's whole ladder for no reason.
      //  • Unrelated/legacy holdings (another strategy's book, stale test positions)
      //    are not this engine's business: it manages ONLY what it opened, so those
      //    must not veto a signal. Only a leg still open in OUR OWN state counts.
      const ownOpen = new Set(((st.open && st.open.legs) || []).map((l) => String(l.symbol).toUpperCase()));
      if (c.exec !== 'options' && ownOpen.has(execSym)) { _append({ phase: 'skip_held', date: today, symbol: execSym, sleeve: s.sleeve, why: 'this book already holds the symbol from a prior night — not stacking' }); continue; }
      // DIRECTION LOCK: never enter against existing family exposure — e.g. the QQQ
      // capitulation long while the intraday engine holds SQQQ (the same downtrend
      // condition expressed opposite ways), or SH while the account is long SPY/SPXL.
      const dc = dlock.conflicts(execSym, posArr);
      if (dc.conflict) { _append({ phase: 'skip_conflict', date: today, symbol: execSym, sleeve: s.sleeve, why: `direction_conflict: opposite ${dc.family} exposure via ${dc.against.join('+')}` }); continue; }
      const px = execSym === s.symbol
        ? (closesBySym[s.symbol] && closesBySym[s.symbol].slice(-1)[0])
        : execCloseBySym[execSym];
      if (!(px > 0)) { _append({ phase: 'skip', date: today, symbol: execSym, sleeve: s.sleeve, why: 'no execution price' }); continue; }
      // Per-sleeve edge gate: a sleeve trades REAL (paper) money only after its own
      // live ledger proves the edge; until then it runs dry and keeps measuring.
      const gate = canArm(s.sleeve, edge, c);
      const placeReal = !baseDry && gate.arm;

      // ── OPTIONS tier: the same signal as a next-day OTM call ladder ──────────
      if (c.exec === 'options') {
        const ox = require('./options-shadow');
        const { expiry, legs: ladder, why: ladderWhy } = await optionLadderFor(s.symbol, px, c.optionLadder);
        if (!ladder.length) { _append({ phase: 'skip', date: today, symbol: s.symbol, sleeve: s.sleeve, exec: 'options', why: ladderWhy || 'no option ladder / quotes' }); continue; }
        for (const l of ladder) {
          let status = 'dry_run';
          if (placeReal) {
            // Marketable limit AT the ask — the honest side of a thin option market
            // (the same fill assumption the expectancy ledger measures against).
            const r = await ox.placePaperOrder({ contract: l.contract, side: 'buy', qty: c.optionQty, limit: l.ask }).catch((e) => ({ error: e.message }));
            status = r && r.order_id ? 'placed' : `error:${(r && r.error) || 'unknown'}`;
          }
          legs.push({ instrument: 'option', contract: l.contract, symbol: s.symbol, signal: s.symbol, sleeve: s.sleeve,
            depth: l.depth, strike: l.strike, expiry, qty: c.optionQty, ref_close: l.ask, placed: placeReal && status === 'placed' });
          _append({ phase: 'enter', date: today, instrument: 'option', contract: l.contract, symbol: s.symbol, signal: s.symbol,
            sleeve: s.sleeve, exec: 'options', depth: l.depth, strike: l.strike, expiry, spot_close: px,
            qty: c.optionQty, ref_close: l.ask, status, dry: !placeReal, edge_gate: gate.why });
        }
        continue;
      }

      const qty = Math.max(1, Math.floor(per / px));
      let status = 'dry_run';
      if (placeReal) {
        const r = await resolved.facade.placeIBKROrder(c.userId, { ticker: execSym, side: 'buy', qty, type: 'market', equity }).catch((e) => ({ status: 'error', reason: e.message }));
        status = (r && r.status) || 'error';
      }
      legs.push({ symbol: execSym, signal: s.symbol, sleeve: s.sleeve, qty, ref_close: px, placed: placeReal && status === 'placed' });
      _append({ phase: 'enter', date: today, symbol: execSym, signal: s.symbol, sleeve: s.sleeve, exec: c.exec, qty, ref_close: px, status, dry: !placeReal, edge_gate: gate.why });
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
  return { enabled: c.enabled, armed: c.armed, exec: c.exec, broker: c.broker, account: c.userId, edgeGate: c.edgeGate, edgeMinN: c.edgeMinN, allocPct: c.allocPct, userId: c.userId,
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

module.exports = { cfg, uptrendGate, capitulationGate, fadeGate, selectSleeves, optionLadderFor, summarize, canArm, minNFor, heldSymbols, tick, status, LEDGER, STATE };
