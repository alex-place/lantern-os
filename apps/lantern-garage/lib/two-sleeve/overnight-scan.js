'use strict';
/**
 * lib/two-sleeve/overnight-scan.js — THE OVERNIGHT BOOK as an engine sleeve's SCAN (2026-10-09, DRAFT: not armed).
 *
 * The overnight index premium: most of an index fund's return accrues from the close to the next open, and the day-trader
 * is flat in exactly those hours, so one book of cash can serve both. Measured before this module existed (prediction
 * ledger tier0-overnight-index-hold-gated, tier1-overnight-book-engine-13-windows): SPY, QQQ and SMH held from the 15:55
 * print to the 09:40 print only when the name's prior close is above its trailing 200-session mean (held 77% of nights)
 * made 15.6%/yr alone across 2016-2026 with a Sharpe-like 1.64; summed with the armed design, 26.8%/yr with zero negative
 * calendar years, a worst week of -8 and a max drawdown of -23 (the design alone: 11.2%/yr, -3.7, -12.7). Through the
 * engine on the 13 recent windows: +0.647 vs +0.384%/wk, the other sleeves trade-for-trade unchanged, 16% of the entries
 * refused by ownership. The weekend nights are a fifth of the premium: this sleeve's env must NOT flatten on Fridays.
 *
 * This module only READS bars and says what the sleeve wants, in the signal shape the brains trade:
 *   - in the ENTRY WINDOW — the session's latest COMPLETED 5m bar being the 15:50 bar (closes 15:55; read from 15:55:20
 *     until 16:00 ET) — a name whose PRIOR session close is above its trailing trendN-session mean (daily bars, sessions
 *     before today) is BULLISH / ENTER; a name below, or without 120 sessions of history, is NEUTRAL;
 *   - in the SELL WINDOW — from the first read after the 09:35 bar closes (09:40:20 ET) until the entry window — every
 *     name is BEARISH / ENTER (the brain sells a held one; a name it does not hold is "bearish, no long to exit");
 *   - otherwise NEUTRAL / SKIP; no reading (no completed bar, no daily history) is NEUTRAL: a held name is held.
 * Every name is in every scan, so the feed guard never reads the sleeve as an absent symbol. The brain does the rest with
 * its own machinery; the sleeve's env must set TRADER_EOD_FLAT=off (weekends are held), TRADER_EOD_DECARRY=0, the entry
 * gates off (IBS max 1, no confirmation, no cadence, no hour block) and TRADER_MAX_HOLD_SESSIONS=1 as the backstop.
 *
 * SHADOW (TRADER_OVERNIGHT_SHADOW=1): the same reads, NEUTRAL signals, and journal rows instead of orders — one
 * `overnight_shadow` row per name at the first entry-window read (the gate, the prior close, the mean, the 15:55 price) and
 * one `overnight_shadow_exit` row at the first sell-window read (the 09:40 price and the overnight return), so the live
 * prints and the live gate can be scored before any arm.
 *
 * GREEN-EXIT SHADOW (TRADER_OVERNIGHT_GREEN_SHADOW=1, 2026-10-25, ledger live-engine-o-green-exit-shadow-2026-10-26):
 * journal rows only, never a signal change. The rule under test sells a held name at the 09:35 print when it is above
 * its overnight entry (the prior session's 15:55 print), else at the 09:40 print as armed today (replay: O win rate
 * +3.5..+4.3 points at an unchanged mean). One `overnight_green_shadow` row per name at the 09:35 read (the 09:30 bar
 * read 20 s after it closes) and one `overnight_green_shadow_close` row at the first sell-window read (both prices and
 * both returns). The entry price comes from the same 5m bars, so a runner restart overnight loses nothing.
 */
const { sessionBars, etOf } = require('../trend-shadow');

const BAR_MS = 5 * 60000;
const SETTLE_MS = 20000;                 // a bar is read 20 s after it closes (feed lag), as the other scans read it
const ENTRY_BAR = 950;                   // the 15:50 bar (closes 15:55)
const SELL_BAR = 575;                    // the 09:35 bar (closes 09:40)
const GREEN_BAR = 570;                   // the 09:30 bar (closes 09:35): the green-exit shadow's early read
const CLOSE_MIN = 960;                   // no entry decision at or after 16:00 ET
const TREND_N = 200;
const TREND_MIN = 120;                   // sessions of history needed before the gate reads at all

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const round = (x, d = 4) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const dayOf = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

function createOvernightScan({ symbols, getBars, trendN = TREND_N, entryBar = ENTRY_BAR, sellBar = SELL_BAR, shadow = false, greenShadow = false, log = null } = {}) {
  const S = [...new Set((Array.isArray(symbols) ? symbols : String(symbols || '').split(','))
    .map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  if (typeof getBars !== 'function') throw new Error('overnight scan: getBars(sym, tf) required');
  if (!(trendN >= TREND_MIN)) throw new Error(`overnight scan: trendN ${trendN} must be >= ${TREND_MIN}`);
  const logged = {};           // sym -> { entry: day, exit: day }
  const lastEntry = {};        // sym -> { day, px } (shadow: the 15:55 price the exit row is scored against)
  const loggedGreen = {};      // sym -> { early: day, close: day } (green-exit shadow)

  async function rawOf(sym, tf) { try { const r = await getBars(sym, tf); return (r && r.bars) || null; } catch (_e) { return null; } }

  /** The ET day of the latest regular session before `day` in the 5m bars, or null. */
  function priorSessionDay(raw, day) {
    let best = null;
    for (const b of raw || []) {
      const t = Date.parse(b.timestamp != null ? b.timestamp : b.t); if (!Number.isFinite(t)) continue;
      const x = etOf(t); if (x.day < day && x.min >= 570 && x.min < CLOSE_MIN && (!best || x.day > best)) best = x.day;
    }
    return best;
  }

  /** Green-exit shadow: the 09:35 read and the first sell-window read journal what the rule would do (see the header). */
  async function greenRead(sym, raw, e, last) {
    const early = last.min === GREEN_BAR;
    const sell = last.min >= sellBar && last.min < entryBar;
    if (!early && !sell) return;
    const G = loggedGreen[sym] = loggedGreen[sym] || {};
    if ((early && G.early === e.day) || (sell && G.close === e.day)) return;
    if (early) G.early = e.day; else G.close = e.day;
    const prevDay = priorSessionDay(raw, e.day); if (!prevDay) return;
    const ent = sessionBars(raw, prevDay).find((b) => b.min === entryBar); if (!ent) return;
    const today = sessionBars(raw, e.day);
    const b0935 = today.find((b) => b.min === GREEN_BAR) || null;
    const gate = await trendRead(sym, prevDay);   // what the entry window read the evening before (O held it only if above)
    const base = { symbol: sym, day: e.day, entry_day: prevDay, entry_px: round(ent.c), held_gate: gate ? gate.above : null, shadow: true };
    if (early) {
      const green = last.c > ent.c;
      log({ event: 'overnight_green_shadow', ...base, bar: hhmm(last.min + 5), px: round(last.c), green, ret_pct: round(100 * (last.c / ent.c - 1)), would: green ? 'sell_0935' : 'hold_to_0940' });
    } else {
      const b0940 = today.find((b) => b.min === sellBar) || last;
      const green = !!(b0935 && b0935.c > ent.c);
      const rulePx = green ? b0935.c : b0940.c;
      log({ event: 'overnight_green_shadow_close', ...base, bar: hhmm(b0940.min + 5), px_0935: b0935 ? round(b0935.c) : null, px_0940: round(b0940.c),
        green_0935: green, live_ret_pct: round(100 * (b0940.c / ent.c - 1)), rule_ret_pct: round(100 * (rulePx / ent.c - 1)) });
    }
  }

  /** The trend gate for `day` from the daily bars: { prior, mean, above, n } or null when there is no reading. */
  async function trendRead(sym, day) {
    const bars = await rawOf(sym, '1d'); if (!bars || !bars.length) return null;
    const closes = bars.map((b) => ({ d: dayOf(Date.parse(b.timestamp || b.t || b.time)), c: Number(b.close ?? b.c) }))
      .filter((x) => x.d && x.d < day && Number.isFinite(x.c) && x.c > 0).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    const dedup = []; for (const x of closes) { if (dedup.length && dedup[dedup.length - 1].d === x.d) dedup[dedup.length - 1] = x; else dedup.push(x); }
    const win = dedup.slice(-trendN); if (win.length < TREND_MIN) return { prior: dedup.length ? dedup[dedup.length - 1].c : null, mean: null, above: null, n: win.length };
    const mean = win.reduce((s, x) => s + x.c, 0) / win.length; const prior = win[win.length - 1].c;
    return { prior, mean, above: prior > mean, n: win.length };
  }

  /** One scan: { signals, overnight: { at, window, shadow, reads: [{ symbol, bar, gate, why }] } }. Never throws. */
  async function scan(now = Date.now()) {
    const e = etOf(now);
    const signals = []; const reads = []; let window = null;
    for (const sym of S) {
      const raw = await rawOf(sym, '5m');
      const done = raw ? sessionBars(raw, e.day).filter((b) => b.t + BAR_MS + SETTLE_MS <= now) : [];
      const last = done.length ? done[done.length - 1] : null;
      if (greenShadow && log && last) { try { await greenRead(sym, raw, e, last); } catch (_e) { /* journal only: never breaks the scan */ } }
      const inEntry = !!(last && last.min === entryBar && e.min < CLOSE_MIN);
      const inSell = !!(last && last.min >= sellBar && last.min < entryBar);
      if (inEntry) window = 'entry'; else if (inSell && !window) window = 'sell';
      let gate = null, direction = 'NEUTRAL', dec = 'SKIP', why;
      if (!raw || !raw.length) why = 'no bars'; else if (!last) why = 'no completed bar today';
      if (inEntry) {
        gate = await trendRead(sym, e.day);
        if (!gate || gate.above == null) why = gate ? `trend: ${gate.n} sessions, need ${TREND_MIN}` : 'no daily bars';
        else if (gate.above) { direction = 'BULLISH'; dec = 'ENTER'; }
        else why = 'below the trend';
        if (shadow && last) {
          const L = logged[sym] = logged[sym] || {};
          if (L.entry !== e.day) { L.entry = e.day; if (gate && gate.above) lastEntry[sym] = { day: e.day, px: last.c }; if (log) log({ event: 'overnight_shadow', symbol: sym, day: e.day, bar: hhmm(last.min + 5), px: round(last.c), above: gate ? gate.above : null, prior: gate ? round(gate.prior) : null, mean: gate ? round(gate.mean) : null, n: gate ? gate.n : 0, would: gate && gate.above ? 'buy' : 'skip', shadow: true }); }
        }
      } else if (inSell) {
        direction = 'BEARISH'; dec = 'ENTER';
        if (shadow && last) {
          const L = logged[sym] = logged[sym] || {};
          if (L.exit !== e.day) { L.exit = e.day; const en = lastEntry[sym]; if (en && en.day < e.day) { if (log) log({ event: 'overnight_shadow_exit', symbol: sym, day: e.day, bar: hhmm(last.min + 5), px: round(last.c), entry_day: en.day, entry_px: round(en.px), ret_pct: round(100 * (last.c / en.px - 1)), shadow: true }); delete lastEntry[sym]; } }
        }
      }
      if (shadow) { direction = 'NEUTRAL'; dec = 'SKIP'; }
      signals.push({
        symbol: sym, direction, entry_price: last ? last.c : null, price: last ? last.c : null, overnight: true,
        decision_context: { ibs: 0.1, spy_tape: 0, overnight_bar: last ? hhmm(last.min + 5) : null, overnight_window: inEntry ? 'entry' : inSell ? 'sell' : null, overnight_above: gate ? gate.above : null },
        convergence: { decision: dec, p_win: 0.6 },
      });
      reads.push({ symbol: sym, bar: last ? hhmm(last.min + 5) : null, gate: gate ? { above: gate.above, prior: round(gate.prior), mean: round(gate.mean), n: gate.n } : null, why });
    }
    return { signals, overnight: { at: new Date(now).toISOString(), window, shadow: !!shadow, trendN, reads } };
  }

  return { symbols: S, scan, trendRead, shadow: !!shadow, greenShadow: !!greenShadow };
}

module.exports = { createOvernightScan, ENTRY_BAR, SELL_BAR, GREEN_BAR, TREND_N, TREND_MIN, SETTLE_MS };
