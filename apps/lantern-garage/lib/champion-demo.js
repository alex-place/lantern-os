'use strict';

/**
 * champion-demo.js — a simulated brokerage snapshot for the dashboard PREVIEW,
 * modeled on "the champion" DCA strategy (docs/investing-2k-plan.html):
 *
 *   $2,000 + $20/mo since 2000-01 into a momentum-tilted 8-asset mix, gross-scaled
 *   to a 35% vol cap with a streaming brake-to-cash → measured $91,843 today
 *   (12.6%/yr, maxDD −25%, Sharpe 0.65) vs $54,603 for SPY buy-and-hold DCA.
 *
 * READ-ONLY, SIMULATED, and clearly labeled: every account it returns is
 * `mode:'paper'` + `demo:true`. Nothing here touches a real broker, places an
 * order, or reads a user's linked account — it is a fixture the positions /
 * portfolio-history endpoints serve ONLY when the request carries `?demo=champion`,
 * so the Explore dashboard can be shown fully populated without a connected account.
 *
 * All figures are deterministic (a seeded LCG), so repeated polls render an
 * identical curve — the chart never jitters between refreshes.
 */

// Measured champion terminal equity (docs/investing-2k-plan-collapse-certificate.md).
const EQUITY = 91843;
const CASH_BUFFER = 1843;              // parked in T-bills; the rest is invested
const INVESTED = EQUITY - CASH_BUFFER;
const PAID_IN = 8380;                  // $2,000 + 319×$20 contributed since 2000

// Current allocation snapshot (top weights from the plan's allocation bar; the
// remainder spread across the rest of the 8-asset momentum universe).
const HOLDINGS = [
  { symbol: 'SPY',  name: 'S&P 500',            weight: 0.34, price: 743.29, gain: 0.086, day:  0.42 },
  { symbol: 'TLT',  name: '20+ Yr Treasuries',  weight: 0.21, price: 88.10,  gain: -0.041, day: -0.31 },
  { symbol: 'QQQ',  name: 'Nasdaq-100',         weight: 0.15, price: 641.55, gain: 0.121, day:  0.77 },
  { symbol: 'GLD',  name: 'Gold',               weight: 0.14, price: 381.20, gain: 0.193, day:  0.55 },
  { symbol: 'XMMO', name: 'S&P MidCap Momentum',weight: 0.06, price: 118.40, gain: 0.152, day:  0.63 },
  { symbol: 'SPMO', name: 'S&P 500 Momentum',   weight: 0.05, price: 121.75, gain: 0.164, day:  0.71 },
  { symbol: 'IWM',  name: 'Russell 2000',       weight: 0.03, price: 244.90, gain: 0.058, day: -0.12 },
  { symbol: 'EFA',  name: 'EAFE Intl',          weight: 0.02, price: 92.35,  gain: 0.074, day:  0.19 },
];

// Approximate cumulative range returns (fraction) used to place each range's
// baseline: base_value = equity / (1 + rangeReturn). ALL starts from the initial
// $2,000 stake, so its baseline is the paid-in seed, not a return multiple.
const RANGE_RETURN = { '1D': null, '1W': 0.012, '1M': 0.026, '3M': 0.061, 'YTD': 0.094, '1Y': 0.142 };

// Points + spacing per range for the equity curve.
const RANGE_SHAPE = {
  '1D':  { points: 78,  stepMs: 5 * 60 * 1000 },        // 5-min bars over a session
  '1W':  { points: 35,  stepMs: 60 * 60 * 1000 * 5 },   // ~hourly across a week of sessions
  '1M':  { points: 22,  stepMs: 24 * 60 * 60 * 1000 },  // daily
  '3M':  { points: 64,  stepMs: 24 * 60 * 60 * 1000 },
  'YTD': { points: 140, stepMs: 24 * 60 * 60 * 1000 },
  '1Y':  { points: 252, stepMs: 24 * 60 * 60 * 1000 },
  'ALL': { points: 312, stepMs: 30 * 24 * 60 * 60 * 1000 }, // monthly since 2000
};

/** Deterministic [0,1) generator (mulberry32) — stable curve across polls. */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simulated positions + account. Marked paper + demo; never a real broker.
 *
 * MARKED TO LIVE QUOTES (user report 2026-07-28: "the same numbers for days"):
 * the holdings/quantities/cost bases stay the deterministic fixture, but
 * current prices come from the keyless quote feed, so the demo book moves with
 * the actual market — exactly like a real account whose owner stopped trading.
 * `quotesBySym` maps SYM → { price, chg_pct }; symbols the feed missed fall
 * back to the baked snapshot price (stale but never blank), and the account
 * reports which mode it's in via `marked_to_market`.
 */
function positions(quotesBySym = null) {
  let liveCount = 0;
  const positions = HOLDINGS.map((h) => {
    const q = quotesBySym && quotesBySym[h.symbol];
    const live = q && Number(q.price) > 0 ? Number(q.price) : null;
    if (live) liveCount++;
    const px = live || h.price;
    const dayPct = live && Number.isFinite(Number(q.chg_pct)) ? Number(q.chg_pct) : h.day;
    // Quantities derive from the BAKED snapshot so the book composition is
    // stable; only the marks move.
    const targetMv = INVESTED * h.weight;
    const qty = Math.max(1, Math.round(targetMv / h.price));
    const marketValue = qty * px;
    const avg = h.price / (1 + h.gain);                 // cost basis implied by the snapshot gain
    const unrealized = (px - avg) * qty;
    return {
      symbol: h.symbol,
      qty,
      side: 'long',
      avg_entry_price: Math.round(avg * 100) / 100,
      current_price: Math.round(px * 100) / 100,
      market_value: Math.round(marketValue * 100) / 100,
      unrealized_pl: Math.round(unrealized * 100) / 100,
      pnl_pct: avg > 0 ? Math.round(((px - avg) / avg) * 10000) / 100 : 0,
      day_pct: Math.round(dayPct * 100) / 100,
    };
  });
  const invested = positions.reduce((s, p) => s + p.market_value, 0);
  const unrealized = positions.reduce((s, p) => s + p.unrealized_pl, 0);
  // Day P&L = Σ qty × price × dayChg%.
  const dayPnl = positions.reduce((s, p) => s + p.market_value * (p.day_pct / 100), 0);
  const equity = Math.round((invested + CASH_BUFFER) * 100) / 100;
  const account = {
    account_id: 'CHAMPION-DEMO',
    equity,
    cash: CASH_BUFFER,
    buying_power: CASH_BUFFER,
    unrealized: Math.round(unrealized * 100) / 100,
    realized_today: 0,
    pnl_today: Math.round(dayPnl * 100) / 100,
    pnl_pct: equity ? Math.round((dayPnl / equity) * 10000) / 100 : 0,
    mode: 'demo',                          // a simulated showroom account, not paper/live
    source: 'champion-demo',
    demo: true,
    simulated: true,                       // explicit flag the UI banner keys off
    marked_to_market: liveCount > 0,       // false → serving the stale baked snapshot
    live_quotes: liveCount,
    paid_in: PAID_IN,
  };
  return { positions, account, demo: true, simulated: true, source: 'champion-demo' };
}

/**
 * positions() marked to the live keyless quote feed. Fail-soft: any feed error
 * returns the baked snapshot (marked_to_market:false) — the demo must render
 * even when quotes are down, it just stops claiming to be live.
 */
async function positionsLive() {
  try {
    const yahoo = require('./market-data-yahoo');
    const quotes = await yahoo.getQuotes(HOLDINGS.map((h) => h.symbol));
    const bySym = {};
    for (const q of quotes || []) if (q && q.ticker) bySym[q.ticker] = q;
    return positions(bySym);
  } catch (_e) {
    return positions(null);
  }
}

/** Simulated equity curve for a range (1D/1W/1M/3M/YTD/1Y/ALL). */
function history(range = '1D') {
  const r = String(range).toUpperCase();
  const shape = RANGE_SHAPE[r] || RANGE_SHAPE['1D'];
  const acct = positions().account;
  const equity = acct.equity;

  let base;
  if (r === '1D') base = equity - acct.pnl_today;
  else if (r === 'ALL') base = PAID_IN - (312 - 1) * 20; // ~the initial $2,000 stake
  else base = equity / (1 + (RANGE_RETURN[r] || 0.03));

  const n = shape.points;
  const now = Date.now();
  const rand = rng(0x0C0FFEE ^ (r.charCodeAt(0) * 131 + n)); // per-range seed

  // Random-walk increments, then affine-map so path[0]=base and path[n-1]=equity.
  const raw = [0];
  for (let i = 1; i < n; i++) raw.push(raw[i - 1] + (rand() - 0.44)); // slight upward drift
  const lo = raw[0], hi = raw[n - 1] || 1;
  const timestamps = [];
  const eq = [];
  for (let i = 0; i < n; i++) {
    const frac = (raw[i] - lo) / (hi - lo || 1);
    const wobble = (rand() - 0.5) * (equity - base) * 0.04;      // small texture
    let v = base + (equity - base) * frac + wobble;
    if (i === 0) v = base;
    if (i === n - 1) v = equity;                                  // land exactly on today
    eq.push(Math.round(Math.max(v, base * 0.85) * 100) / 100);
    timestamps.push(Math.round((now - (n - 1 - i) * shape.stepMs) / 1000));
  }
  return {
    ok: true, range: r, timeframe: r === '1D' ? '5Min' : (r === 'ALL' ? '1Mo' : '1D'),
    base_value: Math.round(base * 100) / 100,
    timestamps, equity: eq, source: 'champion-demo', demo: true,
  };
}

module.exports = { positions, positionsLive, history, EQUITY, HOLDINGS };
