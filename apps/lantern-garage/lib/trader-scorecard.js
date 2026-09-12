'use strict';

/**
 * trader-scorecard.js — MEASURE the stock autopilot's realized edge (Verify stage).
 *
 * The autopilot appends one `exit` row per closed long to autopilot-trades.jsonl,
 * each carrying the round-trip outcome: { symbol, pnl, pnl_pct, reason, status }.
 * This turns that raw log into an honest scorecard — win rate, expectancy, profit
 * factor, and a per-exit-reason breakdown — so a change to the exit logic (the 5m
 * momentum read, the ratcheting trail, an entry filter) can be judged on realized
 * P&L instead of vibes. Nothing here trades; it only reads and summarizes.
 *
 * HONESTY: exits are logged when the DECISION fires; the broker order may still be
 * `needs_confirmation`/`dry_run` rather than a confirmed fill. So we report BOTH a
 * headline over confirmed fills AND the full decisioned set, clearly labelled — we
 * never pass off an unconfirmed exit as booked cash.
 */

const fs = require('fs');
const path = require('path');

// Honors the same TRADER_TRADES_LOG override as auto-trader.js (its writer), so a
// test or preview can point BOTH the writer and every reader at a fixture ledger.
const DEFAULT_LOG = process.env.TRADER_TRADES_LOG
  ? path.resolve(process.env.TRADER_TRADES_LOG)
  : path.join(__dirname, '..', '..', '..', 'data', 'lantern-garage', 'trading', 'autopilot-trades.jsonl');

// A confirmed fill is one the broker actually accepted/executed. Everything else
// (needs_confirmation, dry_run, error, null) is a DECISION the strategy made but
// that did not necessarily become real money.
const CONFIRMED = new Set(['placed', 'filled', 'submitted']);

/** Group a verbose reason string ("trailing_stop (−1.6% from peak …)") to its family. */
function reasonFamily(reason) {
  const r = String(reason || '').trim();
  const m = r.match(/^[a-z_]+/i);
  return (m && m[0]) || 'unknown';
}

// Profit-TAKING exits fire only while already in profit (auto-trader gates them on
// pnlPct > 0 / a positive target), so their win rate is ~100% BY CONSTRUCTION — a
// selection artifact, not an edge. Flag them so the per-reason win rate can't be
// misread. Only the RISK-capable exits (signal_exit, trailing_stop, stop) have a
// win rate that means anything.
// `take_profit_R` belongs here too: it fires at a POSITIVE R-multiple target, so it
// can only ever close a winner. It was missing, so its structural 100% was counted
// into riskExitWinRate — the one number that is supposed to be honest. On the dev
// ledger that alone reported "riskExitWinRate 100%" off 5 profit-taking exits.
const PROFIT_ONLY_REASONS = new Set(['momentum_died', 'take_profit', 'take_profit_R']);

// Statuses where NO position change occurred, so no P&L was realized. An exit the
// broker rejected is an attempt, not a trade — counting it fabricates both a trade
// and its P&L. On the dev ledger one unclosable 0.8-share SOXS remnant re-decided 44
// times, each row booking ~+$9: 44 phantom wins and ~$400 of P&L that never existed.
const NO_FILL_STATUSES = new Set(['error', 'frozen', 'rejected', 'cancelled', 'canceled']);

function _round(n) { return Math.round(n * 100) / 100; }

/**
 * Collapse re-decisions of the SAME open position into one round-trip.
 *
 * An exit row is written when the decision fires, and a decision that doesn't
 * actually flatten the position fires again on the next scan — same symbol, same
 * avg entry, same qty, each row re-booking the position's whole unrealized P&L as
 * if it were realized. One 838.8-share SOXS position produced five `placed` rows
 * worth ~$86k of profit that never existed; the same position later produced 44
 * more as an unclosable remnant.
 *
 * A genuine re-entry that reproduces an 8-decimal average entry price AND the exact
 * share count is not a thing that happens, so keying on (symbol, entry, qty) is safe.
 * The LAST row wins — it's the decision closest to the real outcome.
 */
function dedupeRoundTrips(rows) {
  const lastIdxFor = new Map();
  rows.forEach((e, i) => {
    const entry = Number(e.entry);
    const qty = Number(e.qty);
    // No entry/qty to key on → can't prove it's a duplicate, so keep it.
    const key = (Number.isFinite(entry) && Number.isFinite(qty))
      ? `${String(e.symbol || '').toUpperCase()}|${entry.toFixed(6)}|${qty}`
      : `__unique_${i}`;
    lastIdxFor.set(key, i);
  });
  const keep = new Set(lastIdxFor.values());
  return rows.filter((_e, i) => keep.has(i));
}

/**
 * Compute a scorecard from an array of exit rows. Pure + deterministic.
 * @param {Array<{pnl:number, pnl_pct:number, reason:string, symbol:string, status:string}>} exits
 */
function computeScorecard(exits) {
  const priced = (exits || []).filter((e) => e && typeof e.pnl === 'number' && Number.isFinite(e.pnl));
  // Drop the attempts that never moved a position — they realized nothing. Reported
  // separately as failedAttempts so the exclusion is visible, not silent.
  const failedAttempts = priced.filter((e) => NO_FILL_STATUSES.has(String(e.status || '').toLowerCase()));
  const filled = priced.filter((e) => !NO_FILL_STATUSES.has(String(e.status || '').toLowerCase()));
  const rows = dedupeRoundTrips(filled);
  const duplicateExits = filled.length - rows.length;
  // Reconstructed rows: a position that left the book with no autopilot exit (a
  // protective stop filling, a manual close). Valued from the last observed mark
  // rather than a broker fill — real outcomes, estimated prices.
  const estimated = rows.filter((e) => e.estimated === true || String(e.status || '').toLowerCase() === 'reconstructed');
  const wins = rows.filter((e) => e.pnl > 0);
  const losses = rows.filter((e) => e.pnl < 0);
  const grossWin = wins.reduce((s, e) => s + e.pnl, 0);
  const grossLoss = losses.reduce((s, e) => s + e.pnl, 0); // negative
  const total = grossWin + grossLoss;

  // Per-exit-reason breakdown (which exit paths make vs lose money).
  const byReason = {};
  for (const e of rows) {
    const k = reasonFamily(e.reason);
    const b = byReason[k] || (byReason[k] = { trades: 0, wins: 0, pnl: 0 });
    b.trades += 1; b.wins += e.pnl > 0 ? 1 : 0; b.pnl = _round(b.pnl + e.pnl);
  }
  for (const k of Object.keys(byReason)) {
    byReason[k].winRate = byReason[k].trades ? _round((byReason[k].wins / byReason[k].trades) * 100) : 0;
    byReason[k].profitOnly = PROFIT_ONLY_REASONS.has(k);   // win rate here is structural, ignore it
  }

  // Risk-capable exits only (the ones that CAN lose) — the win rate that actually
  // reflects skill, unpolluted by the profit-taking exits' structural 100%.
  const risk = rows.filter((e) => !PROFIT_ONLY_REASONS.has(reasonFamily(e.reason)));
  const riskWins = risk.filter((e) => e.pnl > 0).length;

  return {
    trades: rows.length,
    wins: wins.length,
    losses: losses.length,
    winRate: rows.length ? _round((wins.length / rows.length) * 100) : 0,
    totalRealized: _round(total),
    avgWin: wins.length ? _round(grossWin / wins.length) : 0,
    avgLoss: losses.length ? _round(grossLoss / losses.length) : 0,
    expectancy: rows.length ? _round(total / rows.length) : 0,   // avg $ per trade
    // Profit factor = gross wins / |gross losses|. Infinity when there are no losses.
    profitFactor: grossLoss < 0 ? _round(grossWin / Math.abs(grossLoss)) : (grossWin > 0 ? Infinity : 0),
    // The honest win rate: over exits that could have lost. Profit-taking exits
    // (momentum_died/take_profit) are excluded because they only ever close winners.
    riskExitTrades: risk.length,
    riskExitWinRate: risk.length ? _round((riskWins / risk.length) * 100) : 0,
    // Attempts the broker never filled — excluded from every number above.
    failedAttempts: failedAttempts.length,
    // Re-decisions of an already-open position, collapsed into their round-trip.
    duplicateExits,
    // How much of the above is priced off a last-observed mark instead of a fill.
    estimatedTrades: estimated.length,
    // Excursion quality (#3241): averaged ONLY over rows that observed their run —
    // historical rows without mfe/mae stay out of the denominator (n says how many
    // contributed; averages are null, never 0, when nothing did).
    excursions: (() => {
      const mfe = rows.map((e) => e.mfe_pct).filter((v) => typeof v === 'number' && Number.isFinite(v));
      const mae = rows.map((e) => e.mae_pct).filter((v) => typeof v === 'number' && Number.isFinite(v));
      const avg = (a) => (a.length ? _round(a.reduce((s, v) => s + v, 0) / a.length) : null);
      return { nMfe: mfe.length, nMae: mae.length, avgMfePct: avg(mfe), avgMaePct: avg(mae) };
    })(),
    byReason,
  };
}

// PER-USER LEDGER (#3275). The autopilot now stamps each row with the account it
// traded for. Rows written BEFORE that existed carry no `user`; every one of them
// was written by the autopilot on the operator's own accounts, so they are read as
// the house book (HOUSE_USER) rather than being silently dropped or — worse —
// shown to whoever asks next.
const HOUSE_USER = 'local-owner';
function rowUser(r) { return (r && r.user) || HOUSE_USER; }

/**
 * Keep only rows belonging to `user`. `null`/undefined means NO filter (the
 * whole book) — used by operator-side callers and by the existing tests.
 */
function forUser(rows, user) {
  if (!user) return rows;
  const want = String(user);
  return (rows || []).filter((r) => rowUser(r) === want);
}

/** Read + parse the exit rows from a trades log (fail-soft → []); optional user filter. */
function readExits(logPath = DEFAULT_LOG, user = null) {
  let text = '';
  try { text = fs.readFileSync(logPath, 'utf8'); } catch (_e) { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch (_e) { continue; }
    if (d && d.event === 'exit') out.push(d);
  }
  return forUser(out, user);
}

/**
 * Full scorecard from disk: a `confirmed` view (broker-accepted fills only — the
 * honest realized number) and an `all` view (every exit decision, incl. unconfirmed).
 */
function scorecard(logPath = DEFAULT_LOG, user = null) {
  const exits = readExits(logPath, user);
  const confirmed = exits.filter((e) => CONFIRMED.has(String(e.status || '').toLowerCase()));
  return {
    generatedAt: new Date().toISOString(),
    confirmed: computeScorecard(confirmed),   // broker-accepted fills — booked
    all: computeScorecard(exits),             // every exit decision — strategy view
    note: 'confirmed = broker-accepted fills (booked). all = every exit decision incl. needs_confirmation/dry_run/reconstructed (strategy view, not necessarily real money). Rejected/frozen attempts realize nothing and are excluded from both — see failedAttempts. estimatedTrades are external closes (a protective stop filling, a manual close) valued off the last observed mark, not a broker fill.',
  };
}

/** Read + parse rows of one event type from a trades log (fail-soft → []); optional user filter. */
function readEvents(event, logPath = DEFAULT_LOG, user = null) {
  let text = '';
  try { text = fs.readFileSync(logPath, 'utf8'); } catch (_e) { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch (_e) { continue; }
    if (d && d.event === event) out.push(d);
  }
  return forUser(out, user);
}

// ── Breakdown slices (#3240) — the journal-analytics data layer ───────────────

// All ledger timestamps are ISO UTC; every "which day / which hour" question is an
// exchange-time question, so slicing happens in America/New_York (the day-pnl ET
// convention). hourCycle h23 pins midnight to "00" (some engines emit "24").
const ET_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
});
/* Weekday names are fixed, not localized: they are a bucket KEY that a client parses,
   so a server running under a different locale must not rename Monday. Derived from
   the ET calendar date via UTC arithmetic -- once the date is settled in New York,
   which day of the week it is has no timezone left in it. */
const ET_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function etParts(ts) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return null;
  const p = {};
  for (const part of ET_FMT.formatToParts(d)) p[part.type] = part.value;
  const date = `${p.year}-${p.month}-${p.day}`;
  const wd = ET_WEEKDAYS[new Date(Date.UTC(+p.year, +p.month - 1, +p.day)).getUTCDay()];
  return { date, hour: p.hour === '24' ? '00' : p.hour, weekday: wd };
}

/**
 * The same filtering pipeline computeScorecard applies internally (drop no-fill
 * attempts, collapse re-decisions), exposed so callers can bucket rows FIRST and
 * still get numbers consistent with the headline scorecard. Deduping before
 * bucketing matters: a duplicate pair split across two hour-buckets would never
 * collapse if each bucket deduped separately.
 */
function preparedRows(exits) {
  const priced = (exits || []).filter((e) => e && typeof e.pnl === 'number' && Number.isFinite(e.pnl));
  const filled = priced.filter((e) => !NO_FILL_STATUSES.has(String(e.status || '').toLowerCase()));
  return dedupeRoundTrips(filled);
}

/** The compact per-slice stat set (drops nested byReason + global-only counters). */
function slimStats(full) {
  return {
    trades: full.trades, wins: full.wins, losses: full.losses, winRate: full.winRate,
    totalRealized: full.totalRealized, avgWin: full.avgWin, avgLoss: full.avgLoss,
    expectancy: full.expectancy, profitFactor: full.profitFactor,
    riskExitTrades: full.riskExitTrades, riskExitWinRate: full.riskExitWinRate,
    estimatedTrades: full.estimatedTrades,
    excursions: full.excursions,   // avg MFE/MAE with its n — null-honest (#3241)
  };
}


// ── R multiples (#3550) ───────────────────────────────────────────────────────

/**
 * The denominator for one exit: the protective-stop distance at ENTRY, as % of entry.
 *
 * An R multiple divided by anything else is not an R multiple. If a trade's stop was
 * ratcheted to break-even and the result is divided by THAT, a full winner reads as
 * infinite R and a scratch reads as a disaster. The engine freezes this at entry and
 * never rewrites it, so it is the risk actually taken.
 *
 * Recorded directly since #3550. Older rows only carry it implicitly, through the
 * excursion fields that were divided by it — recoverable, but only when an excursion
 * was observed, which is 9% of the historical ledger. Hence `withR` in the summary:
 * a distribution drawn from a fraction of the record has to say so.
 */
function rBasisOf(row) {
  if (!row) return null;
  const direct = Number(row.stop_dist_pct);
  if (direct > 0) return direct;
  const back = (pct, r) => ((typeof pct === 'number' && typeof r === 'number' && r !== 0) ? pct / r : null);
  const viaMfe = back(row.mfe_pct, row.mfe_r);
  if (viaMfe > 0) return viaMfe;
  const viaMae = back(row.mae_pct, row.mae_r);      // a trade that only ever went against us
  if (viaMae > 0) return viaMae;
  return null;
}

/** One trade in R, or null when its risk was never recorded. */
function rOf(row) {
  const basis = rBasisOf(row);
  if (!(basis > 0)) return null;
  // Number(null) is 0, and the ledger writes pnl_pct: null whenever the entry price was
  // unknown -- so a coerced check turns every unpriceable trade into a real 0R outcome
  // sitting in the middle of the histogram. Demand an actual number.
  const pct = row.pnl_pct;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  return +(pct / basis).toFixed(4);
}

/* A bucket width a reader can hold in their head, wide enough that the histogram is a
   shape rather than a comb. Aiming for ~11 bars over the observed range: fixed buckets
   would be comparable between traders but this strategy's outcomes live inside ±1R,
   where a 1R-wide bucket renders the whole record as two bars. */
const R_NICE_WIDTHS = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10];
function rHistogram(values) {
  if (!values.length) return { width: 0, buckets: [] };
  const lo = Math.min(...values), hi = Math.max(...values);
  const raw = Math.max(hi - lo, 0.001) / 11;
  const width = R_NICE_WIDTHS.find((w) => w >= raw) || 20;
  const from = _round(Math.floor(lo / width) * width);
  const n = Math.max(1, Math.round((_round(Math.ceil(hi / width) * width) - from) / width));
  const buckets = [];
  for (let i = 0; i < n; i++) {
    buckets.push({ from: _round(from + i * width), to: _round(from + (i + 1) * width), count: 0, wins: 0 });
  }
  for (const v of values) {
    let i = Math.floor((v - from) / width);
    if (i < 0) i = 0;
    if (i >= n) i = n - 1;                 // the top edge belongs to the last bucket, not to nothing
    buckets[i].count += 1;
    if (v > 0) buckets[i].wins += 1;
  }
  return { width, buckets };
}

/**
 * The shape of the outcomes, not their average. A reader looking at "+$3,000" cannot
 * tell many small wins from one lucky one; this can. It matters more here than for the
 * products that popularised it: this strategy's edge is in the exits, and the exit
 * asymmetry IS this picture.
 */
function rDistribution(rows) {
  const priced = preparedRows(rows);
  const values = [];
  for (const row of priced) {
    const r = rOf(row);
    if (r != null) values.push(r);
  }
  const n = priced.length;
  const out = {
    n,
    withR: values.length,
    coverage: n ? +((values.length / n) * 100).toFixed(1) : 0,
    width: 0, buckets: [],
    mean: null, median: null, best: null, worst: null,
    wins: 0, losses: 0, avgWinR: null, avgLossR: null, payoff: null,
  };
  if (!values.length) return out;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const wins = sorted.filter((v) => v > 0), losses = sorted.filter((v) => v < 0);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  Object.assign(out, rHistogram(values), {
    mean: _round(avg(sorted)),
    median: _round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2),
    best: _round(sorted[sorted.length - 1]),
    worst: _round(sorted[0]),
    wins: wins.length,
    losses: losses.length,
    avgWinR: wins.length ? _round(avg(wins)) : null,
    avgLossR: losses.length ? _round(avg(losses)) : null,
  });
  // How much a winner returns per unit a loser costs. The headline of the whole card.
  if (out.avgWinR != null && out.avgLossR != null && Math.abs(out.avgLossR) > 0) {
    out.payoff = _round(out.avgWinR / Math.abs(out.avgLossR));
  }
  return out;
}

const BREAKDOWN_KEYS = ['symbol', 'hour', 'weekday-hour', 'reason', 'r', 'skip'];

/**
 * Slice the ledger by symbol / ET hour / ET weekday+hour / exit-reason family — each slice carrying
 * the same honesty split as the headline scorecard (confirmed = broker-accepted
 * fills; all = every exit decision). `by=skip` slices the skip log instead: every
 * declined opportunity grouped by its (number-normalized) decline reason.
 */
function breakdown(by, logPath = DEFAULT_LOG, user = null) {
  if (by === 'skip') return breakdownFromRows(by, null, readEvents('skip', logPath, user));
  return breakdownFromRows(by, readExits(logPath, user), null);
}

/**
 * Row-based variant — the same slicing over caller-supplied rows, so a
 * simulated feed (the demo journal) and the real ledger share ONE pipeline.
 */
function breakdownFromRows(by, exits, skips) {
  if (!BREAKDOWN_KEYS.includes(by)) {
    return { error: 'unknown_breakdown', by, supported: BREAKDOWN_KEYS };
  }
  if (by === 'skip') return skipBreakdownFromRows(skips || []);
  /* Not a bucketing of trades into named groups like the others, so it carries its
     own shape -- as by=skip already does -- rather than pretending to be one. */
  if (by === 'r') {
    const ex = exits || [];
    return {
      by: 'r',
      generatedAt: new Date().toISOString(),
      basis: 'protective-stop distance at entry',
      confirmed: rDistribution(ex.filter((e) => CONFIRMED.has(String(e.status || '').toLowerCase()))),
      all: rDistribution(ex),
      note: 'R is the trade result divided by the risk taken at entry: +1R is a winner the size of the stop. '
        + 'Trades whose stop distance was never recorded are counted in n but not in withR -- a distribution '
        + 'drawn from part of the record says which part.',
    };
  }
  exits = exits || [];
  const groupOf = (e) => {
    if (by === 'symbol') return String(e.symbol || '?').toUpperCase();
    if (by === 'hour') { const p = etParts(e.ts); return p ? `${p.hour}:00 ET` : '?'; }
    // 'Mon 10:00 ET' -- the hour label with its weekday in front, so one split on the
    // first space recovers both halves. Which weekday AND which hour is a different
    // question from either alone: a trader can be fine at 10am and only lose at 10am
    // on Mondays, and neither single slice can show that.
    if (by === 'weekday-hour') { const p = etParts(e.ts); return p ? `${p.weekday} ${p.hour}:00 ET` : '?'; }
    return reasonFamily(e.reason);
  };
  const views = {
    confirmed: exits.filter((e) => CONFIRMED.has(String(e.status || '').toLowerCase())),
    all: exits,
  };
  const out = {
    by,
    generatedAt: new Date().toISOString(),
    confirmed: {}, all: {},
    note: 'Same honesty split as /api/trading/scorecard: confirmed = broker-accepted fills (booked); all = every exit decision. Slices are computed AFTER the global no-fill drop + duplicate-collapse, so slice totals reconcile with the headline scorecard. Win rates on profit-only exit reasons are structural (they can only close winners) — flagged, not headline.',
  };
  for (const [view, rows] of Object.entries(views)) {
    const buckets = new Map();
    for (const e of preparedRows(rows)) {
      const k = groupOf(e);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(e);
    }
    const groups = {};
    for (const k of [...buckets.keys()].sort()) {
      const g = slimStats(computeScorecard(buckets.get(k)));
      if (by === 'reason') g.profitOnly = PROFIT_ONLY_REASONS.has(k);
      groups[k] = g;
    }
    out[view] = groups;
  }
  return out;
}

/**
 * The skip log, grouped (#3243 v1): every opportunity the autopilot DECLINED,
 * by decline reason with counters normalized out (so "gross 81% > cap 80%" and
 * "gross 83% > cap 80%" are one family). Counts only — the counterfactual
 * "what declining saved you" pricing is a separate, clearly-labeled step.
 */
function skipBreakdownFromRows(skips) {
  const buckets = new Map();
  for (const s of skips) {
    const key = String(s.reason || 'unspecified').replace(/\d+(\.\d+)?/g, '#').slice(0, 160);
    if (!buckets.has(key)) buckets.set(key, { count: 0, symbols: new Set(), firstAt: s.ts || null, lastAt: s.ts || null });
    const b = buckets.get(key);
    b.count += 1;
    if (s.symbol) b.symbols.add(String(s.symbol).toUpperCase());
    if (s.ts) { if (!b.firstAt || s.ts < b.firstAt) b.firstAt = s.ts; if (!b.lastAt || s.ts > b.lastAt) b.lastAt = s.ts; }
  }
  const groups = {};
  for (const [k, b] of [...buckets.entries()].sort((a, z) => z[1].count - a[1].count)) {
    groups[k] = { count: b.count, symbols: b.symbols.size, firstAt: b.firstAt, lastAt: b.lastAt };
  }
  return {
    by: 'skip', generatedAt: new Date().toISOString(),
    totalSkips: skips.length, groups,
    note: 'Declined opportunities from the skip log, grouped by decline reason (numbers normalized to #). Counts only — no counterfactual P&L is implied here.',
  };
}

module.exports = {
  computeScorecard, readExits, readEvents, scorecard, breakdown, breakdownFromRows,
  reasonFamily, preparedRows, etParts, slimStats, forUser, rowUser,
  CONFIRMED, BREAKDOWN_KEYS, DEFAULT_LOG, HOUSE_USER,
  rBasisOf, rOf, rHistogram, rDistribution,
};
