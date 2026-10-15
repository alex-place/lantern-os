'use strict';

/**
 * economy.js — the US economy page (/market.html?c=economy, 2026-10-11): inflation, jobs,
 * growth and rates in their official numbers, and the Treasury yield curve.
 *
 * WHERE THE NUMBERS COME FROM. FRED, the St. Louis Fed's data service (lib/fred), which
 * republishes each agency's release — BLS for prices and jobs, BEA for GDP and PCE, the
 * Treasury for yields. Every figure is DATED: an inflation number is as of its month, a
 * GDP number as of its quarter, and the page prints that date beside it rather than
 * letting "3.4%" read as today's. A transformed figure (CPI year on year, payrolls added
 * in the month) is FRED's own transformation, not one recomputed here.
 *
 * WHAT IT IS NOT. TradingView's economy page is global, with an economic calendar. This is
 * the United States only, and there is no calendar: there is no keyless source for one,
 * and a calendar with invented dates would be worse than none.
 *
 * Six small requests per refresh (cached three hours in lib/fred), one per native
 * frequency: FRED joins series into one CSV only when they share one, and otherwise sends
 * a ZIP. Monthly; quarterly (GDP); each weekly series on its own (claims weeks end on a
 * Saturday, the mortgage survey's on a Thursday); the seven-day Fed series; and the
 * business-day Treasury series with the whole curve.
 */

const fred = require('./fred');

const GROUPS = [
  { id: 'inflation', title: 'Inflation' },
  { id: 'jobs', title: 'Jobs' },
  { id: 'growth', title: 'Growth' },
  { id: 'rates', title: 'Rates' },
];

// freq: m monthly, q quarterly, w weekly, d daily — it picks the request and how a date
// reads on the page. tr: FRED's transformation (lin as published, pc1 % change from a year
// earlier, pch % change from the previous period, chg change from the previous period).
// scale turns FRED's unit into the one shown (claims in thousands, the trade balance in $B).
const INDICATORS = [
  { id: 'cpi', series: 'CPIAUCSL', tr: 'pc1', freq: 'm', group: 'inflation', name: 'Inflation (CPI)',
    note: 'consumer prices against a year earlier', unit: '% y/y', dec: 1, source: 'Bureau of Labor Statistics' },
  { id: 'core-cpi', series: 'CPILFESL', tr: 'pc1', freq: 'm', group: 'inflation', name: 'Core CPI',
    note: 'excluding food and energy', unit: '% y/y', dec: 1, source: 'Bureau of Labor Statistics' },
  { id: 'core-pce', series: 'PCEPILFE', tr: 'pc1', freq: 'm', group: 'inflation', name: 'Core PCE prices',
    note: 'the Fed’s preferred inflation gauge', unit: '% y/y', dec: 1, source: 'Bureau of Economic Analysis' },
  { id: 'unemployment', series: 'UNRATE', tr: 'lin', freq: 'm', group: 'jobs', name: 'Unemployment rate',
    note: 'share of the labour force without a job', unit: '%', dec: 1, source: 'Bureau of Labor Statistics' },
  { id: 'payrolls', series: 'PAYEMS', tr: 'chg', freq: 'm', group: 'jobs', name: 'Nonfarm payrolls',
    note: 'jobs added in the month, thousands', unit: 'K', dec: 0, source: 'Bureau of Labor Statistics' },
  { id: 'claims', series: 'ICSA', tr: 'lin', freq: 'w', group: 'jobs', name: 'Initial jobless claims',
    note: 'new claims in the week, thousands', unit: 'K', scale: 0.001, dec: 0, source: 'Department of Labor' },
  { id: 'gdp', series: 'A191RL1Q225SBEA', tr: 'lin', freq: 'q', group: 'growth', name: 'Real GDP growth',
    note: 'quarter on quarter, at an annual rate', unit: '%', dec: 1, source: 'Bureau of Economic Analysis' },
  { id: 'industrial', series: 'INDPRO', tr: 'pc1', freq: 'm', group: 'growth', name: 'Industrial production',
    note: 'output of factories, mines and utilities', unit: '% y/y', dec: 1, source: 'Federal Reserve' },
  { id: 'retail', series: 'RSAFS', tr: 'pch', freq: 'm', group: 'growth', name: 'Retail sales',
    note: 'against the month before', unit: '% m/m', dec: 1, source: 'Census Bureau' },
  { id: 'housing', series: 'HOUST', tr: 'lin', freq: 'm', group: 'growth', name: 'Housing starts',
    note: 'new homes begun, thousands at an annual rate', unit: 'K', dec: 0, source: 'Census Bureau' },
  { id: 'sentiment', series: 'UMCSENT', tr: 'lin', freq: 'm', group: 'growth', name: 'Consumer sentiment',
    note: 'University of Michigan index, 1966 = 100', unit: '', dec: 1, source: 'University of Michigan' },
  { id: 'trade', series: 'BOPGSTB', tr: 'lin', freq: 'm', group: 'growth', name: 'Trade balance',
    note: 'goods and services in the month, billions', unit: '$B', scale: 0.001, dec: 1, source: 'Census Bureau and BEA' },
  { id: 'fed-target', series: 'DFEDTARU', lower: 'DFEDTARL', tr: 'lin', freq: 'd', days7: true, group: 'rates', name: 'Fed funds target',
    note: 'the range the Federal Reserve sets', unit: '%', dec: 2, source: 'Federal Reserve' },
  { id: 'effr', series: 'DFF', tr: 'lin', freq: 'd', days7: true, group: 'rates', name: 'Effective fed funds rate',
    note: 'what banks actually paid overnight', unit: '%', dec: 2, source: 'Federal Reserve Bank of New York' },
  { id: 'us2y', series: 'DGS2', tr: 'lin', freq: 'd', group: 'rates', name: '2-year Treasury yield',
    unit: '%', dec: 2, source: 'US Treasury' },
  { id: 'us10y', series: 'DGS10', tr: 'lin', freq: 'd', group: 'rates', name: '10-year Treasury yield',
    unit: '%', dec: 2, source: 'US Treasury' },
  { id: 'spread', series: 'T10Y2Y', tr: 'lin', freq: 'd', group: 'rates', name: '10-year minus 2-year',
    note: 'below zero, the yield curve is inverted', unit: 'pp', dec: 2, source: 'Federal Reserve Bank of St. Louis' },
  { id: 'mortgage', series: 'MORTGAGE30US', tr: 'lin', freq: 'w', group: 'rates', name: '30-year mortgage rate',
    note: 'average fixed rate, weekly survey', unit: '%', dec: 2, source: 'Freddie Mac' },
];

// The figures the overview leads with — TradingView's "economic trends" strip.
const KEY = ['cpi', 'core-pce', 'unemployment', 'payrolls', 'fed-target', 'us10y', 'gdp', 'sentiment'];

const CURVE = [
  ['DGS1MO', '1M'], ['DGS3MO', '3M'], ['DGS6MO', '6M'], ['DGS1', '1Y'], ['DGS2', '2Y'], ['DGS3', '3Y'],
  ['DGS5', '5Y'], ['DGS7', '7Y'], ['DGS10', '10Y'], ['DGS20', '20Y'], ['DGS30', '30Y'],
];

function ymd(ms) { return new Date(ms).toISOString().slice(0, 10); }
function round(n, d) { if (n == null || !Number.isFinite(n)) return null; const f = 10 ** d; return Math.round(n * f) / f; }

/** The last observation at or before `date` (YYYY-MM-DD strings sort as dates). */
function at(pts, date) {
  let best = null;
  for (const p of pts || []) { if (p[0] <= date) best = p; else break; }
  return best;
}
function monthsBefore(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - n);
  return ymd(d.getTime());
}

/** The requests, one per native frequency — see the header for why. */
function batches(now = Date.now()) {
  const yearsAgo = (n) => ymd(now - n * 365.25 * 86400e3);
  const of = (list, since) => ({ ids: list.map((i) => i.series), transforms: list.map((i) => i.tr), since });
  const out = [
    of(INDICATORS.filter((i) => i.freq === 'm'), yearsAgo(6)),
    of(INDICATORS.filter((i) => i.freq === 'q'), yearsAgo(8)),
  ];
  for (const w of INDICATORS.filter((i) => i.freq === 'w')) out.push(of([w], yearsAgo(3)));
  const fed = INDICATORS.filter((i) => i.freq === 'd' && i.days7);
  out.push({ ids: [].concat(...fed.map((i) => (i.lower ? [i.series, i.lower] : [i.series]))), since: yearsAgo(2) });
  const treasury = INDICATORS.filter((i) => i.freq === 'd' && !i.days7).map((i) => i.series);
  out.push({ ids: [...new Set(treasury.concat(CURVE.map((c) => c[0])))], since: yearsAgo(2) });
  return out.filter((b) => b.ids.length);
}

async function load() {
  const parts = await Promise.all(batches().map((b) => fred.series(b.ids, { since: b.since, transforms: b.transforms })));
  return { data: Object.assign({}, ...parts.filter(Boolean)), answered: parts.filter(Boolean).length, asked: parts.length };
}

/** One indicator, ready for the page: its latest reading and date, the one it is compared
 *  with, the reading a year earlier, and a thinned history for its chart. */
function shape(ind, data) {
  const k = ind.scale || 1;
  const pts = (data[ind.series] || []).map(([dt, v]) => [dt, round(v * k, ind.dec + 2)]);
  const base = {
    id: ind.id, name: ind.name, note: ind.note || null, unit: ind.unit, group: ind.group, freq: ind.freq,
    dec: ind.dec, source: ind.source, series: ind.series, href: 'https://fred.stlouisfed.org/series/' + ind.series,
  };
  if (!pts.length) return { ...base, latest: null, prior: null, yearAgo: null, lower: null, history: [] };
  const last = pts[pts.length - 1];
  // A daily rate is compared with a month earlier: yesterday's fed funds target is today's.
  const prior = ind.freq === 'd' ? at(pts, monthsBefore(last[0], 1)) : (pts.length > 1 ? pts[pts.length - 2] : null);
  const yearAgo = at(pts, monthsBefore(last[0], 12));
  // A range (the fed funds target) carries its lower bound on each date it is shown for.
  const lowerAt = (p) => { if (!ind.lower || !p) return null; const l = at(data[ind.lower], p[0]); return l ? l[1] : null; };
  const lower = lowerAt(last);
  // A daily series is thinned to one point a week for its chart; the latest point is kept.
  const history = ind.freq === 'd'
    ? pts.filter((_, i) => i % 5 === (pts.length - 1) % 5)
    : pts;
  const pt = (p) => (p ? { date: p[0], value: p[1], ...(ind.lower ? { lower: lowerAt(p) } : {}) } : null);
  return { ...base, latest: pt(last), prior: pt(prior), yearAgo: pt(yearAgo), lower, history };
}

/** The Treasury curve on its latest date, a month earlier and a year earlier — each on a
 *  real trading day of the 10-year, so every tenor of a line shares one date. */
function curveOf(data) {
  const ten = data.DGS10 || [];
  if (!ten.length) return null;
  const d0 = ten[ten.length - 1][0];
  const line = (label, p) => (p ? {
    label, date: p[0],
    values: CURVE.map(([id]) => { const v = at(data[id], p[0]); return v ? v[1] : null; }),
  } : null);
  return {
    tenors: CURVE.map((c) => c[1]),
    lines: [line('Latest', ten[ten.length - 1]), line('A month earlier', at(ten, monthsBefore(d0, 1))),
            line('A year earlier', at(ten, monthsBefore(d0, 12)))].filter(Boolean),
  };
}

const SOURCE = { name: 'FRED, Federal Reserve Bank of St. Louis', href: 'https://fred.stlouisfed.org/' };
const CLASS = {
  id: 'economy', title: 'US economy',
  blurb: 'The US economy in its official numbers — inflation, jobs, growth and rates — from FRED, the St. Louis Fed’s data service. Each figure is as of its own release, and dated.',
};

async function overview() {
  const { data, answered } = await load();
  const by = new Map(INDICATORS.map((i) => [i.id, shape(i, data)]));
  return {
    asOf: new Date().toISOString(),
    class: CLASS, source: SOURCE, available: answered > 0,
    key: KEY.map((id) => by.get(id)),
    curve: curveOf(data),
    groups: GROUPS.map((g) => ({ ...g, indicators: INDICATORS.filter((i) => i.group === g.id).map((i) => by.get(i.id)) })),
  };
}

async function board(groupId) {
  const G = GROUPS.find((g) => g.id === groupId);
  if (!G) return null;
  const { data, answered } = await load();
  return {
    asOf: new Date().toISOString(),
    class: CLASS, source: SOURCE, available: answered > 0,
    group: G, groups: GROUPS,
    indicators: INDICATORS.filter((i) => i.group === G.id).map((i) => shape(i, data)),
    curve: G.id === 'rates' ? curveOf(data) : null,
  };
}

module.exports = {
  overview, board, GROUP_IDS: GROUPS.map((g) => g.id),
  _INDICATORS: INDICATORS, _KEY: KEY, _CURVE: CURVE, _shape: shape, _curveOf: curveOf, _at: at, _batches: batches,
};
