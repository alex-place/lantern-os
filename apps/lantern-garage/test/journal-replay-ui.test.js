'use strict';
/**
 * test/journal-replay-ui.test.js — #3561.
 *
 * The card's whole claim is that it is a REPLAY rather than a picture of a finished
 * trade. That claim is four rules, and all four are pinned here:
 *
 *   1. bars past the cursor are not drawn;
 *   2. a mark appears only once the replay reaches the moment it was known — the stop and
 *      targets at the entry, the exit and the excursions at the exit;
 *   3. the price scale is fixed to the WHOLE frame, so nothing moves while you step;
 *   4. opening a replay does not refetch the list it was opened from (#3541).
 *
 * Drop any one of them and the reader is looking at the answer while being told they are
 * looking at the setup.
 *
 * Run: node --test apps/lantern-garage/test/journal-replay-ui.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = process.env.JOURNAL_PAGE || path.join(__dirname, '..', 'public', 'journal.html');
const src = fs.readFileSync(PAGE, 'utf8').replace(/\r\n/g, '\n');
const lines = src.split('\n');

const grabFn = (name) => {
  const i = lines.findIndex((l) => l.startsWith('function ' + name + '(') || l.startsWith('async function ' + name + '('));
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
  const next = rest.slice(1).search(/\n(?:const |let |function |\/\*)/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

// A stubbed document with a KNOWN width, so the measured chart is measurable in a test.
const P = new Function([
  'const document = { getElementById: () => ({ clientWidth: 800 }), querySelector: () => null };',
  'let jpReplay = null;',
  grabDecl('jpEsc'), grabDecl('jpUsd'), grabDecl('jpPct'), grabDecl('jpSign'),
  grabFn('jpLabelValue'), grabDecl('JP_RPAD'),
  grabFn('jpReplayBox'), grabFn('jpReplayScale'), grabFn('jpReplayChart'),
  grabFn('jpReplayReadout'), grabFn('jpReplayLegend'), grabFn('jpReplayInner'),
  grabFn('jpReplayProvenance'),
].join('\n') + '\nreturn { jpReplayChart, jpReplayInner, jpReplayReadout, jpReplayLegend, jpReplayScale, jpReplayProvenance, jpReplayBox };')();

const T = (s) => Date.parse(s);

/* 60 five-minute bars. Entry on bar 20, exit on bar 40 — so there is a before, a during
   and an after, which is what the reveal rules are about. */
function payload(over) {
  const t0 = T('2026-09-09T13:30:00.000Z');
  const bars = Array.from({ length: 60 }, (_, i) => {
    const p = 100 + Math.sin(i / 6) * 3;
    return { t: t0 + i * 300000, o: p, h: p + 0.4, l: p - 0.4, c: p, v: 1000 };
  });
  return Object.assign({
    trade: { id: 't1', symbol: 'SPY', side: 'long', qty: 10, entry: 100, exit: 103,
      pnl: 30, pnl_pct: 3, r: 1.2, reason: 'take_profit_R',
      openedAt: new Date(t0 + 20 * 300000).toISOString(), closedAt: new Date(t0 + 40 * 300000).toISOString() },
    opening: { at: new Date(t0 + 20 * 300000).toISOString(), stop: 97, target1: 106, target2: 109, recovered: true },
    timeframe: '5m', rolledUp: null, bars,
    marks: { entryIdx: 20, exitIdx: 40, entry: 100, exit: 103, stop: 97,
      stopFrom: 'the stop order placed at entry', target1: 106, target2: 109, mfe: 103.5, mae: 99.2 },
    coverage: 'full', why: null, source: 'archive',
  }, over);
}

const count = (s, re) => (s.match(re) || []).length;

// ── 1. the reveal ────────────────────────────────────────────────────────────

test('bars past the cursor are not drawn', () => {
  const d = payload();
  // Each bar is a wick line plus a body rect; the bodies are the countable half.
  const at10 = P.jpReplayChart(d, 10);
  const at50 = P.jpReplayChart(d, 50);
  const bodies = (s) => count(s, /<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" fill="var\(--(green|red)\)"/g);
  assert.strictEqual(bodies(at10), 11, 'eleven bars revealed at cursor 10');
  assert.strictEqual(bodies(at50), 51);
});

test('the setup is on screen before the entry, and nothing of the outcome is', () => {
  const s = P.jpReplayChart(payload(), 15);
  assert.ok(!s.includes('$97.00'), 'no stop line yet — it was not known to a reader at bar 15');
  assert.ok(!s.includes('$103.00'), 'and no exit');
  assert.match(P.jpReplayReadout(payload(), 15), /Before the entry/);
});

test('the stop and the targets appear at the entry, and the exit does not', () => {
  const s = P.jpReplayChart(payload(), 25);
  assert.ok(s.includes('$97.00'), 'the stop, which was placed at the entry');
  assert.ok(s.includes('$106.00'), 'and the target');
  assert.ok(!s.includes('$103.00'), 'but not the exit, which has not happened');
});

test('the exit and the excursions appear only once the trade is over', () => {
  const before = P.jpReplayLegend(payload(), 30);
  const after = P.jpReplayLegend(payload(), 45);
  assert.ok(!/Exit/.test(before));
  assert.ok(!/while open/.test(before), 'how far it ran is a fact about a finished trade');
  assert.match(after, /Exit \$103\.00/);
  assert.match(after, /Best \$103\.50 . worst \$99\.20 while open/);
});

test('the excursion band is drawn between the entry and the exit, not across the chart', () => {
  const s = P.jpReplayChart(payload(), 45);
  const band = s.match(/<rect x="([\d.]+)"[^>]*width="([\d.]+)"[^>]*fill="color-mix/);
  assert.ok(band, 'the band is drawn');
  const box = P.jpReplayBox();
  assert.ok(+band[1] > box.w * 0.25 && +band[1] < box.w * 0.45, 'starts around the entry');
  assert.ok(+band[2] < box.w * 0.5, 'and spans the hold, not the frame');
});

// ── 2. the scale ─────────────────────────────────────────────────────────────

test('the price scale is fixed to the whole frame, so stepping does not move it', () => {
  /* A scale that grew with the revealed bars would make the same move look different
     depending on where you paused, which is the opposite of a replay. */
  const d = payload();
  // Render the same bar at two cursors and compare where it landed. This is the property
  // that matters -- not what the scale function returns, but that the chart does not use
  // the revealed bars to compute it.
  // The candle BODIES only: at a cursor past the exit the excursion band is a rect too,
  // and counting it would shift every index by one.
  const bodies = (svg) => (svg.match(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" fill="var\(--(?:green|red)\)"/g) || []);
  const yOf = (svg, i) => bodies(svg)[i];
  assert.strictEqual(yOf(P.jpReplayChart(d, 15), 5), yOf(P.jpReplayChart(d, 50), 5),
    'bar 5 sits in the same place whether five bars are showing or fifty');
  // And a level outside every bar still fits on the chart.
  const wide = P.jpReplayScale(d.bars, Object.assign({}, d.marks, { stop: 80 }));
  assert.ok(wide.lo < 80, 'a stop below every bar is still visible');
});

test('a flat frame still has a scale rather than dividing by zero', () => {
  const flat = [{ t: 0, o: 5, h: 5, l: 5, c: 5, v: 0 }, { t: 1, o: 5, h: 5, l: 5, c: 5, v: 0 }];
  const sc = P.jpReplayScale(flat, {});
  assert.ok(sc.hi > sc.lo);
});

// ── 3. the readout ───────────────────────────────────────────────────────────

test('while the position is on, the readout prices it AT THAT BAR', () => {
  const d = payload();
  const mid = P.jpReplayReadout(d, 30);
  assert.match(mid, /still on/);
  assert.doesNotMatch(mid, /take profit/, 'the exit reason is not a fact yet');
  const end = P.jpReplayReadout(d, 45);
  assert.match(end, /Closed/);
  assert.match(end, /take profit/);
});

test('a trade with no recorded size shows no dollar figure at all', () => {
  // `qty || 0` printed $0.00, which reads like a position that went nowhere rather than
  // one we cannot price. The percentage is true either way.
  const t = Object.assign(payload().trade, { qty: null });
  const out = P.jpReplayReadout(payload({ trade: t }), 30);
  assert.match(out, /size not recorded/);
  assert.doesNotMatch(out, /\$0\.00/);
  assert.match(out, /%/, 'but the percentage still holds');
});

test('a short is priced the other way round', () => {
  // Same bar, same entry, opposite side: whatever the long is making, the short is losing.
  const long = P.jpReplayReadout(payload(), 30);
  const short = P.jpReplayReadout(payload({ trade: Object.assign(payload().trade, { side: 'short' }) }), 30);
  const amount = (s) => (s.match(/Open <span class="jp-(pos|neg)">(-?\$[\d,.]+)/) || [])[2];
  const sign = (s) => (s.match(/Open <span class="jp-(pos|neg)"/) || [])[1];
  assert.ok(amount(long) && amount(short), long + ' / ' + short);
  assert.notStrictEqual(sign(long), sign(short), 'the same move cannot be good for both');
  assert.strictEqual(amount(long).replace('-', ''), amount(short).replace('-', ''),
    'and it is the same move, so the size is the same');
});

// ── 4. it costs nothing until opened, and says where it came from ────────────

test('opening a replay repaints the card and does not refetch the list', () => {
  const open = grabFn('jpReplayOpen');
  assert.match(open, /\/api\/journal\/replay/, 'one request, for one trade');
  assert.doesNotMatch(open, /jpTradeLoad\(/, 'and never the list again (#3541)');
  assert.match(open, /jpTradeRepaint\(\)/);
  // Stepping is a cursor move, so it must not go back to the network at all.
  const draw = grabFn('jpReplayDraw');
  const step = grabFn('jpReplayStep');
  for (const fn of [draw, step]) assert.doesNotMatch(fn, /fetch\(/);
});

test('nothing loads bars until a reader asks for one trade', () => {
  // The page must not warm a replay on render: the only call site is the button.
  const calls = count(src, /jpReplayOpen\(/g);
  assert.ok(calls <= 2, 'declared once and called from the button: ' + calls);
  assert.match(grabFn('jpTradeDetail'), /jpReplayOpen\(/, 'and that button is in the expanded row');
  assert.doesNotMatch(grabFn('jpTradeLoad'), /replay/i, 'the list never fetches bars');
});

test('the reader is told where the bars came from and how the opening was got', () => {
  const p = P.jpReplayProvenance(payload());
  assert.match(p, /our own intraday record/);
  assert.match(p, /recovered from the entry/);
  assert.match(p, /stop from the stop order placed at entry/);
  const live = P.jpReplayProvenance(payload({ source: 'live', rolledUp: { from: '5m', every: 12 } }));
  assert.match(live, /fetched for this window/);
  assert.match(live, /rolled up from 5m/, 'a reconstructed candle says it is one');
});

test('no bars is a sentence, not an empty chart', () => {
  const out = P.jpReplayInner(payload({ bars: [], coverage: 'none', why: 'There is no bar history for FOO.' }), 0, false);
  assert.doesNotMatch(out, /<svg/);
  assert.match(out, /no bar history for FOO/);
});

test('a partial window is drawn AND labelled', () => {
  const d = payload({ coverage: 'partial', why: 'Bars are missing after 2026-09-09 15:00Z.' });
  assert.match(P.jpReplayChart(d, 30), /<svg/, 'half a trade\'s bars is more than none');
  assert.match(P.jpReplayProvenance(d), /Bars are missing/);
});

// ── the chart itself ─────────────────────────────────────────────────────────

test('the viewBox is measured in real pixels, not a fixed box scaled to fit', () => {
  /* A fixed box gives one of two bad charts: scaled uniformly it renders ~460px tall
     inside a table row, and scaled freely it stretches the price labels with it. */
  const s = P.jpReplayChart(payload(), 30);
  const vb = s.match(/viewBox="0 0 (\d+) (\d+)"/);
  assert.ok(vb, 'has a viewBox');
  assert.strictEqual(vb[1], '800', 'the width the stub reported');
  assert.ok(+vb[2] >= 190 && +vb[2] <= 330, 'a chart-shaped height: ' + vb[2]);
  assert.doesNotMatch(s, /preserveAspectRatio="none"/, 'which would stretch the text');
});

test('the chart states its own figures for a reader who cannot see it', () => {
  const s = P.jpReplayChart(payload(), 30);
  assert.match(s, /role="img"/);
  assert.match(s, /aria-label="SPY 5m/);
  assert.match(s, /showing 31/, 'and says where the replay is up to');
});

test('a session break is drawn, so an overnight gap is not read as a wick', () => {
  const d = payload();
  const t0 = d.bars[0].t;
  // Push everything from bar 30 on into the next morning.
  d.bars = d.bars.map((b, i) => (i < 30 ? b : Object.assign({}, b, { t: b.t + 20 * 3600000 })));
  const withGap = P.jpReplayChart(d, 50);
  const flat = P.jpReplayChart(payload(), 50);
  const seps = (s) => count(s, /stroke="var\(--border\)"/g);
  assert.strictEqual(seps(flat), 0);
  assert.strictEqual(seps(withGap), 1, 'one break, where the session ended');
  assert.ok(t0 > 0);
});
