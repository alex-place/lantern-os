'use strict';
/**
 * lib/scan-window.js — the trading window of ONE scan pass, decided when the pass hands its scan to the brain.
 *
 * AFTER THE BELL (2026-10-02). The server's scan loop (routes/trading.js _autoscanTick) and the engine runner
 * (scripts/two-sleeve-runner.js) read "regular session or not" when a tick STARTS, then scan (tens of seconds) and
 * only then call the brain. On Friday 2026-10-02 stable's tick began at 15:59:5x, its scan finished after the bell,
 * and the brain ran at 16:00:23 still marked regular-session: the 15:00-16:00 entry block had just ended, the 16:00
 * entry-cadence window had just opened, and it bought 1,143 TLT ten minutes after its own weekend flat (a market order
 * IBKR queued for Monday's open). Re-read the window per pass: a pass that STARTED inside the regular session but
 * reaches the brain outside it runs protective-only (held positions keep their price-threshold exits, routed as
 * extended-hours orders; no entries, no signal exits), unless the operator's full extended trading is on, whose own
 * rules then apply. Every other pass keeps the window the tick started with.
 */

/**
 * @param {object} p
 * @param {boolean} p.startedInSession  the tick began inside the regular session (09:30-16:00 ET, Mon-Fri)
 * @param {boolean} p.inSessionNow      the regular session is still open now, as the pass reaches the brain
 * @param {boolean} [p.extNow]          full extended trading is on and this is the extended session
 * @param {boolean} [p.extManageNow]    the protective-only extended window the tick started in
 * @returns {{ extended: boolean, protectiveOnly: boolean, afterBell: boolean }}
 */
function passWindow({ startedInSession, inSessionNow, extNow = false, extManageNow = false } = {}) {
  if (startedInSession && !inSessionNow) return { extended: true, protectiveOnly: !extNow, afterBell: true };
  return { extended: !startedInSession, protectiveOnly: !!extManageNow, afterBell: false };
}

module.exports = { passWindow };
