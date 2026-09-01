'use strict';
/**
 * stale-peak-cleared.test.js — the SOXL ghost peak (live 2026-08-31).
 *
 * _peak/_trough only ever grow against their existing value, and the
 * feed-visible fill reconciler (_reconcileFills — the road most protective
 * stops travel) cleared intent/excursion but NOT the excursion maps or the
 * entry clocks. Friday's SOXL peak ($118.08) survived two stop fills and a
 * weekend; Monday's fresh entry at $112.01 was trail-cut at −$878 for a
 * "give-back +5.4% from peak" this position never came near (its real high:
 * +0.2%; its journaled mfe: 5.42% — the ghost, provable from the ledger).
 *
 * Pins: a reconciled fill deletes ALL per-position state for the symbol —
 * peak, trough, entryAt, holdClockAt — while the fill row itself still carries
 * the excursions it froze (the row is built before the cleanup runs).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpeak-'));
process.env.TRADER_TRADES_LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_STATE_FILE = path.join(DIR, 'state.json');
const at = require('../lib/auto-trader');

const FILL = (sym, id) => ({
  orderId: id, symbol: sym, side: 'SELL', qty: 10, filledQty: 10,
  status: 'filled', orderType: 'Stop', price: 111, avgPrice: 111.0,
  time: new Date().toISOString(),
});

test('a reconciled broker fill clears the per-position excursion state', () => {
  // poison the maps the way Friday's stop fills left them
  at._peak.set('SOXL', 118.08);
  at._trough.set('SOXL', 108.0);
  at._entryAtSet('SOXL', Date.now() - 86400000);
  at._holdClockAt.set('SOXL', Date.now() - 86400000);

  at._reconcileFills([FILL('SOXL', 'ghost-1')]);

  assert.strictEqual(at._peak.has('SOXL'), false, 'peak must die with the position');
  assert.strictEqual(at._trough.has('SOXL'), false, 'trough must die with the position');
  assert.strictEqual(at._holdClockAt.has('SOXL'), false, 'hold clock must die with the position');
  at._saveState();
  const st = JSON.parse(fs.readFileSync(process.env.TRADER_STATE_FILE, 'utf8'));
  assert.ok(!(st.entryAt && 'SOXL' in st.entryAt), 'entryAt must die with the position');
  assert.ok(!(st.peak && 'SOXL' in st.peak), 'a stale peak must not persist across restarts');
});

test('the fill row still carries the excursions it froze — cleanup runs after the row is built', () => {
  at._peak.set('TNA', 80.0);
  at._trough.set('TNA', 70.0);
  at._reconcileFills([FILL('TNA', 'ghost-2')]);
  const rows = fs.readFileSync(process.env.TRADER_TRADES_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const row = rows.reverse().find((r) => r.event === 'exit' && r.symbol === 'TNA');
  assert.ok(row, 'the exit row was written');
  assert.ok(row.mfe_pct !== undefined || row.mae_pct !== undefined, 'excursion fields rode the row');
  assert.strictEqual(at._peak.has('TNA'), false, 'and the map is clean afterwards');
});

test('an unrelated symbol is untouched by another symbol\'s fill', () => {
  at._peak.set('GLD', 420.0);
  at._reconcileFills([FILL('SMH', 'ghost-3')]);
  assert.strictEqual(at._peak.get('GLD'), 420.0, 'GLD\'s live position keeps its high-water mark');
  at._peak.delete('GLD');
});
