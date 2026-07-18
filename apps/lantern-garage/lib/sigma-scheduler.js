'use strict';

/**
 * sigma-scheduler.js — runs the Sigma Trader on its own cadence (ADR-0028).
 *
 * The Sigma Trader is the long-horizon allocation book; it does NOT day-trade. This
 * scheduler drives it in two natural rhythms, both handled by ONE periodic check
 * because the rebalance's no-churn band self-regulates turnover:
 *   • slow drift  — momentum weights re-aim as daily bars roll → the band trips only
 *     when the book has drifted materially (≈ a monthly rebalance in calm markets).
 *   • the brake   — when brake-monitor's live gross steps down in a storm, the target
 *     dollars drop across the board → the band trips promptly → Sigma de-levers toward
 *     cash within the check interval, not weeks later. That fast reaction is the point.
 *
 * It ONLY acts when: the market is open (so orders fill, not queue), the engine is
 * armed (SIGMA_ARM=1), and Sigma has its OWN dedicated account. Otherwise it idles.
 * Independent of the day-trader's autoscan — different engine, different account, so
 * the two never contend. Kill switch: SIGMA_SCHEDULE unset/0 (off by default).
 */

const CHECK_MS = Math.max(60000, Number(process.env.SIGMA_SCHEDULE_MS) || 20 * 60000); // default 20 min
// Floor between ACTUAL rebalances so a jittery brake can't over-trade; a large gross
// move still de-levers on the very next check (the floor only gates repeat trades).
const MIN_GAP_MS = Math.max(0, Number(process.env.SIGMA_MIN_REBALANCE_MS) || 55 * 60000); // ~hourly

let _timer = null;
let _stopped = false;
let _lastRebalanceAt = 0;
let _last = { at: null, action: 'not started', orders: 0, gross: null, note: null };

/** US regular market hours (ET), Mon–Fri 09:30–16:00 — when orders fill immediately. */
function _marketOpen(now = new Date()) {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 570 && mins < 960;
}

function enabled() { return process.env.SIGMA_SCHEDULE === '1'; }
function armed() { return process.env.SIGMA_ARM === '1'; }

async function _tick() {
  if (_stopped) return;
  try {
    const sigma = require('./sigma-trader');
    if (!enabled()) { _last = { ..._last, at: new Date().toISOString(), action: 'schedule off (SIGMA_SCHEDULE!=1)' }; return; }
    if (!module.exports._marketOpen()) { _last = { ..._last, at: new Date().toISOString(), action: 'market closed — idle' }; return; }

    // Always compute the plan (cheap, read-only) so status shows the current drift.
    const plan = await sigma.plan().catch((e) => ({ ok: false, reason: e.message }));
    if (!plan || !plan.ok) { _last = { at: new Date().toISOString(), action: `plan failed: ${plan && plan.reason}`, orders: 0, gross: null }; return; }
    if (plan.account === 'not_configured') { _last = { at: new Date().toISOString(), action: 'no dedicated Sigma account — set SIGMA_ALPACA_*', orders: 0, gross: plan.gross }; return; }

    const nOrders = (plan.orders || []).length;
    if (!armed()) { _last = { at: new Date().toISOString(), action: `plan-only (SIGMA_ARM!=1) — ${nOrders} orders would rebalance`, orders: nOrders, gross: plan.gross, note: plan.note }; return; }
    if (!nOrders) { _last = { at: new Date().toISOString(), action: 'on-target — within no-churn band', orders: 0, gross: plan.gross }; return; }
    if (Date.now() - _lastRebalanceAt < MIN_GAP_MS) { _last = { at: new Date().toISOString(), action: `${nOrders} orders pending — holding for min-gap`, orders: nOrders, gross: plan.gross }; return; }

    const r = await sigma.rebalanceNow({ arm: true });
    _lastRebalanceAt = Date.now();
    const placed = (r.results || []).filter((o) => o.status === 'placed').length;
    _last = { at: new Date().toISOString(), action: `rebalanced — ${placed}/${(r.results || []).length} placed`, orders: placed, gross: r.gross, account: r.account };
    // eslint-disable-next-line no-console
    console.info(`[Sigma] rebalanced ${r.account} — ${placed} orders @ gross ${r.gross}x`);
  } catch (e) {
    _last = { at: new Date().toISOString(), action: `error: ${e.message}`, orders: 0, gross: null };
  } finally {
    if (!_stopped) _timer = setTimeout(_tick, CHECK_MS);
  }
}

function start() {
  if (_timer) return;                    // already running
  _stopped = false;
  _timer = setTimeout(_tick, 15000);     // first check shortly after boot
}
function stop() { _stopped = true; if (_timer) { clearTimeout(_timer); _timer = null; } }
function getStatus() {
  return { enabled: enabled(), armed: armed(), checkEveryMs: CHECK_MS, minGapMs: MIN_GAP_MS, marketOpen: _marketOpen(), last: _last };
}

module.exports = { start, stop, getStatus, _marketOpen, _tick };
