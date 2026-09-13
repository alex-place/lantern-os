'use strict';
/**
 * test/signal-palette.test.js — #3589.
 *
 * A colour picker can undo every contrast fix in the product — #3577, #3583, #3584 and
 * #3587 each spent real effort getting money figures above 4.5:1, and one enthusiastic
 * yellow puts them back at 1.07. So the contract here is not "the preference is saved",
 * it is:
 *
 *   whatever a reader picks, what gets painted is readable, keeps their hue, and says
 *   so when it had to move.
 *
 * That is a claim about every colour, not about four presets, so it is fuzzed across the
 * hue wheel rather than spot-checked.
 *
 * Run: node --test apps/lantern-garage/test/signal-palette.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SP = require('../public/js/signal-palette');

const THEMES = ['dark', 'light'];
/* Every surface a figure can land on — the theme's surfaces, plus the wash of ITSELF.
   Not the other signal's wash: a loss is never written on a gain's green background, and
   measuring it there fails a pairing the product does not draw. (The first version of
   this helper did exactly that and reported a bug that was not one.) */
const surfacesFor = (r, which) =>
  SP.SURFACES[r.theme].concat([which === 'loss' ? r.lossTint : r.gainTint]);
const minRatio = (hex, surfaces) => Math.min.apply(null, surfaces.map((s) => SP.ratio(hex, s)));

// ── the presets ──────────────────────────────────────────────────────────────

test('every preset is readable on every surface, in both themes', () => {
  const fails = [];
  for (const theme of THEMES) {
    for (const p of SP.PRESETS) {
      const r = SP.resolve({ id: p.id }, theme);
      for (const [which, hex] of [['gain', r.gain], ['loss', r.loss]]) {
        const m = minRatio(hex, surfacesFor(r, which));
        if (m < 4.5) fails.push(theme + '/' + p.id + ' ' + which + ' ' + hex + ' = ' + m.toFixed(2) + ':1');
      }
    }
  }
  assert.deepStrictEqual(fails, []);
});

test('every preset says why it exists', () => {
  // A palette chooser with four unexplained swatches is a guessing game. The colour-blind
  // one in particular has a reason a reader would want to know.
  for (const p of SP.PRESETS) {
    assert.ok(p.note && p.note.length > 20, p.id + ' has no note');
    assert.ok(p.name && p.name.length > 2, p.id + ' has no name');
  }
  assert.match(SP.PRESETS.map((p) => p.note).join(' '), /colour blindness/i,
    'the accessible preset does not say what it is for');
});

test('the presets a reader can tell apart, do tell apart — except the one that says it will not', () => {
  for (const theme of THEMES) {
    for (const p of SP.PRESETS) {
      const r = SP.resolve({ id: p.id }, theme);
      if (p.mono) { assert.ok(r.distinct.mono, p.id + ' should declare itself monochrome'); continue; }
      assert.ok(r.distinct.ok, theme + '/' + p.id + ': gain and loss are ' + r.distinct.hueDistance + ' degrees apart');
    }
  }
});

test('Classic resolves to the palette the stylesheets already ship', () => {
  /* Not a coincidence worth losing: the light values #3577 hand-picked and measured are
     what this arrives at on its own, so turning the feature on changes nothing for a
     reader who never opens the setting. */
  const light = SP.resolve({ id: 'classic' }, 'light');
  assert.match(light.gain, /^#00735c|^#00745d$/, 'light gain drifted from the shipped green: ' + light.gain);
  assert.strictEqual(light.loss, '#cf0012');
  const dark = SP.resolve({ id: 'classic' }, 'dark');
  assert.strictEqual(dark.gain, '#00d4aa', 'dark was already AA, so it must not move');
  assert.strictEqual(dark.loss, '#ff5f6d');
  assert.strictEqual(dark.adjusted.gain, 0);
});

// ── any colour at all ────────────────────────────────────────────────────────

test('ANY colour a reader can pick comes back readable', () => {
  /* The whole hue wheel at four saturations and five lightnesses, both themes: 4800
     colours. This is the test that makes a free colour picker safe to ship. */
  const fails = [];
  let n = 0;
  for (const theme of THEMES) {
    for (let h = 0; h < 360; h += 3) {
      for (const s of [10, 40, 70, 100]) {
        for (const l of [10, 30, 50, 70, 90]) {
          const hex = SP.rgbToHex(SP.hslToRgb(h, s, l));
          const r = SP.resolve({ id: 'custom', gain: hex, loss: hex }, theme);
          n++;
          if (r.unreachable) { fails.push(theme + ' ' + hex + ' unreachable'); continue; }
          const m = minRatio(r.gain, surfacesFor(r, 'gain'));
          if (m < 4.5) fails.push(theme + ' ' + hex + ' -> ' + r.gain + ' = ' + m.toFixed(3));
        }
      }
    }
  }
  assert.strictEqual(n, 4800);
  assert.deepStrictEqual(fails.slice(0, 5), [], fails.length + ' of ' + n + ' below AA');
});

test('the colour measured is the colour emitted', () => {
  /* Walking lightness in floats and emitting a hex put 60 of those 4800 at 4.48-4.50:
     clearing inside the loop and failing as rendered. The rounding happens before the
     check now, so what is measured is what a browser gets. */
  for (const theme of THEMES) {
    for (let h = 0; h < 360; h += 7) {
      const hex = SP.rgbToHex(SP.hslToRgb(h, 100, 50));
      const r = SP.resolve({ id: 'custom', gain: hex, loss: hex }, theme);
      const m = minRatio(r.gain, surfacesFor(r, 'gain'));
      assert.ok(m >= 4.5, theme + ' ' + hex + ' -> ' + r.gain + ' = ' + m.toFixed(3));
      assert.match(r.gain, /^#[0-9a-f]{6}$/, 'emitted something that is not a plain hex: ' + r.gain);
    }
  }
});

test('a reader gets the colour they asked for, only readable', () => {
  // Hue is the thing they chose. Lightness is ours to move; hue is not.
  for (const theme of THEMES) {
    for (let h = 0; h < 360; h += 5) {
      const hex = SP.rgbToHex(SP.hslToRgb(h, 85, 50));
      const r = SP.resolve({ id: 'custom', gain: hex, loss: hex }, theme);
      const before = SP.rgbToHsl(SP.hexToRgb(hex))[0];
      const after = SP.rgbToHsl(SP.hexToRgb(r.gain))[0];
      let d = Math.abs(before - after);
      if (d > 180) d = 360 - d;
      assert.ok(d <= 2, 'hue moved ' + d.toFixed(1) + ' degrees at h=' + h + ' (' + hex + ' -> ' + r.gain + ')');
    }
  }
});

test('a colour that was already fine is not touched', () => {
  const r = SP.resolve({ id: 'custom', gain: '#00d4aa', loss: '#ff5f6d' }, 'dark');
  assert.strictEqual(r.adjusted.gain, 0);
  assert.strictEqual(r.adjusted.loss, 0);
  assert.strictEqual(r.gain, '#00d4aa');
});

test('a colour that had to move reports how far, so the reader can be told', () => {
  const r = SP.resolve({ id: 'custom', gain: '#ffff00', loss: '#ff00ff' }, 'light');
  assert.ok(r.adjusted.gain > 0, 'yellow on white is 1.07:1 and must have moved');
  assert.strictEqual(r.asked.gain, '#ffff00', 'and what was asked for is still reported');
  assert.ok(SP.ratio(r.gain, '#ffffff') >= 4.5);
});

// ── refusing to break ────────────────────────────────────────────────────────

test('nonsense falls back to Classic, never to no colour at all', () => {
  // A page with no gain colour is worse than a page with the default one.
  for (const bad of [null, undefined, {}, { id: 'nope' }, { id: 'custom' },
    { id: 'custom', gain: 'rgb(1,2,3)', loss: '#fff' }, { id: 'custom', gain: '', loss: '' },
    { id: 'custom', gain: 'javascript:alert(1)', loss: '#000000' }]) {
    const r = SP.resolve(bad, 'dark');
    assert.match(r.gain, /^#[0-9a-f]{6}$/, JSON.stringify(bad) + ' produced ' + r.gain);
    assert.match(r.loss, /^#[0-9a-f]{6}$/);
    assert.ok(minRatio(r.gain, surfacesFor(r, 'gain')) >= 4.5);
  }
  assert.strictEqual(SP.resolve({ id: 'nope' }, 'dark').id, 'classic');
});

test('an unknown theme is treated as dark rather than as an error', () => {
  const r = SP.resolve({ id: 'classic' }, 'chartreuse');
  assert.strictEqual(r.theme, 'dark');
});

// ── scope: what it is allowed to change ──────────────────────────────────────

test('it sets the money tokens and nothing else', () => {
  /* A preference about gains and losses is about gains and losses. The brand accent and
     site.css's status pills are not profit — the green in "live" means live. */
  const vars = SP.cssVars(SP.resolve({ id: 'colourblind' }, 'dark'));
  assert.deepStrictEqual(Object.keys(vars).sort(),
    ['--green', '--red', '--tint-neg', '--tint-pos']);
  /* --danger was on this list once, because the Kalshi terminal names the loss side that
     way. It paints the delete-account button and the offline dot in site.css, and a
     magenta Delete button was the proof that "the loss colour" and "the destructive
     colour" are not the same idea. Kalshi reads --red with --danger as its fallback. */
  for (const forbidden of ['--danger', '--accent', '--accent-dim', '--accent-strong',
    '--on-tint-accent', '--gold', '--text0', '--text1', '--text2', '--bg0', '--bg1', '--border']) {
    assert.ok(!(forbidden in vars), forbidden + ' is not a gain/loss colour');
  }
});

test('Classic removes the overrides rather than restating them', () => {
  /* So a page with its own palette — the Kalshi phosphor skin — keeps what it chose when
     the reader has expressed no preference. An override that merely repeated the default
     would silently overwrite that. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'signal-palette.js'), 'utf8');
  assert.match(src, /if \(r\.id === 'classic'\) el\.style\.removeProperty\(k\);/);
});

// ── how it is loaded ─────────────────────────────────────────────────────────

test('every page that shows money loads it in the HEAD, before paint', () => {
  /* theme-toggle.js sits at the end of the body, which is fine for an attribute and not
     for a colour: the reader would see the default green and watch it change. */
  for (const page of ['journal.html', 'stock-trader.html', 'watch.html', 'kalshi-terminal.html', 'settings.html']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', page), 'utf8');
    const tag = src.indexOf('/js/signal-palette.js');
    const headEnd = src.indexOf('</head>');
    assert.ok(tag > 0, page + ' does not load the palette');
    assert.ok(tag < headEnd, page + ' loads the palette after </head>, which will flash');
    assert.ok(!/defer|async/.test(src.slice(Math.max(0, tag - 90), tag + 40)),
      page + ' defers it, which re-introduces the flash');
  }
});

test('the stored choice is small, and a private window does not break the page', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'signal-palette.js'), 'utf8');
  // Every localStorage touch is wrapped — a browser set to block site data still renders.
  const touches = (src.match(/localStorage\./g) || []).length;
  const guards = (src.match(/try \{/g) || []).length;
  assert.ok(touches > 0 && guards >= 3, touches + ' storage touches, ' + guards + ' try blocks');
  assert.strictEqual(SP.STORAGE_KEY, 'lantern-signals');
});

test('the Kalshi terminal follows the preference without --danger being hijacked', () => {
  // var(--red, var(--danger)): the preference when there is one, the phosphor skin's own
  // loss colour when there is not. Neither path touches the destructive-action colour.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'kalshi-terminal.html'), 'utf8');
  assert.ok(src.indexOf('var(--red, var(--danger))') > 0, 'kalshi does not read --red first');
  assert.doesNotMatch(src, /[^,(\s]var\(--danger\)/, 'a bare var(--danger) is left, which the preference cannot reach');
});

test('a page that loads the palette does not style destructive UI with a money token', () => {
  /* settings.html painted its delete button, its error line and its "Delete account"
     heading with var(--red) -- a token no stylesheet defined, so they had been quietly
     inheriting. Defining --red for gains and losses turned a Delete button the loss
     colour, which is how it surfaced. --danger is the token that means destructive. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings.html'), 'utf8');
  assert.doesNotMatch(src, /var\(--red\)/,
    'settings.html styles something with the gain/loss token');
  assert.match(src, /\.btn\.danger \{ color: var\(--danger\)/);
});
