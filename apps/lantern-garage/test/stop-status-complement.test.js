'use strict';
/**
 * stop-status-complement.test.js — the re-protect cap must bound accumulation
 * for ANY status the broker reports, not just the failure words we knew (#3352).
 *
 * 2026-08-18 04:00 live: QQQ held 80 shares behind 1,200 shares of resting stops
 * and SPY 75 behind 1,125 — exactly 15 duplicates each, while
 * REPROTECT_MAX_ATTEMPTS was 3. The cap recognised failure by ALLOWLIST
 * (/inactive|reject|needs_confirm/), so a status in neither vocabulary was
 * invisible twice over: not WORKING, so the pass placed another stop; not a
 * known failure, so the cap never counted it. Had one triggered, IBKR either
 * sells shares we don't own — a short, on a longs-only strategy — or rejects and
 * leaves the position naked.
 *
 * Classification is now by complement: WORKING, else TERMINAL (lifecycle), else
 * FAILED. Unknown lands in FAILED, which is the safe side.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { _isFailedStop, _STOP_WORKING, _STOP_TERMINAL } = require('../lib/auto-trader');

test('the 2026-08-18 hole: an EMPTY or ABSENT status counts as a failed placement', () => {
  assert.strictEqual(_isFailedStop(''), true, 'empty status must trip the cap, not slip past it');
  assert.strictEqual(_isFailedStop(undefined), true);
  assert.strictEqual(_isFailedStop(null), true);
});

test('an UNSEEN broker status counts as failed — the allowlist could not do this', () => {
  for (const s of ['ApiWeirdState', 'Suspended', 'Untransmitted', 'Zzz'])
    assert.strictEqual(_isFailedStop(s), true, `${s} must count`);
});

test('the known failure vocabulary still counts (no regression)', () => {
  for (const s of ['Inactive', 'Rejected', 'needs_confirmation', 'needs-confirm'])
    assert.strictEqual(_isFailedStop(s), true, `${s} must still count`);
});

test('WORKING stops are never failures', () => {
  for (const s of ['Submitted', 'PreSubmitted', 'PendingSubmit', 'Open', 'Accepted', 'Working', 'Held'])
    assert.strictEqual(_isFailedStop(s), false, `${s} is protection, not a failure`);
});

test('the 2026-08-10 regression guard: our OWN cancels and fills are lifecycle, not failures', () => {
  // Counting these is what refused re-protection for a whole session (149 rows,
  // IWM and SOXL ran naked-stop stretches). They must stay uncounted.
  for (const s of ['Cancelled', 'ApiCancelled', 'Filled', 'PendingCancel', 'Expired'])
    assert.strictEqual(_isFailedStop(s), false, `${s} must NOT count toward the cap`);
});

test('the two vocabularies never both claim a status', () => {
  for (const s of ['Submitted', 'Cancelled', 'Filled', 'Inactive', 'Rejected', '', 'Mystery']) {
    const w = _STOP_WORKING.test(String(s || '')), t = _STOP_TERMINAL.test(String(s || ''));
    assert.ok(!(w && t) || /pending/i.test(String(s)), `${s} is claimed by both`);
  }
});

test('PendingCancel resolves as in-flight, not as a failure', () => {
  // It matches both vocabularies; WORKING is checked first, so it is not a failure.
  assert.strictEqual(_isFailedStop('PendingCancel'), false);
});

test('15 unknown-status duplicates would now trip a cap of 3', () => {
  const orders = Array.from({ length: 15 }, () => ({ symbol: 'QQQ', orderType: 'STP', side: 'SELL', status: '' }));
  const failed = orders.filter((o) => _isFailedStop(o.status)).length;
  assert.strictEqual(failed, 15, 'the live shape is now visible to the cap');
  assert.ok(failed >= 3, 'cap of 3 trips — no 16th stop is added');
});
