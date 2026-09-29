'use strict';
/**
 * cadence-survives-restart.test.js — a spent entry bar survives a restart (2026-09-29).
 *
 * The armed cadence is one entry decision per hour bar (TRADER_ENTRY_CADENCE_MIN=60): once an
 * entry places outside the three-minute window the bar is spent and every later candidate waits
 * for the next boundary. The mark that says "spent" lived in memory only.
 *
 * Live 2026-09-29, stable: IWM bought 14:07:22, TNA refused in the same scan ("already decided
 * this bar - next decision 15:00"); the server was rolled at 14:16 by a merge to master; at
 * 14:17:09 the fresh process bought 3,074 TNA as the "late first scan" of a bar it believed
 * nobody had decided.
 *
 * These pin: the mark is written to the state file the moment it is set; a process that starts
 * inside the same bar finds the bar spent; the next bar is open again; a mark from another
 * session blocks nothing; an in-window placement still spends nothing (the rest may compete);
 * a state file without the field loads as before; the test reset clears it.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-restart-'));
const STATE = path.join(DIR, 'state.json');
process.env.TRADER_TRADES_LOG = path.join(DIR, 'trades.jsonl');
process.env.TRADER_STATE_FILE = STATE;
const at = require('../lib/auto-trader');
const C = at._cadenceForTest;
const M = (h, m) => h * 60 + m;
const saved = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
/** What a restart does to the mark: memory is gone, the state file is read again. */
const restart = () => { C.forgetInMemory(); at._loadState(); };
/** The gate as the engine calls it: a mark from another ET day is not passed in. */
const gate = (etMin, day) => { const d = C.decided(); return at._entryCadenceBlocked(etMin, '60', '0', '3', d.day === day ? d.boundary : null); };

test('the mark is written to the state file the moment an entry spends the bar', () => {
  at._resetCooldowns();
  assert.deepStrictEqual(saved().cadenceDecided, { day: null, boundary: null }, 'a clean state says nothing is spent');
  C.setPending({ day: '2026-09-29', boundary: M(14, 0), since: 7, win: 3 });   // IWM, 14:07: past the window
  at._markCadenceDecided();
  assert.deepStrictEqual(C.decided(), { day: '2026-09-29', boundary: M(14, 0) });
  assert.deepStrictEqual(saved().cadenceDecided, { day: '2026-09-29', boundary: M(14, 0) }, 'on disk before anything else happens');
});

test('2026-09-29: the server restarts at 14:16 and TNA at 14:17 is still refused', () => {
  at._resetCooldowns();
  C.setPending({ day: '2026-09-29', boundary: M(14, 0), since: 7, win: 3 });
  at._markCadenceDecided();
  const before = gate(M(14, 7), '2026-09-29');
  assert.ok(before && before.why === 'decided', 'same scan, second candidate: refused');
  restart();
  assert.deepStrictEqual(C.decided(), { day: '2026-09-29', boundary: M(14, 0) }, 'the fresh process knows the bar is spent');
  const after = gate(M(14, 17), '2026-09-29');
  assert.ok(after && after.why === 'decided', 'the entry the restart let through');
  assert.strictEqual(after.label, '15:00');
});

test('without the mark the same scan would have decided: this is the hole', () => {
  at._resetCooldowns();
  assert.strictEqual(gate(M(14, 17), '2026-09-29'), null, 'a late first scan of an undecided bar is its decision');
});

test('the next bar is open again after a restart', () => {
  at._resetCooldowns();
  C.setPending({ day: '2026-09-29', boundary: M(13, 0), since: 12, win: 3 });   // SOXL, 13:12
  at._markCadenceDecided();
  restart();
  assert.ok(gate(M(13, 56), '2026-09-29'), '13:56 is refused');
  assert.strictEqual(gate(M(14, 7), '2026-09-29'), null, '14:07 belongs to the 14:00 bar, which nobody has decided');
});

test('a mark from another session blocks nothing', () => {
  at._resetCooldowns();
  C.setPending({ day: '2026-09-28', boundary: M(14, 0), since: 7, win: 3 });
  at._markCadenceDecided();
  restart();
  assert.strictEqual(C.decided().day, '2026-09-28', 'restored as written');
  assert.strictEqual(gate(M(14, 17), '2026-09-29'), null, 'the gate compares the ET day: yesterday is not today');
});

test('a placement INSIDE the window still spends nothing, so the rest of the scan competes', () => {
  at._resetCooldowns();
  C.setPending({ day: '2026-09-29', boundary: M(12, 0), since: 1, win: 3 });   // 12:01, inside the 3-minute window
  at._markCadenceDecided();
  assert.deepStrictEqual(C.decided(), { day: null, boundary: null });
  assert.deepStrictEqual(saved().cadenceDecided, { day: null, boundary: null });
});

test('a state file written before this field existed loads as before', () => {
  at._resetCooldowns();
  const o = saved(); delete o.cadenceDecided;
  fs.writeFileSync(STATE, JSON.stringify(o));
  restart();
  assert.deepStrictEqual(C.decided(), { day: null, boundary: null });
  for (const junk of [{ day: '2026-09-29' }, { day: null, boundary: 840 }, { day: '2026-09-29', boundary: 'x' }, 'spent', 7]) {
    fs.writeFileSync(STATE, JSON.stringify({ ...o, cadenceDecided: junk }));
    restart();
    assert.deepStrictEqual(C.decided(), { day: null, boundary: null }, 'ignored: ' + JSON.stringify(junk));
  }
});

test('boundary 0 is a boundary (a bar that starts at midnight is still a bar)', () => {
  at._resetCooldowns();
  fs.writeFileSync(STATE, JSON.stringify({ ...saved(), cadenceDecided: { day: '2026-09-29', boundary: 0 } }));
  restart();
  assert.deepStrictEqual(C.decided(), { day: '2026-09-29', boundary: 0 });
});
