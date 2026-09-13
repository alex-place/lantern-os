'use strict';
/**
 * trade-replay.js — one trade, put back on the chart it was taken on (#3561).
 *
 * Every other card in this journal is an aggregate. Aggregates tell a trader that Tuesday
 * afternoons lose money; they cannot tell them what the setup looked like, which is the
 * only thing a discretionary trader can actually learn from. This is the card for the
 * majority of our readers — the ones placing their own orders, because the autopilot is
 * a $200 tier.
 *
 * PURE. Bars come from bar-window (the archive) or the live fetcher; this file decides
 * what to ask for, what to draw on it, and — the part that matters — what the record does
 * NOT support. No I/O, so the honesty rules are testable without a corpus.
 *
 * THE ENTRY IS RECOVERED, NOT GUESSED. Exits written before #3558 carry no `opened_at`,
 * but the same ledger holds the `entry` event that opened the position, and that event
 * carries the entry time, the stop the trade was opened with, and both targets. Matching
 * an exit to the entry that preceded it is exact whenever the symbol's exits are ordered
 * — which they are, being one book. Where there is no such entry, there is no opening
 * record, and the replay says so rather than picking one.
 */

const MIN = 60000;
const TF_MS = { '5m': 5 * MIN, '15m': 15 * MIN, '1h': 60 * MIN };

// A twenty-minute scalp and a five-day hold cannot be read at the same resolution. The
// corpus is 5m, so longer holds are rolled UP from it — stated in the payload, never
// silently.
const TF_LADDER = [
  { tf: '5m', agg: 1, upTo: 8 * 60 * MIN },
  { tf: '15m', agg: 3, upTo: 36 * 60 * MIN },
  { tf: '1h', agg: 12, upTo: Infinity },
];
const PAD_BARS = 24;          // setup before the entry, and what happened after the exit
const MAX_BARS = 420;
// How far back free intraday bars go. Not enforced here — it is only used to tell a
// reader WHY an old trade has no chart, which beats a blank panel.
const LIVE_HORIZON = 60 * 24 * 60 * MIN;

const _n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const _t = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
const _day = (ms) => (ms == null ? 'never' : new Date(ms).toISOString().slice(0, 10));
const _clock = (ms) => (ms == null ? '—' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z');

/**
 * The `entry` event that opened the position this exit was closing.
 *
 * Not "the nearest entry before it": a position can be added to and taken off in pieces,
 * and both are ordinary. So this WALKS the symbol's tape, carrying an open position
 * forward — an entry opens one or adds to it, an exit takes size off it, and the position
 * ends when the size does. Whatever is open when the tape reaches this exit is the entry
 * that started it. A scale-in does not move the opening (the position began where it
 * began); a partial exit does not erase it (the position was still on).
 *
 * An entry with no recorded quantity is treated as closed by the first exit against it.
 * That is the conservative reading: better to report no opening record than to attribute
 * a stop line from one position to a later, different one.
 */
function openingFor(trade, rows) {
  if (!trade || !trade.symbol) return null;
  const sym = String(trade.symbol).toUpperCase();
  const exitAt = _t(trade.ts);
  if (exitAt == null) return null;

  const tape = [];
  for (const r of rows || []) {
    if (!r || String(r.symbol || '').toUpperCase() !== sym) continue;
    if (r.event !== 'entry' && r.event !== 'exit') continue;
    const t = _t(r.ts);
    if (t == null) continue;
    // Everything strictly before this exit, plus entries at the same instant — but never
    // this exit itself, whose whole point is that the position was still open before it.
    if (t < exitAt || (t === exitAt && r.event === 'entry')) tape.push({ t, r });
  }
  tape.sort((a, b) => (a.t - b.t) || (a.r.event === 'entry' ? -1 : 1));

  let open = null;
  for (const row of tape) {
    const r = row.r;
    if (r.event === 'entry') {
      if (!open) open = { ev: r, qty: _n(r.qty) };
      else if (open.qty != null) open.qty += _n(r.qty) || 0;
    } else {
      if (!open) continue;                       // an exit with no recorded open
      if (open.qty == null) { open = null; continue; }
      open.qty -= Math.abs(_n(r.qty) || 0);
      if (open.qty <= 1e-9) open = null;
    }
  }
  if (!open) return null;
  const r = open.ev;
  return {
    at: new Date(Date.parse(r.ts)).toISOString(),
    price: _n(r.entry),
    stop: _n(r.stop),
    target1: _n(r.target1),
    target2: _n(r.target2),
    tier: r.tier || null,
    pWin: _n(r.p_win),
    source: 'entry-event',
    recovered: true,
  };
}

/** Roll `n` consecutive bars into one. OHLC aggregation keeps the extremes exactly. */
function aggregate(bars, n) {
  if (!(n > 1)) return (bars || []).slice();
  const out = [];
  const src = bars || [];
  for (let i = 0; i < src.length; i += n) {
    const c = src.slice(i, i + n);
    if (!c.length) continue;
    out.push({
      t: c[0].t,
      o: c[0].o,
      h: Math.max.apply(null, c.map((b) => b.h)),
      l: Math.min.apply(null, c.map((b) => b.l)),
      c: c[c.length - 1].c,
      v: c.reduce((s, b) => s + (b.v || 0), 0),
    });
  }
  return out;
}

/** Resolution proportionate to how long the position was actually held. */
function pickTf(openedAt, exitAt) {
  const held = (openedAt != null && exitAt != null && exitAt > openedAt) ? exitAt - openedAt : 0;
  return TF_LADDER.find((x) => held <= x.upTo) || TF_LADDER[TF_LADDER.length - 1];
}

/**
 * The window to ask the corpus for: the trade, plus setup before it and consequence
 * after. Padded in TIME, because bars are not evenly spaced — overnight and weekend gaps
 * mean a bar-count pad cannot be computed before the bars are in hand. Over-asking is
 * free (the trim in `assemble` is exact); under-asking loses the setup.
 */
function spanFor(trade, opening) {
  const exitAt = _t(trade && trade.ts);
  if (exitAt == null) return null;
  const openedRaw = _t((trade && trade.openedAt) || (opening && opening.at));
  const openedAt = openedRaw == null ? exitAt : openedRaw;
  const step = TF_MS[pickTf(openedAt, exitAt).tf];
  const pad = Math.max(PAD_BARS * step, Math.min((exitAt - openedAt) * 0.5, 2 * 24 * 60 * MIN));
  // A session is ~6.5h of the 24, and a Friday exit pads into a weekend. Ask wide enough
  // that the pad survives both.
  return { from: openedAt - pad * 4, to: exitAt + pad * 4, openedAt: openedRaw, exitAt };
}

/**
 * The bar width, inferred. Sessions leave gaps, so the SMALLEST step between adjacent
 * bars is the bar; the larger ones are overnights and weekends.
 */
function barStep(bars) {
  if (!bars || bars.length < 2) return 0;
  let min = Infinity;
  for (let i = 1; i < bars.length; i++) { const d = bars[i].t - bars[i - 1].t; if (d > 0 && d < min) min = d; }
  return isFinite(min) ? min : 0;
}

/**
 * Index of the bar a moment falls IN, or null when it falls outside them.
 *
 * A bar covers [t, t + step). Returning the LAST bar for a moment after every bar would
 * put the exit marker on a candle the trade did not exit on — which is precisely the kind
 * of quietly-wrong drawing this card must not make. Outside is null, and the caller draws
 * nothing and says the window is partial.
 */
function barAt(bars, ms) {
  if (ms == null || !bars || !bars.length) return null;
  if (ms < bars[0].t) return null;
  const step = barStep(bars);
  if (step > 0 && ms >= bars[bars.length - 1].t + step) return null;
  let lo = 0, hi = bars.length - 1, ans = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].t <= ms) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

/** Excursion prices. mfe_pct is favourable and mae_pct adverse, whichever way the trade faced. */
function excursionLevels(trade) {
  const entry = _n(trade && trade.entry);
  if (entry == null) return { mfe: null, mae: null };
  const dir = trade.side === 'short' ? -1 : 1;
  const at = (pct) => (pct == null ? null : entry * (1 + (dir * pct) / 100));
  return { mfe: at(_n(trade.mfe_pct)), mae: at(_n(trade.mae_pct)) };
}

/**
 * The stop the position was opened with, as a price.
 *
 * Two records can supply it and they are not equally good: the `entry` event holds the
 * price the stop was actually placed at, while `stop_dist_pct` is only the fraction it sat
 * away from the entry. Prefer the price; derive from the distance when there is no event.
 * Which one it was is returned, because a reader looking at a stop line deserves to know.
 */
function stopLevel(trade, opening) {
  if (opening && opening.stop != null) return { price: opening.stop, from: 'the stop order placed at entry' };
  const entry = _n(trade && trade.entry);
  const pct = _n(trade && trade.stop_dist_pct);
  if (entry == null || pct == null) return null;
  const dir = trade.side === 'short' ? 1 : -1;
  return { price: entry * (1 + (dir * Math.abs(pct)) / 100), from: 'the risk this trade was sized against' };
}

/**
 * What the bars do and do not cover — the whole reason this function exists.
 *
 * `full` means the window brackets the trade: a bar at or before the entry and one at or
 * after the exit. Anything less is `partial`, and a partial window is still worth drawing
 * as long as it is labelled, because half a trade's bars is more than none.
 */
function coverageOf(bars, openedAt, exitAt, held, symbol, opts) {
  const sym = String(symbol || 'this symbol').toUpperCase();
  const live = !!(opts && opts.live);
  if (!bars || !bars.length) {
    if (!held || !held.count) {
      // Two different failures wear the same empty list, and a reader can act on one of
      // them. "We never watched this symbol" is about us; "this is older than the free
      // data goes" is about the data, and waiting will not fix it either way — but only
      // one of them is worth checking a different symbol over.
      if (live) {
        const age = exitAt == null ? 0 : Date.now() - exitAt;
        return {
          level: 'none',
          why: age > LIVE_HORIZON
            ? 'Intraday history is free only for about the last ' + Math.round(LIVE_HORIZON / 86400000)
              + ' days. This trade closed ' + _day(exitAt) + ', further back than that.'
            : 'We could not get bars for ' + sym + ' around ' + _day(exitAt) + '. Nothing is wrong'
              + ' with the trade; the chart behind it is simply not available.',
        };
      }
      return {
        level: 'none',
        why: 'There is no bar history for ' + sym + '. We keep intraday bars for the symbols this'
          + ' machine watches, so a trade in anything else has no chart to replay.',
      };
    }
    // Before ours begin, after ours end, and a hole in the middle are three different
    // facts, and only one of them is "we started watching too late". Saying the wrong one
    // would send a reader looking for a coverage problem that is not there.
    const span = 'Our bars for ' + sym + ' run ' + _day(held.first) + ' to ' + _day(held.last) + '.';
    let where = ' There are none for the window around this trade.';
    if (exitAt != null && held.last != null && exitAt > held.last) where = ' This trade closed ' + _day(exitAt) + ', after they end.';
    else if (exitAt != null && held.first != null && exitAt < held.first) where = ' This trade closed ' + _day(exitAt) + ', before they begin.';
    return { level: 'none', why: span + where };
  }
  const startsLate = openedAt != null && barAt(bars, openedAt) == null;
  const endsEarly = exitAt != null && barAt(bars, exitAt) == null;
  if (!startsLate && !endsEarly) return { level: 'full', why: null };
  const missing = [];
  if (startsLate) missing.push('before ' + _clock(bars[0].t));
  if (endsEarly) missing.push('after ' + _clock(bars[bars.length - 1].t + barStep(bars)));
  return {
    level: 'partial',
    why: 'Bars are missing ' + missing.join(' and ') + ', so part of this trade is not drawn.'
      + ' What is here is real; the gap is simply not in our record.',
  };
}

/**
 * Everything the chart needs, and nothing it has to work out for itself.
 *
 * `bars` are raw corpus rows over `spanFor`'s window; this rolls them to the chosen
 * resolution, trims them to a proportionate frame, and marks the trade on them.
 */
function assemble(input) {
  const trade = (input && input.trade) || {};
  const opening = (input && input.opening) || null;
  const held = (input && input.held) || null;
  const source = (input && input.source) || 'archive';

  const exitAt = _t(trade.ts);
  const openedAt = _t(trade.openedAt || (opening && opening.at));
  const pick = pickTf(openedAt == null ? exitAt : openedAt, exitAt);

  // The archive may already hold this timeframe natively (the server fetches 15m and 1h
  // as well as 5m), in which case there is nothing to roll up and the bars are the real
  // ones rather than a reconstruction of them.
  const barsTf = (input && input.barsTf && TF_MS[input.barsTf]) ? input.barsTf : '5m';
  const agg = Math.max(1, Math.round(TF_MS[pick.tf] / TF_MS[barsTf]));

  let frame = aggregate((input && input.bars) || [], agg);
  // Trim AFTER the roll-up, so the pad is counted in the bars a reader will actually see
  // rather than in the 5m rows behind them.
  const ei = barAt(frame, openedAt == null ? exitAt : openedAt);
  const xi = barAt(frame, exitAt);
  if (ei != null || xi != null) {
    const lo = Math.max(0, (ei == null ? xi : ei) - PAD_BARS);
    const hi = Math.min(frame.length, (xi == null ? ei : xi) + PAD_BARS + 1);
    frame = frame.slice(lo, Math.min(hi, lo + MAX_BARS));
  } else {
    frame = frame.slice(0, MAX_BARS);
  }

  const cov = coverageOf(frame, openedAt, exitAt, held, trade.symbol, { live: source === 'live' });
  const stop = stopLevel(trade, opening);
  const exc = excursionLevels(trade);

  return {
    trade: {
      id: trade.id || null,
      symbol: String(trade.symbol || '').toUpperCase(),
      side: trade.side === 'short' ? 'short' : 'long',
      qty: _n(trade.qty), entry: _n(trade.entry), exit: _n(trade.exit),
      pnl: _n(trade.pnl), pnl_pct: _n(trade.pnl_pct), r: _n(trade.r),
      reason: trade.reason || null,
      openedAt: openedAt == null ? null : new Date(openedAt).toISOString(),
      closedAt: exitAt == null ? null : new Date(exitAt).toISOString(),
    },
    // `recovered` means the opening came from matching the ledger's entry event rather
    // than from the exit row itself. Both are our own record; one took a step to get.
    opening: opening ? Object.assign({ recovered: false }, opening) : null,
    timeframe: pick.tf,
    rolledUp: agg > 1 ? { from: barsTf, every: agg } : null,
    bars: frame,
    marks: {
      entryIdx: barAt(frame, openedAt),
      exitIdx: barAt(frame, exitAt),
      entry: _n(trade.entry),
      exit: _n(trade.exit),
      stop: stop ? stop.price : null,
      stopFrom: stop ? stop.from : null,
      target1: opening ? opening.target1 : null,
      target2: opening ? opening.target2 : null,
      mfe: exc.mfe,
      mae: exc.mae,
    },
    coverage: cov.level,
    why: cov.why,
    source,
  };
}

module.exports = {
  openingFor, spanFor, assemble, aggregate, pickTf, barAt,
  excursionLevels, stopLevel, coverageOf, barStep,
  TF_MS, TF_LADDER, PAD_BARS, MAX_BARS, LIVE_HORIZON,
};
