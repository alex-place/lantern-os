// replay-enriched.js — the analyst replay, with the context RECONSTRUCTED.
//
// The first replay fed the analyst what the ledger stores, which is entry price,
// stop, p_win and spy_1d — and nothing else. IBS, MACD, regime, sector and the
// underlying's tape all arrived as "n/a", so the model correctly answered "I
// can't see enough to have a view" 25 times running: every conviction landed in
// 35-42, no variance, and the resulting rho was noise on a dead input.
//
// The 5m bar cache has 100% coverage for every symbol on every replay date, so
// the same fields the LIVE path computes can be rebuilt at each fire's exact
// timestamp. Same functions the engine uses (sessionIbs, sessionDrawdownPct,
// barEtMinute from scan.js; macd from indicators.js), sliced to bars available
// AT the fire — nothing after it, so there is no look-ahead.
const fs = require('fs');
const path = require('path');

const ROOT = process.env.LANTERN_ROOT || path.join(__dirname, '..');
const BARS = path.join(ROOT, 'data/lantern-garage/trading/bars');
const LEDGER = path.join(ROOT, 'data/lantern-garage/trading/autopilot-trades.jsonl');

const analyst = require(path.join(ROOT, 'apps/lantern-garage/lib/signal-engine/haiku-analyst'));
const dl = require(path.join(ROOT, 'apps/lantern-garage/lib/direction-lock'));
const scan = require(path.join(ROOT, 'apps/lantern-garage/lib/signal-engine/scan'));
const { macd } = require(path.join(ROOT, 'apps/lantern-garage/lib/signal-engine/indicators'));

const LIMIT = Number(process.env.LIMIT) || 25;
const eD = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const etTime = (t) => new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });

// ── bars, in the shape the engine's helpers expect ──────────────────────────
const barCache = {};
function bars5(sym) {
  if (barCache[sym]) return barCache[sym];
  try {
    barCache[sym] = fs.readFileSync(path.join(BARS, sym + '-5m.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean)
      .map((b) => ({ timestamp: b.t || b.ts, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }))
      .filter((b) => b.timestamp && b.close > 0)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  } catch (e) { barCache[sym] = []; }
  return barCache[sym];
}
// 5m -> 15m, and ONLY bars at or before the fire instant (no look-ahead)
function upTo(sym, day, atMs) {
  const s = bars5(sym).filter((b) => eD(b.timestamp) === day && Date.parse(b.timestamp) <= atMs);
  const out = [];
  for (let i = 0; i < s.length; i += 3) {
    const g = s.slice(i, i + 3);
    if (!g.length) break;
    out.push({
      timestamp: g[0].timestamp, open: g[0].open,
      high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)),
      close: g[g.length - 1].close,
    });
  }
  return out;
}

// ── pair entries to exits ───────────────────────────────────────────────────
const rows = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
const entries = rows.filter((r) => r.event === 'entry');
const exits = rows.filter((r) => r.event === 'exit');
const used = new Set();
const pairs = [];
for (const e of entries) {
  const i = exits.findIndex((x, ix) => !used.has(ix) && x.symbol === e.symbol && Date.parse(x.ts) > Date.parse(e.ts));
  if (i < 0) continue;
  used.add(i);
  pairs.push({ e, x: exits[i] });
}

(async () => {
  const sample = pairs.slice(-LIMIT);
  console.log(`recorded round trips: ${pairs.length}; scoring the most recent ${sample.length} WITH reconstructed context\n`);

  const scored = [];
  for (const { e, x } of sample) {
    const day = eD(e.ts), at = Date.parse(e.ts);
    const sign = dl.instrumentSign(e.symbol);
    const proxy = dl.underlyingProxy(e.symbol);

    const own15 = upTo(e.symbol, day, at);
    const u15 = proxy && proxy !== e.symbol ? upTo(proxy, day, at) : null;
    const spy15 = upTo('SPY', day, at);

    // MACD histogram on the symbol's own closes, prior sessions + today up to the fire
    const priorCloses = bars5(e.symbol).filter((b) => eD(b.timestamp) < day && Date.parse(b.timestamp) > at - 5 * 864e5).map((b) => b.close);
    const closes = priorCloses.concat(own15.map((b) => b.close));
    let mh = null;
    try { const m = macd(closes); mh = m && Number.isFinite(m.histogram) ? m.histogram : null; } catch (_e) {}

    const spyTape = spy15.length ? scan.sessionDrawdownPct(spy15) : null;
    const regime = spyTape == null ? null : (spyTape > 0.25 ? 'BULLISH' : spyTape < -0.25 ? 'BEARISH' : 'NEUTRAL');

    const sig = {
      symbol: e.symbol, direction: 'BULLISH', price: e.entry, stop: e.stop, target: e.target1,
      p_win: e.p_win, ev_r: null,
      ibs: own15.length ? scan.sessionIbs(own15) : null,
      underlying: proxy,
      underlying_tape: u15 && u15.length ? scan.sessionDrawdownPct(u15) : null,
      spy_tape: spyTape,
      spy_mom30: (() => {
        if (spy15.length < 3) return null;
        const a = spy15[spy15.length - 3].close, b = spy15[spy15.length - 1].close;
        return a > 0 ? ((b - a) / a) * 100 : null;
      })(),
      regime, volume_ratio: e.vol_ratio, macd_hist: mh,
      news_sentiment: null, sector_trend: null,
      in_zone: Array.isArray(e.zones) ? e.zones.length > 0 : false,
      et_time: etTime(e.ts), sign: sign.sign, leverage: dl.leverageOf(e.symbol), family: sign.family,
    };

    const filled = ['ibs', 'underlying_tape', 'spy_tape', 'spy_mom30', 'regime', 'macd_hist'].filter((k) => sig[k] != null).length;
    const r = await analyst.analyze(sig);
    const pnl = Number(x.pnl) || 0;
    scored.push({ sym: e.symbol, day, conv: r.conviction, degraded: r.degraded, reason: r.reason, pnl, filled });
    console.log(`  ${day} ${e.symbol.padEnd(5)} ${etTime(e.ts)}  ctx ${filled}/6  conviction ${String(r.conviction).padStart(3)}  ${(pnl >= 0 ? '+' : '') + pnl.toFixed(0)}`.padEnd(72) + (r.reason || ''));
  }

  const ok = scored.filter((s) => !s.degraded);
  console.log(`\ncontext filled: ${(scored.reduce((t, s) => t + s.filled, 0) / scored.length).toFixed(1)}/6 average (was 0/6)`);
  const cs = ok.map((s) => s.conv);
  console.log(`conviction range: ${Math.min(...cs)}-${Math.max(...cs)}  (was 35-42, no spread)`);

  const agg = (a) => a.length ? { n: a.length, wr: (100 * a.filter((x) => x.pnl > 0).length / a.length).toFixed(0), tot: a.reduce((t, x) => t + x.pnl, 0).toFixed(0), avg: (a.reduce((t, x) => t + x.pnl, 0) / a.length).toFixed(0) } : null;
  console.log('\nDOES CONVICTION SEPARATE OUTCOMES?');
  console.log('  bucket              n    WR      total     avg');
  for (const [lab, f] of [['conviction > 55', (s) => s.conv > 55], ['45-55 (no view)', (s) => s.conv >= 45 && s.conv <= 55], ['conviction < 45', (s) => s.conv < 45]]) {
    const g = agg(ok.filter(f));
    console.log('  ' + lab.padEnd(20) + (g ? String(g.n).padStart(2) + String(g.wr + '%').padStart(7) + String(g.tot).padStart(10) + String(g.avg).padStart(9) : '   —'));
  }

  if (ok.length >= 4 && new Set(cs).size > 1) {
    const n = ok.length;
    const rank = (key) => { const s2 = [...ok].sort((a, b) => a[key] - b[key]); const m = new Map(); s2.forEach((v, i) => m.set(v, i + 1)); return m; };
    const rc = rank('conv'), rp = rank('pnl');
    let d2 = 0; for (const v of ok) d2 += (rc.get(v) - rp.get(v)) ** 2;
    const rho = 1 - (6 * d2) / (n * (n * n - 1));
    console.log(`\n  Spearman rho(conviction, pnl) = ${rho.toFixed(3)}   n=${n}`);
    console.log('  |rho| < ~0.4 at this n is not distinguishable from chance.');
  } else {
    console.log('\n  conviction has no spread — still not a decidable test.');
  }
})();
