'use strict';

/**
 * exit-warnings.test.js — risk-reducing sells must clear IBKR order warnings.
 *
 * 2026-07-27, first fully-armed session: the engine made 13 correct exit decisions
 * (take-profit, max-loss, momentum-died, trailing stop, signal exit) and executed
 * ZERO of them — every order came back `needs_confirmation` because IBKR returned
 * warnings and the code refused to confirm them. A max-loss sell decided at -16.9%
 * was still open at -18.9%; an AMD take-profit at +3.9% gave the whole gain back
 * (-3.7%). The original refusal (P0-8) exists to stop blind click-through on
 * ENTRIES; it must not strand exits.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const AT = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auto-trader.js'), 'utf8');
const BR = fs.readFileSync(path.join(__dirname, '..', 'lib', 'trading-api-bridge.js'), 'utf8');
const CP = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ibkr-cpapi.js'), 'utf8');

test('the bridge threads acceptWarnings down to the IBKR order call', () => {
  assert.match(BR, /placeIBKROrder\(userId, \{[^)]*acceptWarnings/, 'bridge accepts the flag');
  assert.match(BR, /acceptWarnings: !!acceptWarnings/, 'bridge forwards it to placeOrder');
  assert.match(CP, /acceptWarnings = false/, 'cpapi still DEFAULTS to refusing (opt-in only)');
});

test('every engine SELL (exit + protective stop) opts into clearing warnings', () => {
  // The primary exit helper, the signal-exit path, and both protective-stop places.
  const sells = AT.match(/side: 'sell'[^}]*\}/g) || [];
  assert.ok(sells.length >= 4, `expected the known sell sites, found ${sells.length}`);
  for (const s of sells) {
    assert.match(s, /acceptWarnings: true/, `a sell order is missing acceptWarnings: ${s.slice(0, 90)}`);
  }
});

test('ENTRIES do NOT auto-accept warnings (P0-8 intent preserved)', () => {
  // Buy orders must still surface IBKR warnings for a human — that is the whole
  // point of the original guard (size-vs-ADV, margin, price-cap on new risk).
  const buys = AT.match(/side: 'buy'[^}]*\}/g) || [];
  for (const b of buys) {
    assert.doesNotMatch(b, /acceptWarnings/, `an ENTRY must not auto-confirm warnings: ${b.slice(0, 90)}`);
  }
});
