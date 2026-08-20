'use strict';
/**
 * experiments/veto_replay.js — what the 34 gates actually cost, on a VALIDATED yardstick.
 *
 * Two earlier versions of this measurement were wrong, and the control run is
 * what caught both:
 *
 *   v1 scored each blocked signal as a +-3% barrier trade. The control scored
 *      the trader's real, profitable book (+$10,986, 65% winners) at +0.009R —
 *      break-even — because the live edge is in the exit stack and a fixed
 *      barrier discards it. Unusable.
 *   v2 dropped the exit model for MFE/MAE to session close. Control rho 0.13:
 *      still no resolution. The window was the bug — an entry at 10:00 was
 *      being scored over 6 hours when the median trade lives 73 minutes.
 *
 * A horizon sweep against the 81 trades whose outcome we know found the signal
 * decays sharply with window length:
 *
 *      30min 0.450 | 60min 0.495 | 120min 0.434 | 390min 0.206 | 640min 0.120
 *
 * 60 minutes is both the peak AND the median real holding period (73 min), so
 * the principled choice and the empirical one agree — this is not a window
 * picked to flatter the result.
 *
 * At that horizon rho(edge, real % return) = 0.495 on the control, which is a
 * yardstick with genuine resolution. Everything below is measured on it.
 *
 *   edge = MFE + MAE (MAE negative): did the move offer more room than it took?
 *
 * Vetoed candidates and taken trades are scored identically, so the comparison
 * is like-for-like, and a seeded permutation test says whether the gap between
 * them survives chance.
 *
 *   node experiments/veto_replay.js
 *   HORIZON_BARS=24 node experiments/veto_replay.js      # sensitivity
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.LANTERN_ROOT || path.join(__dirname, '..');
const BARS = path.join(ROOT, 'data/lantern-garage/trading/bars');
const LEDGER = path.join(ROOT, 'data/lantern-garage/trading/autopilot-trades.jsonl');
// Outputs go to the temp dir, not the repo tree — this is a measurement, not a build
// artefact, and the candidate set is regenerated on every run.
const OUT = process.env.VETO_CANDIDATES || path.join(os.tmpdir(), 'veto-candidates.json');
const HORIZON_BARS = Number(process.env.HORIZON_BARS) || 12;   // 12 x 5m = 60 min
const TOUCH_PCT = Number(process.env.TOUCH_PCT) || 1;

const eD = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const eHM = (t) => new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });

const GATES = [
  ['falling_knife',      /falling_knife/],
  ['persistence',        /consecutive bullish scans/],
  ['post_stop_cooldown', /post-stop cooldown/],
  ['cooldown',           /^cooldown/],
  ['sup_entry',          /sup_entry/],
  ['direction_conflict', /direction_conflict/],
  ['concurrent_cap',     /concurrent cap/],
  ['slot_reserve',       /slot reserve/],
];
const gateOf = (r) => (GATES.find(([, re]) => re.test(r || '')) || [null])[0];

const _bars = {};
function bars5(sym) {
  if (_bars[sym]) return _bars[sym];
  try {
    _bars[sym] = fs.readFileSync(path.join(BARS, sym + '-5m.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean)
      .map((b) => ({ t: Date.parse(b.t || b.ts), h: +b.h, l: +b.l, c: +b.c }))
      .filter((b) => Number.isFinite(b.t) && b.c > 0).sort((a, b) => a.t - b.t);
  } catch (e) { _bars[sym] = []; }
  return _bars[sym];
}

/**
 * Exit-agnostic path measurement over the next HORIZON_BARS bars. Sliced by bar
 * COUNT, not clock, so an entry late in the session simply runs into the next
 * morning — which is what the live trader does anyway (19/81 real trades were
 * held overnight).
 */
function measure(sym, atMs, nbars) {
  const b = bars5(sym);
  let i = -1;
  for (let k = 0; k < b.length; k++) { if (b[k].t <= atMs) i = k; else break; }
  if (i < 0) return null;
  const entry = b[i].c;
  if (!(entry > 0)) return null;
  const fwd = b.slice(i + 1, i + 1 + nbars);
  if (fwd.length < 2) return null;

  let mfe = 0, mae = 0, touch = null;
  const up = entry * (1 + TOUCH_PCT / 100), dn = entry * (1 - TOUCH_PCT / 100);
  for (const bar of fwd) {
    mfe = Math.max(mfe, ((bar.h - entry) / entry) * 100);
    mae = Math.min(mae, ((bar.l - entry) / entry) * 100);
    if (touch === null) {
      if (bar.l <= dn) touch = 'down';           // pessimistic on a bar spanning both
      else if (bar.h >= up) touch = 'up';
    }
  }
  return { entry, mfe, mae, edge: mfe + mae, touch, bars: fwd.length,
    to_end: ((fwd[fwd.length - 1].c - entry) / entry) * 100 };
}

let rows = [];
try {
  rows = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter((x) => x && x.ts);
} catch (e) {
  console.log('no ledger at ' + LEDGER + '\npoint LANTERN_ROOT at the tree that holds the trading data.');
  process.exit(1);
}
// A silent zero reads as "the analysis ran and found nothing", which is the one
// thing it must never be mistaken for — the live trader and the dev checkout do
// not share a data directory.
if (!rows.some((r) => r.event === 'skip')) {
  console.log('ledger at ' + LEDGER + ' has ' + rows.length + ' rows and no skip events.');
  console.log('this is almost certainly the wrong tree — point LANTERN_ROOT at the one the trader writes to.');
  process.exit(1);
}

const capByDay = {};
for (const r of rows) if (r.event === 'session' && r.date && r.slot_cap) capByDay[r.date] = r.slot_cap;
const timeline = rows.filter((r) => r.event === 'entry' || r.event === 'exit')
  .map((r) => ({ t: Date.parse(r.ts), sym: r.symbol, open: r.event === 'entry' })).sort((a, b) => a.t - b.t);
function openAt(ms) {
  const held = new Set();
  for (const e of timeline) { if (e.t > ms) break; if (e.open) held.add(e.sym); else held.delete(e.sym); }
  return held;
}

// ── vetoed candidates ───────────────────────────────────────────────────────
const seen = new Set();
const vetoed = [];
let collapsed = 0;
for (const r of rows) {
  if (r.event !== 'skip' || r.direction !== 'BULLISH') continue;
  const gate = gateOf(r.reason);
  if (!gate) continue;
  const day = eD(r.ts), key = r.symbol + '|' + day + '|' + gate;
  if (seen.has(key)) { collapsed++; continue; }
  seen.add(key);
  const at = Date.parse(r.ts);
  const held = openAt(at);
  vetoed.push({ gate, sym: r.symbol, day, at, hm: eHM(r.ts), p_win: r.p_win, reason: r.reason,
    m: measure(r.symbol, at, HORIZON_BARS), open_at_fire: held.size,
    cap: capByDay[day] || 5, slot_free: held.size < (capByDay[day] || 5) });
}

// ── control: trades actually taken, same yardstick, known outcome ───────────
const exits = rows.filter((r) => r.event === 'exit' && Number.isFinite(Number(r.pnl)));
const used = new Set();
const taken = [];
for (const e of rows.filter((r) => r.event === 'entry')) {
  const m = measure(e.symbol, Date.parse(e.ts), HORIZON_BARS);
  if (!m) continue;
  const i = exits.findIndex((x, ix) => !used.has(ix) && x.symbol === e.symbol && Date.parse(x.ts) > Date.parse(e.ts));
  let pct = null, pnl = null;
  if (i >= 0) {
    used.add(i);
    const ep = Number(e.entry) || 0, xp = Number(exits[i].exit) || 0;
    if (ep > 0 && xp > 0) pct = ((xp - ep) / ep) * 100;
    pnl = Number(exits[i].pnl);
  }
  taken.push({ sym: e.symbol, day: eD(e.ts), m, pct, pnl });
}

const mean = (a, f) => (a.length ? a.reduce((t, x) => t + f(x), 0) / a.length : NaN);
const V = vetoed.filter((x) => x.m), T = taken.filter((x) => x.m);

console.log('yardstick: MFE/MAE over ' + HORIZON_BARS + ' bars (' + HORIZON_BARS * 5 + ' min), touch band +-' + TOUCH_PCT + '%');
console.log('vetoed ' + V.length + ' candidates (' + collapsed + ' repeat fires collapsed) | taken ' + T.length + '\n');

// ── control ─────────────────────────────────────────────────────────────────
const ctl = T.filter((x) => x.pct != null);
const sp = (a, f, g) => {
  const n = a.length;
  const rk = (h) => { const s = [...a].sort((x, y) => h(x) - h(y)); const m = new Map(); s.forEach((v, i) => m.set(v, i + 1)); return m; };
  const r1 = rk(f), r2 = rk(g);
  let d = 0; for (const x of a) d += Math.pow(r1.get(x) - r2.get(x), 2);
  return 1 - (6 * d) / (n * (n * n - 1));
};
const rho = sp(ctl, (x) => x.m.edge, (x) => x.pct);
console.log('CONTROL — does `edge` track the real outcome on the ' + ctl.length + ' trades we know?');
console.log('  Spearman rho(edge, real % return) = ' + rho.toFixed(3) + '   ' +
  (Math.abs(rho) > 0.4 ? 'USABLE — conclusions below are supported'
   : Math.abs(rho) > 0.25 ? 'weak — directional only' : 'NO RESOLUTION — do not read the numbers below'));

// ── taken vs vetoed ─────────────────────────────────────────────────────────
const line = (lab, a) => console.log('  ' + lab.padEnd(22) + String(a.length).padStart(4) +
  mean(a, (x) => x.m.mfe).toFixed(2).padStart(9) + mean(a, (x) => x.m.mae).toFixed(2).padStart(9) +
  mean(a, (x) => x.m.edge).toFixed(3).padStart(9) +
  ((100 * a.filter((x) => x.m.touch === 'up').length / a.length).toFixed(0) + '%').padStart(10));
console.log('\nTAKEN vs VETOED');
console.log('  set                      n      MFE      MAE     edge  up-first');
line('TAKEN (control)', T);
line('VETOED (all gates)', V);

console.log('\nPER GATE  (n<10 is noise, not a result)');
const gates = [...new Set(V.map((c) => c.gate))]
  .sort((a, b) => V.filter((c) => c.gate === b).length - V.filter((c) => c.gate === a).length);
for (const g of gates) line(g + (V.filter((c) => c.gate === g).length < 10 ? ' *' : ''), V.filter((c) => c.gate === g));

// ── permutation test ────────────────────────────────────────────────────────
function permTest(A, B, iter = 20000) {
  const obs = mean(A, (x) => x.m.edge) - mean(B, (x) => x.m.edge);
  const pool = [...A, ...B].map((x) => x.m.edge);
  let s = 12345;
  const rnd = () => (s = (1103515245 * s + 12345) % 2147483648) / 2147483648;
  let ge = 0;
  for (let it = 0; it < iter; it++) {
    const p = [...pool];
    for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
    const a = p.slice(0, A.length), b = p.slice(A.length);
    const d = a.reduce((t, x) => t + x, 0) / a.length - b.reduce((t, x) => t + x, 0) / b.length;
    if (Math.abs(d) >= Math.abs(obs)) ge++;
  }
  return { obs, p: ge / iter };
}
const pt = permTest(T, V);
console.log('\nIS THE TAKEN-vs-VETOED GAP REAL?');
console.log('  observed edge gap = ' + pt.obs.toFixed(3) + ' pct-points   permutation p = ' + pt.p.toFixed(4));
console.log('  ' + (pt.p < 0.05 ? 'SIGNIFICANT — the gate stack as a whole selects better setups than it blocks.'
  : 'NOT SIGNIFICANT — the gate stack does not demonstrably separate good setups from bad.'));

console.log('\nPER-GATE vs TAKEN (which gates earn their place?)');
console.log('  gate                    n   edge gap        p');
for (const g of gates) {
  const a = V.filter((c) => c.gate === g);
  if (a.length < 10) { console.log('  ' + g.padEnd(20) + String(a.length).padStart(4) + '        (n too small)'); continue; }
  const r = permTest(T, a, 5000);
  console.log('  ' + g.padEnd(20) + String(a.length).padStart(4) + r.obs.toFixed(3).padStart(11) +
    r.p.toFixed(4).padStart(9) + (r.p < 0.05 ? '  <- blocks materially worse setups' : ''));
}

fs.writeFileSync(OUT, JSON.stringify(vetoed, null, 1));
console.log('\nwrote ' + vetoed.length + ' candidates -> ' + OUT + '  (arbiter-stage input)');
