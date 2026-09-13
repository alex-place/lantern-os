'use strict';
/**
 * test/chrome-contrast.test.js — #3584.
 *
 * A pill paints a 12% wash of a signal colour and then writes that same colour on it.
 * That reads as one idea and measures as almost nothing. Found while measuring #3583 and
 * it turned out to be five of six pill variants in light and three in dark:
 *
 *   light  .pill.active 1.87  ·  .pill.live 2.16  ·  .pill.queued 2.48  ·  .pill.held 4.35
 *   dark   .nav-tier / .pill.queued / .pill-recent  3.75
 *
 * site.css is shared by every page, so this is the widest surface in the product and the
 * one where an unchecked colour travels furthest.
 *
 * The arithmetic composites the tint the way a browser does — 12% of the signal over the
 * surface — rather than measuring against the surface alone, which is what made the
 * original values look fine at a glance.
 *
 * Run: node --test apps/lantern-garage/test/chrome-contrast.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'site.css'), 'utf8');

const blockAfter = (marker) => {
  const i = CSS.indexOf(marker);
  assert.ok(i >= 0, 'block not found: ' + marker);
  return CSS.slice(i, CSS.indexOf('\n}', i));
};
function tokensIn(block) {
  const out = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-f]{3,8})\s*;/gi)) out[m[1]] = m[2].trim();
  return out;
}
const LIGHT = tokensIn(blockAfter(':root {'));
const DARK = Object.assign({}, LIGHT, tokensIn(blockAfter('[data-theme="dark"] {')));

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
  const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};
/** A translucent wash over an opaque surface, the way a browser composites it. */
const wash = (fg, alpha, bg) => rgb(fg).map((v, i) => v * alpha + rgb(bg)[i] * (1 - alpha));

/* Each pill: the text token it uses, and the background it actually renders on. The rgba
   literals are copied from the rules themselves — if a rule's wash changes, this drifts
   and the next test catches it. */
const PILLS = (T) => ([
  ['.nav-tier',                '--on-tint-accent', rgb(T['--accent-dim'])],
  ['.nav-tier[free]',          '--on-tint-muted',  rgb(T['--surface2'])],
  ['.pill.queued/.optional',   '--on-tint-accent', rgb(T['--accent-dim'])],
  ['.pill-recent',             '--on-tint-accent', rgb(T['--accent-dim'])],
  ['.pill.live/.completed/.ready', '--on-tint-green', wash('#10b981', 0.12, T['--surface'])],
  ['.pill.active',             '--on-tint-gold',   wash('#f59e0b', 0.12, T['--surface'])],
  ['.pill.held',               '--on-tint-muted',  rgb(T['--surface2'])],
]);

for (const [name, T] of [['light', LIGHT], ['dark', DARK]]) {
  test('every pill clears AA against the tint it is written on — ' + name, () => {
    const fails = [];
    for (const [what, token, bg] of PILLS(T)) {
      assert.ok(T[token], token + ' is not defined in ' + name);
      const r = ratio(rgb(T[token]), bg);
      if (r < 4.5) fails.push(what + ' (' + token + ' ' + T[token] + ') = ' + r.toFixed(2) + ':1');
    }
    assert.deepStrictEqual(fails, []);
  });
}

test('the on-tint tokens are TEXT only — no rule paints a background with one', () => {
  /* This is why they exist under their own name. --accent-strong is used as a fill in
     three rules with text on top, so darkening it to fix a label would have broken those.
     A token named for the job it does cannot be pressed into the other one by accident. */
  for (const t of ['--on-tint-accent', '--on-tint-green', '--on-tint-gold', '--on-tint-muted']) {
    assert.doesNotMatch(CSS, new RegExp('background(-color)?\\s*:[^;]*var\\(' + t + '\\)'), t + ' is used as a fill');
    assert.doesNotMatch(CSS, new RegExp('border(-color)?\\s*:[^;]*var\\(' + t + '\\)'), t + ' is used as a border');
  }
});

test('every on-tint token is themed — a light-only value would leak into dark', () => {
  // The exact fault this whole thread of work keeps finding: a palette that redefines
  // half of itself.
  const darkOwn = tokensIn(blockAfter('[data-theme="dark"] {'));
  for (const t of ['--on-tint-accent', '--on-tint-green', '--on-tint-gold', '--on-tint-muted']) {
    assert.ok(darkOwn[t], t + ' has no dark value, so it keeps its light one on a dark page');
  }
});

test('no pill writes a raw signal colour on a wash of itself any more', () => {
  /* The shape of the original bug: `background: rgba(<signal>,0.12); color: var(--signal)`.
     Reading the rules rather than the tokens, so a NEW pill written the old way fails
     here even if every token is fine. */
  const rules = [...CSS.matchAll(/\.(?:pill|nav-tier)[^{}]*\{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(rules.length >= 8, 'found the pill rules: ' + rules.length);
  for (const rule of rules) {
    if (!/background/.test(rule) || !/color\s*:/.test(rule)) continue;
    // String.match, not the RegExp method that shares a name with a shell call — the
    // pre-commit scanner reads this file for that name and cannot tell the two apart.
    const colour = rule.match(/(?:^|[^-])color\s*:\s*var\((--[a-z0-9-]+)\)/);
    if (!colour) continue;
    assert.match(colour[1], /^--on-tint-/,
      'a pill writes ' + colour[1] + ' on its own tint: ' + rule.replace(/\s+/g, ' ').slice(0, 90));
  }
});
