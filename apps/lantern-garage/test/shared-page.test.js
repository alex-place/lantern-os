'use strict';
/**
 * test/shared-page.test.js — #3562.
 *
 * The page a stranger sees. Its whole contract is that it renders the payload and nothing
 * else: a withheld figure is ABSENT from the payload, so withholding is enforced by there
 * being nothing to draw rather than by a display rule somebody could get wrong later.
 *
 * Also pinned: symbols come from a broker and are drawn into HTML, so they are escaped.
 *
 * Run: node --test apps/lantern-garage/test/shared-page.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = path.join(__dirname, '..', 'public', 'shared.html');
const src = fs.readFileSync(PAGE, 'utf8').replace(/\r\n/g, '\n');
const lines = src.split('\n');

const grabFn = (name) => {
  const i = lines.findIndex((l) => l.startsWith('function ' + name + '('));
  assert.ok(i >= 0, 'function not found: ' + name);
  let depth = 0, started = false;
  const out = [];
  for (let j = i; j < lines.length; j++) {
    out.push(lines[j]);
    for (const ch of lines[j]) { if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--; }
    if (started && depth === 0) break;
  }
  return out.join('\n');
};
const grabDecl = (name) => {
  const i = src.indexOf('\nconst ' + name + ' =');
  assert.ok(i >= 0, 'const not found: ' + name);
  const rest = src.slice(i + 1);
  const next = rest.slice(1).search(/\n(?:const |let |function |\/\*|\()/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

const P = new Function([
  grabDecl('esc'), grabDecl('num'), grabDecl('pct'), grabDecl('usd'), grabDecl('sign'), grabDecl('fig'),
  grabFn('monthName'), grabFn('renderMonth'), grabFn('renderSymbols'), grabFn('renderR'),
  grabDecl('histLabel'),
].join('\n') + '\nreturn { renderMonth, renderSymbols, renderR, monthName };')();

const MONTH_QUIET = { month: '2026-08', tradingDays: 7, dayWinRate: 28.6, profitFactor: 0.38, trades: 31, winRate: 51.6 };
const MONTH_LOUD = Object.assign({}, MONTH_QUIET,
  { pnl: -866.28, bestDay: 377.01, worstDay: -593.42, drawdown: 1003.95 });

test('a withheld month draws no amount anywhere', () => {
  const html = P.renderMonth(MONTH_QUIET);
  assert.ok(!html.includes('$'), 'a dollar sign reached the page: ' + html);
  // And what it does draw is a real answer rather than a row of dashes.
  assert.match(html, /0\.38/);
  assert.match(html, /28\.6%/);
  assert.match(html, /51\.6%/);
  assert.match(html, /Amounts are not shown/);
});

test('an opted-in month draws them, signed', () => {
  const html = P.renderMonth(MONTH_LOUD);
  assert.match(html, /-\$866\.28/);
  assert.match(html, /class="v neg">-\$866\.28/, 'a losing month is not painted green');
  assert.match(html, /class="v pos">\$377\.01/);
  assert.ok(!html.includes('Amounts are not shown'));
});

test('withholding is enforced by absence, not by a display rule', () => {
  /* `pnl` is not in the payload at all when it was withheld — so a future edit to this
     page cannot accidentally reveal it, because there is nothing there to reveal. */
  assert.ok(!('pnl' in MONTH_QUIET));
  const html = P.renderMonth(Object.assign({}, MONTH_QUIET, { pnl: undefined }));
  assert.ok(!html.includes('NaN') && !html.includes('undefined'), html);
});

test('a symbol from a broker cannot inject markup', () => {
  const html = P.renderSymbols({ rows: [
    { symbol: '<img src=x onerror=alert(1)>', trades: 2, winRate: 50, profitFactor: 1 },
    { symbol: 'A&B"C', trades: 1, winRate: 0, profitFactor: null },
  ] });
  assert.ok(!html.includes('<img'), 'markup survived: ' + html);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /A&amp;B&quot;C/);
});

test('a symbols card with amounts withheld has no Realized column at all', () => {
  const quiet = P.renderSymbols({ rows: [{ symbol: 'SPY', trades: 4, winRate: 75, profitFactor: 2.1 }] });
  const loud = P.renderSymbols({ rows: [{ symbol: 'SPY', trades: 4, winRate: 75, profitFactor: 2.1, realized: 412.5 }] });
  assert.ok(!/Realized/.test(quiet), 'an empty column is still a column');
  assert.match(loud, /Realized/);
  assert.match(loud, /\$412\.50/);
});

test('an unmeasurable figure is a dash, not a zero', () => {
  // A 100% win rate has no losses, so its profit factor is not 0 — it does not exist.
  const html = P.renderSymbols({ rows: [{ symbol: 'SPY', trades: 3, winRate: 100, profitFactor: null }] });
  assert.match(html, /—/);
  assert.ok(!/>0\.00</.test(html));
});

test('the R card draws its distribution and says it has no amounts in it', () => {
  const html = P.renderR({
    n: 43, withR: 29, coverage: 67.4, width: 0.5, mean: -0.06, median: 0.16,
    best: 1.02, worst: -2.78, wins: 20, losses: 9, payoff: 0.36,
    buckets: [{ from: -1, to: -0.5, count: 4, wins: 0 }, { from: 0, to: 0.5, count: 11, wins: 11 }],
  });
  assert.match(html, /29 of 43/);
  assert.match(html, /no amounts in it at all/);
  assert.ok(!html.includes('$'));
  // Losing buckets are red and winning ones green, which is the only thing the shape says.
  assert.match(html, /class="b loss"/);
  assert.match(html, /class="b win"/);
});

test('the R histogram states itself for a reader who cannot see it', () => {
  const html = P.renderR({ n: 10, withR: 10, coverage: 100, mean: 0.2, median: 0.1, best: 2, worst: -1,
    payoff: 1.5, buckets: [{ from: 0, to: 0.5, count: 10, wins: 10 }] });
  assert.match(html, /role="img"/);
  assert.match(html, /aria-label="Distribution of 10 trades/);
});

test('an empty distribution does not divide by zero', () => {
  const html = P.renderR({ n: 0, withR: 0, coverage: 0, buckets: [] });
  assert.ok(!html.includes('NaN'), html);
  assert.ok(!html.includes('Infinity'));
});

test('a month with no name still renders something honest', () => {
  assert.strictEqual(P.monthName('not-a-month'), 'not-a-month');
  assert.match(P.monthName('2026-08'), /2026/);
});

// ── the page as shipped ──────────────────────────────────────────────────────

test('the page tells search engines to stay away', () => {
  assert.match(src, /<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">/);
});

test('the page carries no figures — it fetches them', () => {
  /* So a share revoked a second ago says so, rather than a card already baked into HTML
     that is on its way to the reader. */
  assert.match(src, /fetch\('\/api\/shared\/' \+ encodeURIComponent\(id\)/);
  assert.match(src, /cache: 'no-store'/);
});

test('nothing on the page leads back to anything else of the reader\'s', () => {
  // One product link, no profile, no listing, no "more from this trader".
  const hrefs = [...src.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(hrefs, ['https://unisona.ai/journal.html'], 'unexpected link: ' + hrefs.join(', '));
});

test('a share that is gone says so without blaming the reader', () => {
  assert.match(src, /taken down by the person who shared it, or it never pointed anywhere/);
});
