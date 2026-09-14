'use strict';
/**
 * test/settings-dark-button.test.js — the settings page's primary buttons are readable in
 * dark mode (QA, 2026-09-14).
 *
 * site.css paints the dark accent light (cyan) and gives its own .btn-primary dark text
 * there; the settings page's `.btn.primary` kept white text: 2.4:1 on the Save buttons
 * and the selected palette chip.
 *
 * Run: node --test apps/lantern-garage/test/settings-dark-button.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', 'public');
const PAGE = fs.readFileSync(path.join(PUB, 'settings.html'), 'utf8');
const SITE = fs.readFileSync(path.join(PUB, 'css', 'site.css'), 'utf8');

const hex = (s) => { const m = s.replace('#', ''); const n = parseInt(m.length === 3 ? m.split('').map((c) => c + c).join('') : m, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// A variable's value inside a CSS block.
const varIn = (block, name) => { const m = block.match(new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{3,6})')); return m && m[1]; };
const darkBlock = SITE.slice(SITE.indexOf('[data-theme="dark"] {'), SITE.indexOf('}', SITE.indexOf('[data-theme="dark"] {')));
const lightBlock = SITE.slice(SITE.indexOf(':root {'), SITE.indexOf('}', SITE.indexOf(':root {')));

test('dark mode gives the settings primary button dark text on the accent', () => {
  assert.match(PAGE, /\[data-theme="dark"\] \.btn\.primary \{ color: var\(--bg\); \}/);
  const accent = varIn(darkBlock, 'accent-strong'), bg = varIn(darkBlock, 'bg');
  assert.ok(accent && bg, 'site.css dark variables found');
  assert.ok(ratio(hex(bg), hex(accent)) >= 4.5, 'dark text on the dark accent: ' + ratio(hex(bg), hex(accent)).toFixed(2));
  // And the old pairing really was the problem.
  assert.ok(ratio([255, 255, 255], hex(accent)) < 3, 'white on the dark accent was ' + ratio([255, 255, 255], hex(accent)).toFixed(2));
});

test('light mode keeps white text on the light accent, which already passes', () => {
  assert.match(PAGE, /\.btn\.primary \{ background: var\(--accent-strong\); border: none; color: #fff; \}/);
  const accent = varIn(lightBlock, 'accent-strong');
  assert.ok(accent, 'site.css light accent found');
  assert.ok(ratio([255, 255, 255], hex(accent)) >= 4.5, 'white on the light accent: ' + ratio([255, 255, 255], hex(accent)).toFixed(2));
});
