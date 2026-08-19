'use strict';
/**
 * haiku_analyst_replay.js — replay recorded entries through the analyst OFFLINE,
 * before it is allowed near a live decision (#3355).
 *
 * Asks the only question that matters: on trades whose OUTCOME we already know,
 * does the analyst's conviction separate winners from losers? If conviction is
 * uncorrelated with what happened next, the 9% slot earns nothing and should stay
 * at neutral.
 *
 *   node experiments/haiku_analyst_replay.js            # dry run, no API calls
 *   TRADER_HAIKU_ANALYST=1 node experiments/haiku_analyst_replay.js   # real calls
 *
 * LIMIT=n to cap calls (default 25) — this spends money, so it is opt-in and bounded.
 */
const fs = require('fs');
const path = require('path');
const analyst = require('../apps/lantern-garage/lib/signal-engine/haiku-analyst');
const dl = require('../apps/lantern-garage/lib/direction-lock');

const LEDGER = process.env.TRADER_TRADES_LOG
  || 'C:/dev/lantern-os-stable/data/lantern-garage/trading/autopilot-trades.jsonl';
const LIMIT = Number(process.env.LIMIT) || 25;
const etDay = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const etTime = (t) => new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });

function load() {
  const rows = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  const entries = rows.filter((r) => r.event === 'entry');
  const exits = rows.filter((r) => r.event === 'exit');
  const used = new Set();
  const out = [];
  for (const e of entries) {
    const i = exits.findIndex((x, ix) => !used.has(ix) && x.symbol === e.symbol && Date.parse(x.ts) > Date.parse(e.ts));
    if (i < 0) continue;
    used.add(i);
    out.push({ e, x: exits[i] });
  }
  return out;
}

(async () => {
  const pairs = load();
  console.log(`recorded round trips available: ${pairs.length}`);
  if (!analyst.enabled()) {
    console.log('\nDRY RUN (TRADER_HAIKU_ANALYST is not 1) — no API calls made.');
    console.log('Showing the prompt the analyst WOULD see for the most recent fire:\n');
    const { e } = pairs[pairs.length - 1];
    const s = dl.instrumentSign(e.symbol);
    console.log(analyst.buildPrompt({
      symbol: e.symbol, direction: 'BULLISH', price: e.entry, stop: e.stop, target: e.target1,
      p_win: e.p_win, ibs: null, underlying: dl.underlyingProxy(e.symbol),
      underlying_tape: null, spy_tape: e.spy_1d, regime: null, volume_ratio: e.vol_ratio,
      et_time: etTime(e.ts), sign: s.sign, leverage: dl.leverageOf(e.symbol), family: s.family,
    }).split('\n').map((l) => '  | ' + l).join('\n'));
    console.log('\nRe-run with TRADER_HAIKU_ANALYST=1 to score them for real.');
    return;
  }

  const sample = pairs.slice(-LIMIT);
  console.log(`scoring the most recent ${sample.length} (LIMIT=${LIMIT})\n`);
  const scored = [];
  for (const { e, x } of sample) {
    const s = dl.instrumentSign(e.symbol);
    const r = await analyst.analyze({
      symbol: e.symbol, direction: 'BULLISH', price: e.entry, stop: e.stop, target: e.target1,
      p_win: e.p_win, ibs: null, underlying: dl.underlyingProxy(e.symbol),
      underlying_tape: null, spy_tape: e.spy_1d, regime: null, volume_ratio: e.vol_ratio,
      et_time: etTime(e.ts), sign: s.sign, leverage: dl.leverageOf(e.symbol), family: s.family,
    });
    const pnl = Number(x.pnl) || 0;
    scored.push({ sym: e.symbol, day: etDay(e.ts), at: etTime(e.ts), conv: r.conviction, degraded: r.degraded, reason: r.reason, pnl });
    console.log(`  ${etDay(e.ts)} ${e.symbol.padEnd(5)} ${etTime(e.ts)}  conviction ${String(r.conviction).padStart(3)}  ${(pnl >= 0 ? '+' : '') + pnl.toFixed(0)}`.padEnd(64) + (r.reason || ''));
  }

  const ok = scored.filter((s) => !s.degraded);
  if (ok.length < 4) { console.log('\nnot enough successful calls to judge'); return; }
  const hi = ok.filter((s) => s.conv > 55), lo = ok.filter((s) => s.conv < 45), mid = ok.filter((s) => s.conv >= 45 && s.conv <= 55);
  const agg = (a) => a.length ? { n: a.length, wr: (100 * a.filter((x) => x.pnl > 0).length / a.length).toFixed(0), tot: a.reduce((t, x) => t + x.pnl, 0).toFixed(0), avg: (a.reduce((t, x) => t + x.pnl, 0) / a.length).toFixed(0) } : null;
  console.log('\nDOES CONVICTION SEPARATE OUTCOMES?');
  console.log('  bucket              n    WR      total     avg');
  for (const [lab, a] of [['conviction > 55', hi], ['45-55 (no view)', mid], ['conviction < 45', lo]]) {
    const g = agg(a);
    console.log('  ' + lab.padEnd(20) + (g ? String(g.n).padStart(2) + String(g.wr + '%').padStart(7) + String(g.tot).padStart(10) + String(g.avg).padStart(9) : '   —'));
  }
  // rank correlation between conviction and P&L
  const n = ok.length;
  const rank = (key) => { const s2 = [...ok].sort((a, b) => a[key] - b[key]); const m = new Map(); s2.forEach((v, i) => m.set(v, i + 1)); return m; };
  const rc = rank('conv'), rp = rank('pnl');
  let d2 = 0; for (const v of ok) d2 += (rc.get(v) - rp.get(v)) ** 2;
  const rho = 1 - (6 * d2) / (n * (n * n - 1));
  console.log(`\n  Spearman rho(conviction, pnl) = ${rho.toFixed(3)}   n=${n}`);
  console.log('  rho near 0 => the analyst adds nothing and the weight should stay neutral.');
})();
