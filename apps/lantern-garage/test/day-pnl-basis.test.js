'use strict';

/**
 * day-pnl-basis.test.js — Day P&L must be TODAY's P&L (2026-08-08).
 *
 * Two live inaccuracies, both reported by the operator as "the P&L is wrong":
 *
 * 1. UTC day roll: "today" was the UTC date, so from 20:00 ET the realized
 *    filter looked for fills dated tomorrow and the session's realized losses
 *    vanished from the figure at midnight UTC.
 * 2. Since-entry unrealized: with positions carried overnight, adding full
 *    since-entry unrealized re-counts every prior day's move each new day.
 *    Correct: today-opened → mark − entry; carried → mark − prevClose.
 *
 * Pure mirrors of the production expressions in routes/trading/market.js.
 */

const test = require('node:test');
const assert = require('node:assert');

const etDay = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

test('a Friday 19:36 ET fill still belongs to Friday after midnight UTC', () => {
  const fill = Date.parse('2026-08-07T23:36:08Z');          // 19:36 ET Friday
  const saturdayNightUtc = Date.parse('2026-08-08T04:43:00Z'); // 00:43 ET Saturday
  assert.strictEqual(etDay(fill), '2026-08-07');
  assert.strictEqual(etDay(saturdayNightUtc), '2026-08-08');
  // The UTC comparison that produced the bug: at 20:01 ET Friday, UTC is
  // already the 8th — the fill's UTC date still matches, so realized survives
  // the evening; the OLD code compared against the UTC "today" and dropped it.
  const fridayEvening = Date.parse('2026-08-08T00:01:00Z');  // 20:01 ET Friday
  assert.strictEqual(etDay(fridayEvening), '2026-08-07', 'evening is still the same ET session');
});

// Mirror of the per-position contribution rule.
function contribution(p, enteredToday, prevClose) {
  const qty = Number(p.qty) || 0, cur = Number(p.current_price) || 0;
  if (!enteredToday && prevClose > 0 && cur > 0 && qty) return (cur - prevClose) * qty;
  return Number(p.unrealized_pl) || 0;
}

test('a position opened TODAY contributes its move since entry', () => {
  const p = { qty: 39, current_price: 723.0, unrealized_pl: (723.0 - 721.68) * 39 };
  assert.ok(Math.abs(contribution(p, true, 719.0) - 51.48) < 0.01);
});

test('a CARRIED position contributes only today\'s move, not its whole life', () => {
  // IWM carried from Friday: entered 300.59, prev close 301.56, mark 302.10.
  const p = { qty: 191, current_price: 302.10, unrealized_pl: (302.10 - 300.59) * 191 }; // +288 since entry
  const c = contribution(p, false, 301.56);
  assert.ok(Math.abs(c - (302.10 - 301.56) * 191) < 0.01, 'only the +0.54 move today counts');
  assert.ok(c < Number(p.unrealized_pl), 'must not re-count Friday\'s gain on Saturday');
});

test('no prevClose available → honest fallback to since-entry (never zero, never invented)', () => {
  const p = { qty: 10, current_price: 100, unrealized_pl: 40 };
  assert.strictEqual(contribution(p, false, 0), 40);
});

test('weekend shape: no ET fills today + flat marks = Day P&L ~ 0', () => {
  // Saturday: realized(today ET)=0; carried positions mark == Friday close.
  const positions = [
    { qty: 191, current_price: 301.56, unrealized_pl: 185 },
    { qty: 153, current_price: 187.97, unrealized_pl: 78 },
  ];
  const prevClose = { 0: 301.56, 1: 187.97 };
  let unreal = 0;
  positions.forEach((p, i) => { unreal += contribution(p, false, prevClose[i]); });
  const dayPnl = 0 + unreal;
  assert.ok(Math.abs(dayPnl) < 0.01, 'a non-trading day reads ~$0, not the open positions\' lifetime P&L');
});
