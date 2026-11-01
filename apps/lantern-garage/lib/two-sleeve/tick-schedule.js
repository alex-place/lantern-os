'use strict';
/**
 * tick-schedule.js — BAR-ALIGNED TICKS for the two-sleeve runner (2026-10-25, ledger
 * live-engine-bar-aligned-ticks-2026-10-26).
 *
 * The runner used to wait a flat TRADER_AUTOSCAN_MS (60 s) after each tick FINISHED, so its ticks drifted through the
 * minute (09:40:00, 09:41:08, 09:42:14 ...). Every scan reads a 5-minute bar only 20 s after it closes (SETTLE_MS in
 * closeibs-scan / noise-scan / overnight-scan), so a decision bar was acted on 20 s + U(0, ~65 s) + the tick's own work
 * after its close: the latency audit of the live fills 09-25..10-23 found orders 55-80 s after the price the replay
 * assumes. nextTickDelay() keeps the regular cadence but moves the next tick onto the next bar close + the 20 s settle
 * + a 2 s margin whenever that instant comes first, and ticks again at once when a tick ran across one (its scans read
 * the bars before that bar was readable).
 */
const BAR_MS = 5 * 60000;
const ALIGN_OFFSET_MS = 22000;   // bar close + the scans' 20 s settle + 2 s margin
const MISSED_DELAY_MS = 250;

/** The first bar-aligned instant (a 5-minute boundary + offset) strictly after `t`. */
function nextAligned(t, offset = ALIGN_OFFSET_MS) {
  return (Math.floor((t - offset) / BAR_MS) + 1) * BAR_MS + offset;
}

/**
 * The delay before the next tick. `nowMs` = when the tick just finished, `tickStartedMs` = when it began,
 * `regularMs` = the flat cadence (TRADER_AUTOSCAN_MS). Returns { delayMs, aligned, missed }:
 *   missed  a bar-aligned instant fell inside the tick -> tick again at once;
 *   aligned the next bar-aligned instant comes before the regular tick -> wait for it;
 *   else    the regular cadence, unchanged.
 */
function nextTickDelay(nowMs, tickStartedMs, regularMs, { offset = ALIGN_OFFSET_MS } = {}) {
  const last = nextAligned(nowMs, offset) - BAR_MS;   // the latest bar-aligned instant <= nowMs
  if (last > tickStartedMs && last <= nowMs) return { delayMs: MISSED_DELAY_MS, aligned: true, missed: true };
  const next = nextAligned(nowMs, offset);
  if (next < nowMs + regularMs) return { delayMs: Math.max(MISSED_DELAY_MS, next - nowMs), aligned: true, missed: false };
  return { delayMs: regularMs, aligned: false, missed: false };
}

module.exports = { nextTickDelay, nextAligned, BAR_MS, ALIGN_OFFSET_MS };
