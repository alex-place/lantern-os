'use strict';
/**
 * polarity_calibration.js — is the polarity veto calibrated, or is it blocking
 * the one mechanism that makes down days profitable? (operator, 2026-08-25)
 *
 * The lab evidence (#3456) says the three inverses are REGIME COMPLETION, not
 * beta: adding 3x LONGS to the 9-name book doubles return but leaves down days
 * broken (48% WR, -0.870%/trade); adding the 3x INVERSES flips them positive
 * (65% WR, +1.237%/trade). Live, the engine takes an inverse on 8.6% of entries.
 * Something between "the signal fires" and "the order goes in" is eating them.
 *
 * That something is measurable WITHOUT a backtest, because #3343/#3349 already
 * journal the counterfactual: every wrapper fire — vetoed OR allowed — is written
 * to the trades log with its full causal context (wrapper_ibs, underlying_ibs,
 * spy_tape, spy_mom30, spy_lower_low, wrapper_dd, underlying_tape, et_min). So
 * this lab does not simulate the veto: it replays the REAL fires the REAL engine
 * saw, prices them on real forward bars, and asks of each gate whether the trades
 * it blocked were worse than the trades it let through.
 *
 * THREE CONFOUNDS THIS LAB REFUSES TO PRETEND AWAY — they are why the naive
 * allowed-vs-vetoed split in section 1 is reported but NOT concluded from:
 *
 *  (a) DAY MIX. The operator armed TRADER_SHORT_EDGE=selective mid-window, so
 *      vetoes cluster on 08-19..08-21 and allows on 08-21..08-25. Comparing the
 *      two pools compares different market days, not different setups. Only
 *      2026-08-21 carries both in quantity, so it gets its own paired row.
 *  (b) MODE. 1,668 of the logged fires ran under mode "0" — the blanket #3296
 *      ban, not the selective gate. They are evidence about the BAN, and are
 *      scored separately from the gate's own decisions.
 *  (c) SESSION. The scanner logs fires around the clock (one sample sits at
 *      19:45 ET). A fire the day-trader could never act on is not evidence, so
 *      only 09:30-16:00 ET on a weekday counts.
 *
 * Decision unit: FIRST fire per (symbol, session, hour) — the engine runs
 * TRADER_ENTRY_CADENCE_MIN=60, so a symbol gets at most one decision an hour no
 * matter how many 60s scans re-log the same setup. Scoring per-scan rows would
 * count one setup 40 times and let a single trending hour dominate.
 *
 * Forward returns run from the logged fire price on 5m bars: +30m, +60m, and to
 * the session close. Every horizon ends at or before the close of the fire's own
 * day; unfinished horizons are dropped rather than truncated.
 *
 * Usage: node experiments/polarity_calibration.js
 */
const https = require('https');

const LOGS = [
  ['stable', 'C:/dev/lantern-os-stable/data/lantern-garage/trading/autopilot-trades.jsonl'],
  ['race', 'C:/dev/lantern-race/data/lantern-garage/trading/autopilot-trades.jsonl'],
];
const OPEN_MIN = 9 * 60 + 30, CLOSE_MIN = 16 * 60;

function fetchJson(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'user-agent': 'Mozilla/5.0' } }, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
async function chart(sym, interval, fromSec) {
  const p2 = Math.floor(Date.now() / 1000);
  const j = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&period1=${fromSec}&period2=${p2}`);
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error('no chart data for ' + sym);
  const ts = r.timestamp || [], q = r.indicators.quote[0], out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null) continue;
    out.push({ t: ts[i] * 1000, c: q.close[i], h: q.high[i], l: q.low[i] });
  }
  return out;
}
const ET = (ms) => new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' }));
const ET_DAY = (ms) => { const d = ET(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const ET_MIN = (ms) => { const d = ET(ms); return d.getHours() * 60 + d.getMinutes(); };
const ET_DOW = (ms) => ET(ms).getDay();

// ---------------------------------------------------------------- load fires
function loadFires() {
  const fs = require('fs');
  const seen = new Map();
  const drop = { offSession: 0, weekend: 0, dup: 0 };
  let rawRows = 0;
  for (const [box, path] of LOGS) {
    if (!fs.existsSync(path)) continue;
    for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (!line || line.indexOf('polarity_') < 0) continue;
      let r; try { r = JSON.parse(line); } catch (_e) { continue; }
      if (r.event !== 'polarity_veto' && r.event !== 'polarity_allow') continue;
      rawRows++;
      const ms = Date.parse(r.ts), day = ET_DAY(ms), min = ET_MIN(ms), dow = ET_DOW(ms);
      if (dow === 0 || dow === 6) { drop.weekend++; continue; }            // (c)
      if (min < OPEN_MIN || min > CLOSE_MIN) { drop.offSession++; continue; }
      const key = `${r.symbol}|${day}|${Math.floor(min / 60)}`;
      if (seen.has(key)) { drop.dup++; continue; }
      seen.set(key, {
        box, sym: r.symbol, ms, day, min, price: Number(r.price),
        allowed: r.event === 'polarity_allow', mode: String(r.mode),
        wIbs: r.wrapper_ibs, uIbs: r.underlying_ibs, under: r.underlying,
        tape: r.spy_tape, mom30: r.spy_mom30, ll: r.spy_lower_low,
        dd: r.wrapper_dd, uTape: r.underlying_tape,
      });
    }
  }
  return { fires: [...seen.values()].sort((a, b) => a.ms - b.ms), rawRows, drop };
}

// ------------------------------------------------------------------- pricing
function priceFires(fires, bars) {
  const out = [];
  for (const f of fires) {
    const b = bars[f.sym];
    if (!b || !b.length) continue;
    const same = b.filter((x) => ET_DAY(x.t) === f.day && ET_MIN(x.t) >= OPEN_MIN && ET_MIN(x.t) <= CLOSE_MIN);
    if (same.length < 2) continue;
    const at = (mins) => {
      const target = Math.min(f.min + mins, CLOSE_MIN);
      const cand = same.filter((x) => ET_MIN(x.t) >= target);
      if (cand.length) return cand[0].c;
      const last = same[same.length - 1];
      return ET_MIN(last.t) >= CLOSE_MIN - 10 ? last.c : null;   // session is over: last print is the close
    };
    const px = Number(f.price);
    if (!(px > 0)) continue;
    const r30 = at(30), r60 = at(60), rEod = at(600);
    const win = same.filter((x) => ET_MIN(x.t) > f.min && ET_MIN(x.t) <= Math.min(f.min + 60, CLOSE_MIN));
    out.push({
      ...f,
      r30: r30 == null ? null : (r30 / px - 1) * 100,
      r60: r60 == null ? null : (r60 / px - 1) * 100,
      rEod: rEod == null ? null : (rEod / px - 1) * 100,
      mfe: win.length ? (Math.max(...win.map((x) => x.h)) / px - 1) * 100 : null,
      mae: win.length ? (Math.min(...win.map((x) => x.l)) / px - 1) * 100 : null,
    });
  }
  return out;
}

// ------------------------------------------------------------------ reporting
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const fmt = (v, w = 7) => (v == null ? '-'.padStart(w) : ((v >= 0 ? '+' : '') + v.toFixed(2) + '%').padStart(w));
const pc = (w) => (w == null ? '  -  ' : (w * 100).toFixed(0).padStart(4) + '%');
function agg(rows, key) {
  const v = rows.map((r) => r[key]).filter((x) => x != null);
  if (!v.length) return { n: 0, wr: null, avg: null, tot: null };
  return { n: v.length, wr: v.filter((x) => x > 0).length / v.length, avg: mean(v), tot: v.reduce((s, x) => s + x, 0) };
}
function row(label, rows) {
  const a30 = agg(rows, 'r30'), a60 = agg(rows, 'r60'), ae = agg(rows, 'rEod'), mf = agg(rows, 'mfe');
  console.log(`  ${label.padEnd(44)} n ${String(rows.length).padStart(3)} | +30m ${fmt(a30.avg)} ${pc(a30.wr)} | +60m ${fmt(a60.avg)} ${pc(a60.wr)} | close ${fmt(ae.avg)} ${pc(ae.wr)} | MFE60 ${fmt(mf.avg)}`);
}

// the two hard gates of TRADER_SHORT_EDGE=selective, exactly as scan.js applies them
const GATE_DD = (f, maxDD) => f.dd != null && f.dd <= -maxDD;             // "wrapper already fell"
const GATE_UT = (f, maxUT) => f.uTape != null && f.uTape >= maxUT;        // "underlying ripping"
const UNREADABLE = (f) => f.dd == null || f.uTape == null || f.min == null;
const passes = (f, maxDD, maxUT) => !UNREADABLE(f) && !GATE_DD(f, maxDD) && !GATE_UT(f, maxUT);


// ------------------------------------------------- the downstream funnel
// Same dedupe as the fires (symbol|day|hour) so the two halves are comparable.
// EXIT-path skips ("bearish, no long to exit") are not entry decisions and are
// excluded; so is the weekend/off-session traffic.
function loadFunnel() {
  const fs = require('fs');
  const INV = new Set(['SQQQ', 'SOXS', 'SPXS', 'TZA', 'SDOW', 'SH', 'PSQ', 'RWM']);
  const k = (r) => { const ms = Date.parse(r.ts); return `${r.symbol}|${ET_DAY(ms)}|${Math.floor(ET_MIN(ms) / 60)}`; };
  const inSession = (r) => {
    const ms = Date.parse(r.ts), dow = ET_DOW(ms), m = ET_MIN(ms);
    return dow > 0 && dow < 6 && m >= OPEN_MIN && m <= CLOSE_MIN;
  };
  const by = new Map();          // why -> {inv:Set, lng:Set}
  const reach = { inv: new Set(), lng: new Set() }, entered = { inv: new Set(), lng: new Set() };
  for (const [, path] of LOGS) {
    if (!fs.existsSync(path)) continue;
    for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch (_e) { continue; }
      if (!r.ts || r.ts < '2026-08-18' || !r.symbol || !inSession(r)) continue;
      const side = INV.has(r.symbol) ? 'inv' : 'lng';
      if (r.event === 'entry' || r.event === 'entry_fill') { entered[side].add(k(r)); reach[side].add(k(r)); continue; }
      if (r.event !== 'skip') continue;
      const why = String(r.reason || '').split(/[:(]/)[0].trim();
      if (!why || /no long to exit|bearish/.test(why)) continue;      // exit path, not an entry decision
      reach[side].add(k(r));
      if (!by.has(why)) by.set(why, { inv: new Set(), lng: new Set() });
      by.get(why)[side].add(k(r));
    }
  }
  const blockers = [...by.entries()]
    .map(([why, v]) => [why, { inv: v.inv.size, lng: v.lng.size, keys: [...v.inv] }])
    .sort((a, b) => b[1].inv - a[1].inv || b[1].lng - a[1].lng)
    .slice(0, 10);
  return { blockers, reach: { inv: reach.inv.size, lng: reach.lng.size }, entered: { inv: entered.inv.size, lng: entered.lng.size } };
}

(async () => {
  const { fires, rawRows, drop } = loadFires();
  if (!fires.length) { console.log('no usable polarity rows in the live logs'); return; }
  const syms = [...new Set(fires.map((f) => f.sym))];
  console.log('POLARITY CALIBRATION — the live counterfactual, priced on real forward bars\n');
  console.log(`  ${rawRows} logged wrapper fires`);
  console.log(`    -${drop.weekend} weekend  -${drop.offSession} outside 09:30-16:00 ET  -${drop.dup} same symbol/hour (cadence dedupe)`);
  console.log(`    = ${fires.length} decisions across ${syms.join('/')}, ${fires[0].day} .. ${fires[fires.length - 1].day}`);

  const bars = {};
  for (const s of syms) bars[s] = await chart(s, '5m', Math.floor(Date.parse(fires[0].day + 'T00:00:00Z') / 1000) - 3 * 86400);
  const P = priceFires(fires, bars);
  const SEL = P.filter((f) => f.mode === 'selective');
  const BAN = P.filter((f) => f.mode === '0');
  console.log(`    priced ${P.length}  —  ${SEL.length} judged by the selective gate, ${BAN.length} by the mode-0 blanket ban\n`);

  // ---- 0. the confound, stated up front -----------------------------------
  console.log('0. THE DAY MIX — why section 1 cannot be read as a verdict');
  const days = [...new Set(P.map((f) => f.day))].sort();
  console.log(`  ${'day'.padEnd(12)}${'allowed'.padStart(8)}${'vetoed'.padStart(8)}   mode        SPY session`);
  for (const d of days) {
    const g = P.filter((f) => f.day === d);
    const spy = bars.SPY ? null : null;
    console.log(`  ${d.padEnd(12)}${String(g.filter((f) => f.allowed).length).padStart(8)}${String(g.filter((f) => !f.allowed).length).padStart(8)}   ${[...new Set(g.map((f) => f.mode))].join('+').padEnd(12)}`);
  }
  console.log('  -> the pools are largely DIFFERENT DAYS. Only a within-day split is a comparison.\n');

  // ---- 1. the naive split (reported, not concluded from) ------------------
  console.log('1. NAIVE SPLIT — allowed vs vetoed across the whole window (CONFOUNDED by day mix)');
  row('ALLOWED (the engine could enter)', P.filter((f) => f.allowed));
  row('VETOED  (the engine refused)', P.filter((f) => !f.allowed));
  console.log('');

  // ---- 2. the within-day paired comparison — the real test ----------------
  console.log('2. WITHIN-DAY — same session, same tape, allowed vs vetoed side by side');
  let pairedA = [], pairedV = [];
  for (const d of days) {
    const g = P.filter((f) => f.day === d);
    const a = g.filter((f) => f.allowed), v = g.filter((f) => !f.allowed);
    if (a.length >= 2 && v.length >= 2) {
      pairedA = pairedA.concat(a); pairedV = pairedV.concat(v);
      row(`${d}  allowed`, a);
      row(`${d}  VETOED`, v);
    }
  }
  if (pairedA.length) {
    console.log('  ' + '-'.repeat(120));
    row('POOLED within-day  allowed', pairedA);
    row('POOLED within-day  VETOED', pairedV);
    const da = agg(pairedA, 'r60').avg, dv = agg(pairedV, 'r60').avg;
    console.log(`  -> the gate kept the ${da > dv ? 'BETTER' : 'WORSE'} half by ${Math.abs(da - dv).toFixed(2)}pp/trade at 60m`
      + ` (${pairedA.length} vs ${pairedV.length} decisions, ${[...new Set(pairedA.concat(pairedV).map((f) => f.day))].length} session(s))`);
  } else {
    console.log('  no session carries both pools in quantity — no paired test is possible');
  }
  console.log('');

  // ---- 3. gate decomposition, selective rows only -------------------------
  console.log('3. GATE DECOMPOSITION — what each selective rule blocked (live: DD -1.5%, uTape +0.5%)');
  const vet = SEL.filter((f) => !f.allowed);
  row('blocked: wrapper already fell', vet.filter((f) => GATE_DD(f, 1.5) && !GATE_UT(f, 0.5)));
  row('blocked: underlying ripping', vet.filter((f) => !GATE_DD(f, 1.5) && GATE_UT(f, 0.5)));
  row('blocked: both', vet.filter((f) => GATE_DD(f, 1.5) && GATE_UT(f, 0.5)));
  row('blocked: inputs unreadable', vet.filter((f) => UNREADABLE(f)));
  row('ALLOWED through both gates', SEL.filter((f) => f.allowed));
  console.log('');

  // ---- 4. threshold sweep, with leave-one-day-out --------------------------
  console.log('4. THRESHOLD SWEEP — every fire re-judged under each pair (same population, so day mix cancels)');
  const DDs = [0.75, 1.0, 1.5, 2.0, 3.0, 99], UTs = [0.0, 0.25, 0.5, 1.0, 2.0, 99];
  const sweepDays = [...new Set(SEL.map((f) => f.day))];
  const grid = [];
  for (const dd of DDs) for (const ut of UTs) {
    const pass = SEL.filter((f) => passes(f, dd, ut));
    const a = agg(pass, 'r60'), ae = agg(pass, 'rEod');
    // leave-one-day-out: the worst per-trade result with any single session removed
    let loo = null;
    for (const d of sweepDays) {
      const x = agg(pass.filter((f) => f.day !== d), 'r60').avg;
      if (x != null && (loo == null || x < loo)) loo = x;
    }
    grid.push({ dd, ut, n: pass.length, wr: a.wr, avg: a.avg, tot: a.tot, loo, eodAvg: ae.avg });
  }
  const lbl = (v) => (v >= 99 ? ' off' : v.toFixed(2));
  console.log(`     ${'maxDD'.padEnd(6)}${'maxUT'.padEnd(6)}${'n'.padStart(4)}  ${'WR60'.padStart(5)}  ${'avg60'.padStart(7)}  ${'LOO-worst'.padStart(9)}  ${'avgEod'.padStart(7)}`);
  const uniq = [];
  for (const g of grid.slice().sort((a, b) => (b.avg == null ? -1e9 : b.avg) - (a.avg == null ? -1e9 : a.avg))) {
    if (uniq.some((u) => u.n === g.n)) continue;             // collapse threshold pairs that select the same set
    uniq.push(g); if (uniq.length >= 8) break;
  }
  for (const g of uniq) console.log(`     ${lbl(g.dd).padEnd(6)}${lbl(g.ut).padEnd(6)}${String(g.n).padStart(4)}  ${pc(g.wr)}  ${fmt(g.avg)}  ${fmt(g.loo, 9)}  ${fmt(g.eodAvg)}`);
  const live = grid.find((g) => g.dd === 1.5 && g.ut === 0.5);
  console.log(`     ${'LIVE'.padEnd(12)}${String(live.n).padStart(4)}  ${pc(live.wr)}  ${fmt(live.avg)}  ${fmt(live.loo, 9)}  ${fmt(live.eodAvg)}`);
  console.log('');

  // ---- 5. the mode-0 ban's own counterfactual -----------------------------
  if (BAN.length) {
    console.log('5. THE BLANKET BAN (mode 0) — everything it refused, and what those setups did');
    row('all mode-0 refusals', BAN);
    row('  ...that WOULD have passed selective', BAN.filter((f) => passes(f, 1.5, 0.5)));
    row('  ...that selective would also refuse', BAN.filter((f) => !passes(f, 1.5, 0.5)));
    console.log('');
  }

  // ---- 6. by tape regime — the down-day question --------------------------
  console.log('6. BY SPY TAPE AT THE FIRE — the mechanism the down-day lab says we are missing');
  const bandOf = (f) => (f.tape == null ? '?' : f.tape <= -0.5 ? 'SPY <= -0.5%' : f.tape <= -0.1 ? 'SPY -0.5..-0.1%' : f.tape < 0.3 ? 'SPY flat' : 'SPY >= +0.3%');
  for (const b of ['SPY <= -0.5%', 'SPY -0.5..-0.1%', 'SPY flat', 'SPY >= +0.3%']) {
    const g = P.filter((f) => bandOf(f) === b);
    if (g.length) row(b, g);
  }
  console.log('');

  // ---- 8. THE FUNNEL — where an allowed inverse actually dies -------------
  console.log('8. THE FUNNEL — polarity is a gate, not the gate. What stopped the fires it ALLOWED?');
  const funnel = loadFunnel();
  const priceKeys = (keys) => {
    const out = [];
    for (const k of keys) {
      const [sym, day, hour] = k.split('|');
      const cand = P.filter((f) => f.sym === sym && f.day === day && Math.floor(f.min / 60) === Number(hour));
      if (cand.length) out.push(cand[0]);
    }
    return out;
  };
  console.log(`  ${'blocker'.padEnd(34)}${'inverse'.padStart(9)}${'long'.padStart(7)}   (symbol-hours, both boxes, in-session)`);
  for (const [why, v] of funnel.blockers) console.log(`  ${why.padEnd(34)}${String(v.inv).padStart(9)}${String(v.lng).padStart(7)}`);
  console.log(`  ${'-> REACHED the entry loop'.padEnd(34)}${String(funnel.reach.inv).padStart(9)}${String(funnel.reach.lng).padStart(7)}`);
  console.log(`  ${'-> ENTERED'.padEnd(34)}${String(funnel.entered.inv).padStart(9)}${String(funnel.entered.lng).padStart(7)}`);
  console.log(`  conversion: inverses ${(funnel.entered.inv / Math.max(1, funnel.reach.inv) * 100).toFixed(0)}% of what reached the loop, longs ${(funnel.entered.lng / Math.max(1, funnel.reach.lng) * 100).toFixed(0)}%`);
  console.log('');
  console.log('  and what those refusals were worth, priced the same way:');
  for (const [why, v] of funnel.blockers) {
    const rows = priceKeys(v.keys);
    if (rows.length >= 3) row(`refused by ${why}`, rows);
  }
  console.log('');

  // ---- 7. by hour ---------------------------------------------------------
  console.log('7. BY HOUR (the time weight #3356 prices as a p_win penalty, not a floor)');
  for (let h = 9; h <= 15; h++) {
    const g = P.filter((f) => Math.floor(f.min / 60) === h);
    if (g.length) row(`${String(h).padStart(2)}:00`, g);
  }
})().catch((e) => { console.error('lab failed:', e.message); process.exit(1); });
