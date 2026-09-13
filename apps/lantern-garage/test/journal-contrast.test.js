'use strict';
/**
 * test/journal-contrast.test.js — #3577.
 *
 * The light theme was never contrast-checked. It redefined the greys and left the signal
 * colours where the dark theme had put them, so on white the green measured 1.91:1 and the
 * amber 2.03:1 — against the 4.5:1 AA wants for text. The journal is almost entirely
 * coloured money figures, so that was most of the page.
 *
 * This reads the palette straight out of the page and does the arithmetic, which needs no
 * browser and fails the moment somebody adds a colour without checking it. It cannot see
 * text composited over a tint — that was measured on the rendered page — so the tint
 * tokens are pinned as *separate from* the text tokens, which is the property that makes
 * the rendered result hold.
 *
 * Run: node --test apps/lantern-garage/test/journal-contrast.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = process.env.JOURNAL_PAGE || path.join(__dirname, '..', 'public', 'journal.html');
const src = fs.readFileSync(PAGE, 'utf8');

/** The custom properties declared in one CSS block. */
function tokensIn(block) {
  const out = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/gi)) out[m[1]] = m[2].trim();
  return out;
}
const blockAfter = (marker) => {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, 'block not found: ' + marker);
  return src.slice(i, src.indexOf('}', i));
};

const DARK = tokensIn(blockAfter('  :root{--bg0:'));
const LIGHT = tokensIn(blockAfter('  html[data-theme="light"]{'));

const rgb = (hex) => {
  const h = hex.trim().replace('#', '');
  assert.match(h, /^[0-9a-f]{6}$/i, 'not a plain hex colour: ' + hex);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const lum = (c) => {
  const x = c.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2];
};
const ratio = (a, b) => {
  const [la, lb] = [lum(rgb(a)), lum(rgb(b))];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

// Every surface a figure can land on, in each theme.
const SURFACES = ['--bg1', '--bg2', '--bg3'];
const TEXT = ['--green', '--red', '--amber', '--text0', '--text1', '--text2'];

for (const [name, theme] of [['dark', DARK], ['light', LIGHT]]) {
  test('every ' + name + '-theme text colour clears AA on every surface it can sit on', () => {
    for (const t of TEXT) {
      assert.ok(theme[t], name + ' defines ' + t);
      for (const s of SURFACES) {
        assert.ok(theme[s], name + ' defines ' + s);
        const r = ratio(theme[t], theme[s]);
        assert.ok(r >= 4.5, `${name}: ${t} (${theme[t]}) on ${s} (${theme[s]}) is ${r.toFixed(2)}:1, AA needs 4.5`);
      }
    }
  });
}

test('the light theme defines its own signal colours, not just its own greys (#3577)', () => {
  // The whole fault: this block used to stop at --text2, so the dark-tuned green, red,
  // amber and blue fell through to a white page.
  for (const t of ['--green', '--red', '--amber', '--blue']) {
    assert.ok(LIGHT[t], 'light theme must set ' + t + ' — inheriting the dark value is the bug');
    assert.notStrictEqual(LIGHT[t], DARK[t], t + ' must differ between themes');
  }
});

test('a wash is a separate token from the figure that sits on it (#3577)', () => {
  /* The heatmap's wash scales to 52% with the size of a cell's figure. While the wash was
     the same colour as the text, the strongest cells were the least readable — the
     background climbed toward the foreground exactly where the number mattered most. */
  for (const [name, theme] of [['dark', DARK], ['light', LIGHT]]) {
    for (const t of ['--tint-pos', '--tint-neg']) {
      assert.ok(theme[t], name + ' defines ' + t);
      assert.match(theme[t], /^#[0-9a-f]{6}$/i, name + ' ' + t + ' is a literal, not an alias of the text colour');
    }
    assert.notStrictEqual(theme['--tint-pos'], theme['--green'], name + ': the wash is not the figure colour');
    assert.notStrictEqual(theme['--tint-neg'], theme['--red'], name + ': the wash is not the figure colour');
  }
  // And they pull in opposite directions: pale under dark text, deep under bright text.
  assert.ok(lum(rgb(LIGHT['--tint-pos'])) > lum(rgb(LIGHT['--green'])), 'light: the wash is lighter than its figure');
  assert.ok(lum(rgb(DARK['--tint-pos'])) < lum(rgb(DARK['--green'])), 'dark: the wash is darker than its figure');
});

test('the heatmap paints the wash token, never the figure colour', () => {
  const i = src.indexOf("const tint = e >= 0");
  assert.ok(i >= 0, 'found the heatmap tint');
  const line = src.slice(i, src.indexOf('\n', i));
  assert.match(line, /--tint-pos/);
  assert.match(line, /--tint-neg/);
  assert.doesNotMatch(line, /--green|--red/);
});

test('thin cells fade the wash, not the figure (#3577)', () => {
  // Fading the whole cell dimmed the number with it, which on a pale theme took it under
  // 4:1 — a readability cost paid to signal unreliability.
  assert.doesNotMatch(src, /\.jp-heat td\.few\{opacity/, 'no opacity fade on the cell');
  assert.match(src, /const strength = few \? Math\.round\(full \* 0\.4\) : full;/,
    'a thin cell gets a fraction of the wash instead');
});

test('a day number is not tertiary grey on a tinted cell', () => {
  // 3.68:1 in dark, 4.07:1 in light, on cells that are the point of the calendar.
  assert.match(src, /\.jp-day\.win \.d, \.jp-day\.loss \.d\{color:var\(--text1\)\}/);
});
