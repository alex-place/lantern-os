'use strict';
/**
 * symbol-entry-window.test.js — TRADER_SYMBOL_ENTRY_BLOCK_ET (lab 2026-09-27): per-name ET
 * windows during which NEW entries of those names are skipped (live) or journaled (shadow,
 * the default). Pure helpers, default off; exits and stops untouched.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sew-'));
const LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_TRADES_LOG = LOG;
process.env.TRADER_STATE_FILE = path.join(DIR, 'state.json');
const at = require('../lib/auto-trader');

const SPEC = 'SOXL,TNA,SPXL,UPRO,TQQQ:09:30-13:00';

test('unset / empty spec blocks nothing', () => {
  assert.strictEqual(at._symbolEntryBlocked('SOXL', 11 * 60, undefined), null);
  assert.strictEqual(at._symbolEntryBlocked('SOXL', 11 * 60, ''), null);
  assert.strictEqual(at._symbolEntryBlocked('', 11 * 60, SPEC), null);
});

test('the lab window: leveraged index names blocked 09:30-12:59, open from 13:00; other names never', () => {
  assert.ok(at._symbolEntryBlocked('SOXL', 9 * 60 + 30, SPEC), 'SOXL 09:30 blocked');
  assert.ok(at._symbolEntryBlocked('tna', 12 * 60 + 59, SPEC), 'TNA 12:59 blocked (case-insensitive)');
  assert.strictEqual(at._symbolEntryBlocked('SOXL', 13 * 60, SPEC), null, 'SOXL 13:00 open (half-open window)');
  assert.strictEqual(at._symbolEntryBlocked('SMH', 11 * 60, SPEC), null, 'SMH is not in the spec');
  assert.strictEqual(at._symbolEntryBlocked('NUGT', 11 * 60, SPEC), null, 'leveraged commodities are not in the spec');
  assert.strictEqual(at._symbolEntryBlocked('UPRO', 11 * 60, SPEC).label, '09:30-13:00');
});

test('several groups, several windows, malformed groups dropped', () => {
  const spec = 'SOXL,TNA:09:30-13:00,15:00-16:00; GLD:10:00-11:00 ;junk;:09:30-10:00;XLE:15:00-14:00';
  const m = at._parseSymbolWindows(spec);
  assert.deepStrictEqual([...m.keys()].sort(), ['GLD', 'SOXL', 'TNA']);
  assert.deepStrictEqual(m.get('SOXL').map((w) => w.label), ['09:30-13:00', '15:00-16:00']);
  assert.ok(at._symbolEntryBlocked('SOXL', 15 * 60 + 30, spec), 'second window blocks');
  assert.strictEqual(at._symbolEntryBlocked('SOXL', 14 * 60, spec), null, 'between windows is open');
  assert.ok(at._symbolEntryBlocked('GLD', 10 * 60 + 30, spec));
  assert.strictEqual(at._symbolEntryBlocked('XLE', 14 * 60 + 30, spec), null, 'inverted window dropped');
});

test('journal: one row per name per hour, shadow and live event names, fields', () => {
  const win = at._symbolEntryBlocked('SOXL', 11 * 60 + 5, SPEC);
  const now = Date.parse('2026-09-28T15:05:00.000Z');   // 11:05 ET
  assert.strictEqual(at._symbolEntryBlockJournal('SOXL', 11 * 60 + 5, win, 'shadow', now), true, 'first row written');
  assert.strictEqual(at._symbolEntryBlockJournal('SOXL', 11 * 60 + 40, win, 'shadow', now + 35 * 60000), false, 'same hour deduped');
  assert.strictEqual(at._symbolEntryBlockJournal('SOXL', 12 * 60 + 5, win, 'live', now + 60 * 60000), true, 'next hour written');
  assert.strictEqual(at._symbolEntryBlockJournal('TNA', 11 * 60 + 5, win, 'shadow', now), true, 'another name written');
  const rows = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => /^symbol_entry_block/.test(r.event));
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].event, 'symbol_entry_block_shadow');
  assert.strictEqual(rows[1].event, 'symbol_entry_block');
  assert.deepStrictEqual({ symbol: rows[0].symbol, et_min: rows[0].et_min, window: rows[0].window, mode: rows[0].mode, would_block: rows[0].would_block },
    { symbol: 'SOXL', et_min: 665, window: '09:30-13:00', mode: 'shadow', would_block: true });
});
