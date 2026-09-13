'use strict';
/**
 * test/trader-contrast.test.js — #3583.
 *
 * The same fault #3577 fixed on the journal, found on the two pages that matter more:
 * the light block redefined the surfaces, the greys and the chart axes and stopped, so
 * the dark-tuned green, red, amber and accent kept their values on a white page. Measured
 * on a fresh load of watch.html, walking all 242 visible text nodes composited against
 * their real backgrounds: **1 failure in dark, 20 in light**. Green at 1.69:1, against
 * the 4.5:1 AA wants. These pages are mostly coloured money figures.
 *
 * This reads the palettes straight out of the pages and does the arithmetic — no browser,
 * so it fails the moment somebody adds a colour without checking it. What it CANNOT see
 * is text composited over a tint or dimmed by an `opacity`; both were measured on the
 * rendered page instead, and the properties that keep those results true are pinned here
 * as structure: every signal token is redefined for light, and secondary text is not
 * dimmed a second time.
 *
 * Run: node --test apps/lantern-garage/test/trader-contrast.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGES = ['stock-trader.html', 'watch.html'];
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

function tokensIn(block) {
  const out = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/gi)) out[m[1]] = m[2].trim();
  return out;
}
const blockAfter = (src, marker) => {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, 'block not found: ' + marker);
  return src.slice(i, src.indexOf('}', i));
};
const rgb = (hex) => {
  const h = String(hex).trim().replace('#', '');
  assert.match(h, /^[0-9a-f]{6}$/i, 'not a plain hex colour: ' + hex);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const lum = (c) => {
  const x = c.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2];
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};

const SURFACES = ['--bg0', '--bg1', '--bg2', '--bg3'];
const SIGNALS = ['--green', '--red', '--amber', '--text2', '--text1', '--text0'];

for (const page of PAGES) {
  const src = read(page);
  const dark = tokensIn(blockAfter(src, '    --bg0:#0a0c0f'));
  const light = tokensIn(blockAfter(src, '  html[data-theme="light"]{'));

  test(page + ': the light theme redefines every SIGNAL colour, not just the greys', () => {
    /* This is the actual fault. A light block that redefines --bg0..3 and leaves --green
       alone is not half-themed, it is broken: the surfaces move and the figures on them
       do not. */
    for (const t of ['--green', '--red', '--amber']) {
      assert.ok(light[t], page + ' light theme does not redefine ' + t);
      assert.notStrictEqual(light[t], dark[t], t + ' still carries its dark value in light mode');
    }
  });

  test(page + ': every signal colour clears AA on every surface it can sit on — light', () => {
    const fails = [];
    for (const s of SIGNALS) {
      if (!light[s]) continue;
      for (const bg of SURFACES) {
        if (!light[bg]) continue;
        const r = ratio(light[s], light[bg]);
        if (r < 4.5) fails.push(s + ' on ' + bg + ' = ' + r.toFixed(2) + ':1');
      }
    }
    assert.deepStrictEqual(fails, []);
  });

  test(page + ': and on the pale tinted chips a figure actually sits on — light', () => {
    /* The gain pill and the HIGH IMPACT badge put a signal colour on a wash of itself.
       Token-against-surface arithmetic cannot see those, so the real composited values
       measured on the rendered page are checked explicitly. */
    const TINTS = { greenPill: '#e0faf5', amberPill: '#fffcf7', bluePill: '#e9f3ff' };
    const fails = [];
    for (const s of ['--green', '--red', '--amber']) {
      for (const [name, tint] of Object.entries(TINTS)) {
        const r = ratio(light[s], tint);
        if (r < 4.5) fails.push(s + ' on ' + name + ' = ' + r.toFixed(2) + ':1');
      }
    }
    assert.deepStrictEqual(fails, []);
  });

  test(page + ': every signal colour clears AA on every surface — dark', () => {
    // Dark was nearly clean already; --text2 missed --bg3 by 4.48 and the teal sign-in
    // banner by 4.47. Under by a rounding error is still under.
    const fails = [];
    for (const s of SIGNALS) {
      if (!dark[s]) continue;
      for (const bg of SURFACES) {
        if (!dark[bg]) continue;
        const r = ratio(dark[s], dark[bg]);
        if (r < 4.5) fails.push(s + ' on ' + bg + ' = ' + r.toFixed(2) + ':1');
      }
    }
    assert.deepStrictEqual(fails, []);
  });

  test(page + ': a label sets its colour from a token, like the surface it sits on', () => {
    /* The price ladder set `background:var(--bg1)` and `color:#e8eaf0` in one inline
       style, so the chip themed and the price on it did not — 1.2:1 on white. A literal
       beside a token in the same declaration is the shape of that bug. */
    assert.doesNotMatch(src, /color:#e8eaf0/, 'a hard-coded dark text colour survives');
    assert.doesNotMatch(src, /color:\$\{?['"]?#(?:e8eaf0|b3b9c5)/, 'and none is interpolated in');
  });

  test(page + ': secondary text is not dimmed a second time', () => {
    /* --text2 IS the de-emphasis. Wrapping it in opacity:.7 took it to 3.02:1 on white:
       the colour says "this is secondary" and the opacity says it again, past legible. */
    assert.doesNotMatch(src, /style="opacity:\.[1-7]"[^>]*>/,
      'text dimmed below 0.8 on top of an already-secondary colour');
  });
}

test('the two trader pages share one palette, so a fix cannot land on only one', () => {
  // They are near-copies and drifted once already: watch.html kept a hard-coded ladder
  // colour that stock-trader.html had already tokenised.
  const [a, b] = PAGES.map((p) => tokensIn(blockAfter(read(p), '  html[data-theme="light"]{')));
  assert.deepStrictEqual(a, b, 'the light palettes have drifted apart');
});
