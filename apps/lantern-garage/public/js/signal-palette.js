/**
 * signal-palette.js — the colours gains and losses are drawn in (#3589).
 *
 * Green-up/red-down is a convention, not a law, and it is the worst possible pairing for
 * the ~1 in 12 men with red-green colour blindness: the two things a trading page most
 * needs to tell apart are exactly the two they cannot. Everyone else simply has taste.
 * So the reader picks — a preset, or any two colours they like.
 *
 * A COLOUR PICKER CAN UNDO EVERY CONTRAST FIX IN THE PRODUCT, which #3577, #3583, #3584
 * and #3587 spent real effort putting in. So a chosen colour is not used as given: its
 * HUE is kept, and its LIGHTNESS is walked toward the theme until it clears 4.5:1 against
 * every surface it can land on, including the wash of itself that pills and heatmap cells
 * paint behind it. The reader gets the colour they asked for and can still read it; when
 * we move one we say so rather than quietly substituting.
 *
 * Nothing here touches the brand accent or the status pills. A preference about gains and
 * losses is about gains and losses; the green in "live" is not a profit.
 *
 * One file, two runtimes: the browser loads it in <head> (before paint, so there is no
 * flash of the default palette) and the tests require it. Duplicating the arithmetic into
 * a second copy is how the two would drift.
 */
(function (root, factory) {
  let api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.SignalPalette = api; api.applyStored(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  let STORAGE_KEY = 'lantern-signals';

  /* The surfaces a figure can sit on, per theme. Taken from the journal and trader
     palettes, which share them. Clearing the extreme clears the rest, but all four are
     checked because "the darkest one" is a fact that could change. */
  let SURFACES = {
    dark: ['#0a0c0f', '#111318', '#181c22', '#1f242d'],
    light: ['#f4f6fa', '#ffffff', '#eef1f6', '#e3e8f0'],
  };

  /* The alphas the pages actually paint a signal's own colour at, behind text in that
     same colour: chips, badges, hover states, the zone ladder. A new wash belongs here
     rather than being trusted to be light enough -- at 0.22 on the lightest dark surface
     the figure and its background are close enough to fail. */
  const WASH_ALPHAS = [0.06, 0.08, 0.10, 0.12, 0.20, 0.22];

  /* A preset is a pair of HUES with a reason. The lightness is decided per theme by the
     same code that handles a custom colour, so a preset cannot be readable while a custom
     colour is not — there is only one path. */
  let PRESETS = [
    { id: 'classic', name: 'Classic', gain: '#00d4aa', loss: '#ff5f6d',
      note: 'Green up, red down. What the page has always used.' },
    { id: 'colourblind', name: 'Colour-blind safe', gain: '#3b9eff', loss: '#ff8c42',
      note: 'Blue and orange. Red-green colour blindness affects about 1 in 12 men, and'
        + ' green/red is the one pairing it takes away.' },
    { id: 'muted', name: 'Muted', gain: '#5f9e86', loss: '#c47b7b',
      note: 'The same idea, quieter. For a page you look at all day.' },
    { id: 'mono', name: 'No colour', gain: '#9aa4b2', loss: '#9aa4b2', mono: true,
      note: 'One colour for both. Losses still carry their minus sign, so nothing is lost'
        + ' — some readers would rather the page did not shout.' },
  ];

  // ── colour maths ───────────────────────────────────────────────────────────
  function hexToRgb(hex) {
    let h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-f]{6}$/i.test(h)) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgbToHex(c) {
    return '#' + c.map(function (v) {
      let s = Math.max(0, Math.min(255, Math.round(v))).toString(16);
      return s.length === 1 ? '0' + s : s;
    }).join('');
  }
  function rgbToHsl(c) {
    let r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    let max = Math.max(r, g, b), min = Math.min(r, g, b);
    let l = (max + min) / 2, h = 0, s = 0;
    if (max !== min) {
      let d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, s * 100, l * 100];
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
    let c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    let t = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
      : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [(t[0] + m) * 255, (t[1] + m) * 255, (t[2] + m) * 255];
  }
  function luminance(c) {
    let a = c.map(function (v) {
      let s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }
  function contrast(a, b) {
    let x = luminance(a), y = luminance(b);
    if (y > x) { let t = x; x = y; y = t; }
    return (x + 0.05) / (y + 0.05);
  }
  let ratio = function (hexA, hexB) { return contrast(hexToRgb(hexA), hexToRgb(hexB)); };

  /**
   * The same hue, moved along lightness until it clears `min` on every surface.
   *
   * One direction only — darker on a light page, lighter on a dark one — so the result
   * is always the nearest readable version of what was asked for rather than something
   * on the other side of it. Returns how far it moved so the reader can be told.
   */
  function readable(hex, surfaces, min, direction, derive) {
    let rgb = hexToRgb(hex);
    if (!rgb) return null;
    let hsl = rgbToHsl(rgb);
    let step = direction === 'darker' ? -1 : 1;
    /* `derive` yields the surfaces that depend on the candidate ITSELF -- the washes the
       pages paint as color-mix(var(--green) 12%, surface), which move as the colour
       moves. A fixed tint was not enough: the dashboard writes a figure on a wash OF that
       figure at six alphas, and the pair can close to 3.1:1. Circular only in appearance,
       since each candidate is checked against the washes that candidate would produce. */
    let clears = function (c) {
      for (let i = 0; i < surfaces.length; i++) if (contrast(c, hexToRgb(surfaces[i])) < min) return false;
      if (derive) {
        let extra = derive(c);
        for (let j = 0; j < extra.length; j++) if (contrast(c, extra[j]) < min) return false;
      }
      return true;
    };
    for (let d = 0; d <= 100; d++) {
      let L = Math.max(0, Math.min(100, hsl[2] + step * d));
      /* Measure the QUANTISED colour, not the float one on the way to it. Checking the
         float and emitting the hex put 60 of 4800 fuzzed colours at 4.48-4.50 -- passing
         the test inside the loop and failing as rendered. Whatever is emitted is what
         gets measured. */
      let c = hexToRgb(rgbToHex(hslToRgb(hsl[0], hsl[1], L)));
      if (clears(c)) return { hex: rgbToHex(c), moved: d, ok: true };
      /* Only once the walk has actually MOVED. At d === 0 this is the colour as asked,
         and a reader who picks pure white or pure black starts at an extreme -- so this
         broke out before trying a single step and handed back the far end instead.
         White on a light chart became black rather than the mid-grey one step down.
         The two most obvious picks in a colour picker were the two it could not fix. */
      if (d > 0 && (L === 0 || L === 100)) break;
    }
    // Nowhere on this hue's lightness axis works. Hand back the extreme and say so; the
    // caller reports it rather than pretending the choice was honoured.
    let end = hslToRgb(hsl[0], hsl[1], direction === 'darker' ? 0 : 100);
    return { hex: rgbToHex(end), moved: null, ok: false };
  }

  /** The wash a figure is sometimes drawn on: the same hue, pushed away from the text. */
  function tintFor(hex, theme) {
    let hsl = rgbToHsl(hexToRgb(hex) || [128, 128, 128]);
    return theme === 'light'
      ? rgbToHex(hslToRgb(hsl[0], Math.min(hsl[1], 60), 93))
      : rgbToHex(hslToRgb(hsl[0], Math.min(hsl[1], 55), 15));
  }

  /**
   * Two signals are only useful if a reader can tell them apart FROM EACH OTHER, which is
   * a different question from whether each is readable on the page. Green and red both
   * clear AA against white and are still the pairing that fails a colour-blind reader.
   *
   * Hue distance is the honest measure here; a contrast ratio between two mid-tones can
   * be 1.0 while they look nothing alike, and vice versa.
   */
  function distinguishable(gain, loss) {
    let a = rgbToHsl(hexToRgb(gain)), b = rgbToHsl(hexToRgb(loss));
    let dh = Math.abs(a[0] - b[0]); if (dh > 180) dh = 360 - dh;
    return { hueDistance: Math.round(dh), ratio: +ratio(gain, loss).toFixed(2), ok: dh >= 40 };
  }

  let byId = function (id) {
    for (let i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
    return null;
  };

  /**
   * A stored choice → the tokens a page should set.
   *
   * `choice` is { id } for a preset, or { id:'custom', gain, loss }. Anything unreadable
   * or unparseable falls back to Classic rather than to nothing: a page with no gain
   * colour at all is worse than a page with the default one.
   */
  function resolve(choice, theme) {
    theme = theme === 'light' ? 'light' : 'dark';
    let want = choice && choice.id === 'custom'
      ? { id: 'custom', name: 'Custom', gain: choice.gain, loss: choice.loss }
      : (byId(choice && choice.id) || PRESETS[0]);
    if (!hexToRgb(want.gain) || !hexToRgb(want.loss)) want = PRESETS[0];

    let dir = theme === 'light' ? 'darker' : 'lighter';
    let surfaces = SURFACES[theme].slice();
    // The wash is decided from the hue as asked, so it does not chase the adjustment —
    // then the figure has to clear on it too, which is the case the heatmap and the pills
    // actually render.
    let gainTint = tintFor(want.gain, theme);
    let lossTint = tintFor(want.loss, theme);
    /* Every wash the figure can be written on: the TINT at each alpha, over each surface.
       Deliberately the tint and not the figure itself. Deriving the wash from the figure
       was the obvious first move and it is wrong -- background and foreground then share a
       hue and converge, which dragged Classic from the #00d4aa/#cf0012 the stylesheets
       ship down to #005a48/#9c000e just to stay legible against itself. The tint is a
       separate colour for exactly this reason (#3577), and with it the shipped palette
       clears everywhere unchanged. */
    let washesOf = function (tintHex) {
      return function () {
        let out = [], t = hexToRgb(tintHex);
        for (let i = 0; i < WASH_ALPHAS.length; i++) {
          for (let j = 0; j < surfaces.length; j++) {
            let bg = hexToRgb(surfaces[j]), a = WASH_ALPHAS[i];
            out.push([t[0] * a + bg[0] * (1 - a), t[1] * a + bg[1] * (1 - a), t[2] * a + bg[2] * (1 - a)]);
          }
        }
        return out;
      };
    };
    let g = readable(want.gain, surfaces.concat([gainTint]), 4.5, dir, washesOf(gainTint));
    let l = readable(want.loss, surfaces.concat([lossTint]), 4.5, dir, washesOf(lossTint));

    return {
      id: want.id,
      name: want.name,
      theme: theme,
      gain: g.hex, loss: l.hex,
      gainTint: gainTint, lossTint: lossTint,
      asked: { gain: want.gain, loss: want.loss },
      // How far each had to move, in lightness points. 0 means it was used as chosen.
      adjusted: { gain: g.moved, loss: l.moved },
      unreachable: !g.ok || !l.ok,
      distinct: want.mono ? { mono: true, ok: true } : distinguishable(g.hex, l.hex),
    };
  }

  /* The tokens a page reads for GAIN and LOSS, and only those.
     Deliberately NOT --accent (brand), not site.css's pill colours (status: the green in
     "live" is not a profit), and NOT --danger -- which in site.css means DESTRUCTIVE and
     paints the delete-account button and the offline dot. Overriding it turned those the
     loss colour, which is the same category error one step further on. The Kalshi
     terminal reads --red with --danger as its fallback, so it follows the preference
     without dragging the rest of the product along. */
  function cssVars(r) {
    return {
      '--green': r.gain, '--red': r.loss,
      '--tint-pos': r.gainTint, '--tint-neg': r.lossTint,
    };
  }

  // ── storage + application ──────────────────────────────────────────────────
  function read() {
    try {
      let raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { id: 'classic' };
      let v = JSON.parse(raw);
      return (v && typeof v === 'object') ? v : { id: 'classic' };
    } catch (e) { return { id: 'classic' }; }
  }
  function write(choice) {
    try {
      if (!choice || choice.id === 'classic') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
    } catch (e) { /* private window: the choice lasts for this page and no longer */ }
  }

  function apply(choice, theme) {
    if (typeof document === 'undefined') return null;
    let el = document.documentElement;
    if (!theme) theme = el.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    let r = resolve(choice, theme);
    let vars = cssVars(r);
    // Classic is what the stylesheets already say, so it REMOVES the overrides rather
    // than restating them — a page's own palette (the Kalshi phosphor skin) then keeps
    // whatever it chose for itself.
    for (let k in vars) {
      if (!Object.prototype.hasOwnProperty.call(vars, k)) continue;
      if (r.id === 'classic') el.style.removeProperty(k);
      else el.style.setProperty(k, vars[k]);
    }
    el.setAttribute('data-signals', r.id);
    return r;
  }

  function applyStored() {
    try { return apply(read()); } catch (e) { return null; }
  }

  /**
   * The account's choice, arriving after paint (#3592).
   *
   * The device's own copy is applied first, from <head>, so the page paints correctly
   * with no flash. This is the second half: when the session resolves and the account
   * says something different — a new browser, a phone, a machine where the reader has
   * never set it — that wins, and is written down locally so the next load is instant.
   *
   * Same-value is a no-op rather than a repaint, which is the common case by far.
   */
  function adopt(serverChoice) {
    if (!serverChoice || typeof serverChoice !== 'object') return null;
    const local = read();
    const same = JSON.stringify(normalise(local)) === JSON.stringify(normalise(serverChoice));
    if (same) return null;
    write(serverChoice);
    return applyStored();
  }
  // Compared on the fields that MATTER, so a stray key or a different property order
  // does not cause a pointless repaint on every page load.
  function normalise(c) {
    if (!c || typeof c !== 'object') return { id: 'classic' };
    return c.id === 'custom'
      ? { id: 'custom', gain: String(c.gain || '').toLowerCase(), loss: String(c.loss || '').toLowerCase() }
      : { id: String(c.id || 'classic') };
  }

  /* The lightness walk is per theme, so a theme change has to re-run it. Pages toggle the
     theme by setting data-theme, which this watches rather than asking every caller to
     remember. */
  function watchTheme() {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    new MutationObserver(function (muts) {
      for (let i = 0; i < muts.length; i++) {
        if (muts[i].attributeName === 'data-theme') { applyStored(); return; }
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchTheme);
    else watchTheme();
  }

  return {
    PRESETS: PRESETS, SURFACES: SURFACES, STORAGE_KEY: STORAGE_KEY,
    resolve: resolve, readable: readable, tintFor: tintFor, distinguishable: distinguishable,
    WASH_ALPHAS: WASH_ALPHAS,
    cssVars: cssVars, apply: apply, applyStored: applyStored, adopt: adopt, normalise: normalise,
    read: read, write: write,
    ratio: ratio, hexToRgb: hexToRgb, rgbToHex: rgbToHex, rgbToHsl: rgbToHsl, hslToRgb: hslToRgb,
  };
}));
