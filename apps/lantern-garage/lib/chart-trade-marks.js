'use strict';

/**
 * chart-trade-marks.js — the journal's trades, shaped for a price chart.
 *
 * Loop stage: Observe. The trader page draws a chart per ticker and, until this, nothing
 * on it said where the trader got in or out (operator, 2026-11-20: "there is no way for
 * me to know when it entered a position"). The journal has every one of those moments;
 * this turns its rows into trades a chart can mark. It reads; it never writes, and no
 * order, config or decision code is anywhere near it.
 *
 * ONE TRADE PER ENTRY. An `entry` row opens a trade at the moment the order went in. Its
 * price is the broker's fill when the journal has one (`entry_fill`, written only when
 * the fill differed from the quote by more than a basis point) and the quote otherwise.
 * An `exit` row closes the trade it belongs to: matched by the open time the exit row
 * carries, else by the entry price it carries, else the newest trade still open in that
 * symbol. Matching by price rather than "the last entry" matters on a book several
 * sleeves share — two sleeves can hold the same name at once, each with its own exit.
 * A sale that filled in pieces is several exit rows, so a trade has a LIST of exits.
 *
 * WHAT IS NOT A TRADE.
 *   - Shadow rows (`*_shadow_*` events, the `*-shadow` / `entry-tags` / `trade-plan`
 *     users): research the engine journals beside its trades. Never drawn.
 *   - An exit whose status is not `filled` or `reconstructed`. `needs_confirmation` and
 *     `error` moved nothing. `placed` is the pre-August ledger's "order accepted" row:
 *     it is not drawn as an exit either, but it does end the trade, so a July entry
 *     never reads as a position still open.
 *
 * ONE EXIT, ONE MARK. A close can be journalled twice on a day — the engine's row at
 * its decision price, then the broker's row at the real one. Same symbol, quantity and
 * entry price on one New York day is one exit: the LATER row's price and P&L stand.
 * Its time is the EARLIEST of the rows, because the later one can be stamped hours
 * after the fact (a fill found at the next open), and a reason beats "broker fill".
 *
 * TIMES ARE NOT ALL EXACT, AND THE ROW SAYS SO. `time_approx` is set when the journal
 * itself cannot vouch for the moment: a fill stamped when it was discovered
 * (`ts_from`), a close reconstructed after the position left the book, or a stop whose
 * time is the moment the stop order was placed or last moved (IBKR reported that as
 * the execution time until 2026-11; such a row sits on an entry or stop_resize row's
 * own second).
 *
 * "OPEN" IS A CLAIM, SO IT IS A NARROW ONE. The journal does not hold every close: a
 * stop that filled in pieces can leave shares it never booked, and the July ledger's
 * exits were mostly never confirmed. A trade is reported open only when nothing closed
 * it AND the symbol has not been entered again since — as many times as there are
 * ledgers in the book, because each ledger holds one position a symbol. Everything
 * older reads as closed with no exit recorded. The page checks the broker's positions
 * on top of that before it draws a position line.
 *
 * The overnight book journals its own rows (`overnight_book_buy` / `_sell` / `_gone`)
 * and is read the same way: a buy opens, the sale closes, the `gone` row prices it.
 */

const NY_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

const REAL_EXIT = new Set(['filled', 'reconstructed']);
// Ends the trade without being drawn: the old ledger's order-accepted row.
const SILENT_EXIT = new Set(['placed']);
const JOURNAL_ONLY_USERS = new Set(['trend-shadow', 'noise-shadow', 'rise-shadow', 'entry-tags', 'trade-plan', 'bars-ibkr']);
const EVENTS = new Set(['entry', 'entry_fill', 'exit', 'stop_resize',
  'overnight_book_buy', 'overnight_book_sell', 'overnight_book_gone']);

const OPENED_AT_SLACK_MS = 3 * 60 * 1000;   // the engine notes the open a few seconds off the row
const ENTRY_LEAD_MS = 60 * 1000;            // an exit stamped to the broker's second can precede its own entry row
const PRICE_MATCH = 0.002;                  // exit.entry vs the trade's own entry price
const ORDER_TIME_SLACK_MS = 5000;           // a stop "filled" on an entry / resize row's own second
const QTY_EPS = 1e-6;

const _num = (v) => { if (v == null || v === '') return null; const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) ? n : null; };
const _pos = (v) => { const n = _num(v); return n != null && n > 0 ? n : null; };
const _ms = (v) => { if (v == null || v === '') return null; const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };
const _iso = (ms) => new Date(ms).toISOString();
const _sym = (r) => String((r && r.symbol) || '').trim().toUpperCase();
const _round = (n, p) => (n == null ? null : Math.round(n * 10 ** p) / 10 ** p);
const nyDay = (ms) => NY_DAY.format(new Date(ms));

/** A row the chart may draw from: a known trade event, not research, with a time and a symbol. */
function isTradeRow(r) {
  if (!r || typeof r !== 'object') return false;
  const ev = String(r.event || '');
  if (!EVENTS.has(ev) || ev.includes('_shadow_')) return false;
  const user = String(r.user || '');
  if (JOURNAL_ONLY_USERS.has(user) || /-shadow$/.test(user)) return false;
  return !!_sym(r) && _ms(r.ts) != null;
}

/** The predicate a ledger reader can pass to pre-filter rows (cheap; no state). */
const wantRow = (r) => !!r && EVENTS.has(String(r.event || ''));

function _reasonOf(rows) {
  // The engine's own reason over the fill ledger's "broker fill"; the newest of those.
  for (let i = rows.length - 1; i >= 0; i--) {
    const why = String(rows[i].reason || '').trim();
    if (why && why !== 'broker fill') return why;
  }
  const last = rows[rows.length - 1];
  if (/stop/i.test(String(last.order_type || ''))) return 'stop order filled';
  return String(last.reason || '').trim() || null;
}

/**
 * Journal rows → { SYMBOL: [trade, …] }, each symbol's trades oldest first.
 *
 *   trade = {
 *     id, symbol, book: 'day' | 'overnight', qty,
 *     entry: { ts, price, price_from: 'fill' | 'quote' | 'position' | 'exit_row', quote },
 *     stop,            // an open trade's newest stop in the journal (entry stop, then resizes)
 *     stop_at_entry, target1, target2,
 *     open,            // nothing closed it and the symbol was not entered again since
 *     exits: [{ ts, price, qty, pnl, pnl_pct, reason, time_approx, time_note, price_estimated }],
 *     pnl,             // the exits' P&L added up; null when none of them is priced
 *     closed_note,     // why a closed trade has no exit to draw: 'unconfirmed' | 'left_book'
 *   }
 *
 * @param {object[]} rows  journal rows, any order, any events (the rest are ignored)
 * @param {{ledgers?: number}} [opts]  how many ledgers the rows were merged from (default 1)
 */
function buildTradeMarks(rows, opts) {
  const ledgers = Math.max(1, Math.floor(Number(opts && opts.ledgers) || 1));
  const tape = [];
  (rows || []).forEach((r, i) => { if (isTradeRow(r)) tape.push({ r, t: _ms(r.ts), i, sym: _sym(r) }); });
  tape.sort((a, b) => (a.t - b.t) || (a.i - b.i));

  const bySym = new Map();   // symbol -> trades (internal shape), in entry order
  const tradesOf = (sym) => { if (!bySym.has(sym)) bySym.set(sym, []); return bySym.get(sym); };
  const basisOf = (tr) => (tr.fill != null ? tr.fill : tr.quote);

  // ── pass 1: the openings, and which exit rows are one exit ───────────────────
  // Entries first, on their own, so an exit the broker stamped to the whole second can
  // still find an entry row written a few hundred milliseconds "after" it.
  const groups = new Map();        // key -> [tape items]: one real exit
  const groupOf = new Map();       // tape item -> its group
  const orderTimes = new Map();    // symbol -> [ms] of entry / stop_resize rows
  for (const x of tape) {
    const r = x.r, ev = r.event, list = tradesOf(x.sym);
    if (ev === 'entry' || ev === 'stop_resize') {
      if (!orderTimes.has(x.sym)) orderTimes.set(x.sym, []);
      orderTimes.get(x.sym).push(x.t);
    }
    if (ev === 'entry') {
      const quote = _pos(r.entry);
      if (quote == null) continue;
      const qty = _pos(r.qty);
      list.push({
        book: 'day', t: x.t, sym: x.sym, qty, remaining: qty != null ? qty : Infinity,
        quote, fill: null, fillFrom: 'quote',
        stopAtEntry: _pos(r.stop), stop: _pos(r.stop), target1: _pos(r.target1), target2: _pos(r.target2),
        exits: [], closedNote: null,
      });
    } else if (ev === 'entry_fill') {
      const q = _pos(r.quote_px), f = _pos(r.fill_px);
      if (f == null) continue;
      // The newest trade still waiting for its fill, quoted at this row's quote.
      for (let i = list.length - 1; i >= 0; i--) {
        const tr = list[i];
        if (tr.book !== 'day' || tr.fill != null) continue;
        if (q != null && Math.abs(tr.quote - q) / q > 1e-6) continue;
        tr.fill = f; tr.fillFrom = 'fill';
        break;
      }
    } else if (ev === 'exit' && REAL_EXIT.has(String(r.status || '').toLowerCase())) {
      const entry = _num(r.entry), qty = _num(r.qty);
      const key = (entry != null && qty != null)
        ? [x.sym, qty, entry.toFixed(6), nyDay(x.t)].join('|')
        : '__one_' + x.i;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(x);
      groupOf.set(x, groups.get(key));
    }
  }

  const nearOrderTime = (sym, t) => (orderTimes.get(sym) || []).some((o) => Math.abs(o - t) <= ORDER_TIME_SLACK_MS);

  /** The one exit a group of rows stands for. */
  function exitOf(items) {
    const first = items[0], r = items[items.length - 1].r;
    let note = null;
    if (first.r.ts_from === 'discovered') note = 'seen';          // stamped when the fill was found
    else if (String(first.r.status).toLowerCase() === 'reconstructed') note = 'reconstructed';
    else if (/stop/i.test(String(first.r.order_type || '')) && nearOrderTime(first.sym, first.t)) note = 'order_time';
    let openedAt = null;
    for (const it of items) { const o = _ms(it.r.opened_at); if (o != null && o > 0) openedAt = o; }
    return {
      t: first.t,
      openedAt: (openedAt != null && openedAt <= first.t + ENTRY_LEAD_MS) ? openedAt : null,
      basis: _pos(r.entry),
      qty: _pos(r.qty),
      out: {
        ts: _iso(first.t),
        price: _pos(r.exit),
        qty: _pos(r.qty),
        pnl: _num(r.pnl),
        pnl_pct: _round(_num(r.pnl_pct), 4),
        reason: _reasonOf(items.map((it) => it.r)),
        time_approx: note != null,
        time_note: note,
        price_estimated: r.estimated === true || String(r.status).toLowerCase() === 'reconstructed',
      },
    };
  }

  /** The open day trades an exit closes, best match first. */
  function matchFor(sym, ex) {
    const open = tradesOf(sym).filter((tr) => tr.book === 'day' && tr.remaining > QTY_EPS && tr.t <= ex.t + ENTRY_LEAD_MS);
    if (!open.length) return [];
    if (ex.openedAt != null) {
      const byTime = open.filter((tr) => Math.abs(tr.t - ex.openedAt) <= OPENED_AT_SLACK_MS);
      if (byTime.length) return byTime;
    }
    if (ex.basis != null) {
      const gap = (tr) => Math.min(...[tr.fill, tr.quote].filter((p) => p != null).map((p) => Math.abs(p - ex.basis)));
      const byPrice = open.filter((tr) => gap(tr) / ex.basis <= PRICE_MATCH);
      if (byPrice.length) return byPrice.sort((a, b) => (gap(a) - gap(b)) || (b.t - a.t));
    }
    // Nothing names it (a position built from several entries exits at their average,
    // which matches none of them): newest first.
    return open.slice().sort((a, b) => b.t - a.t);
  }

  /** Take an exit's quantity off the trades it closes; returns [{ tr, take }] for those it touched. */
  function consume(sym, ex) {
    let left = ex.qty != null ? ex.qty : Infinity;
    const hit = [];
    for (const tr of matchFor(sym, ex)) {
      if (left <= QTY_EPS) break;
      const take = Math.min(tr.remaining, left);
      tr.remaining -= take; left -= take;
      hit.push({ tr, take });
    }
    return hit;
  }

  // ── pass 2: the closes, the stop moves and the overnight book, in time order ──
  const handled = new Set();
  for (const x of tape) {
    const r = x.r, sym = x.sym, list = tradesOf(sym);

    if (r.event === 'stop_resize') {
      const want = _pos(r.stop_want);
      if (want == null) continue;
      const open = list.filter((tr) => tr.book === 'day' && tr.remaining > QTY_EPS && tr.t <= x.t);
      const basis = _pos(r.entry);
      const mine = basis != null ? open.filter((tr) => Math.abs(basisOf(tr) - basis) / basis <= PRICE_MATCH) : [];
      for (const tr of (mine.length ? mine : open.slice(-1))) tr.stop = want;
      continue;
    }

    if (r.event === 'exit') {
      const status = String(r.status || '').toLowerCase();
      if (SILENT_EXIT.has(status)) {
        // Order accepted, never confirmed in the journal: the trade ends, nothing is drawn.
        for (const { tr } of consume(sym, { t: x.t, openedAt: _ms(r.opened_at), basis: _pos(r.entry), qty: _pos(r.qty) })) {
          if (tr.remaining <= QTY_EPS && !tr.exits.length) tr.closedNote = 'unconfirmed';
        }
        continue;
      }
      const group = groupOf.get(x);
      if (!group || handled.has(group)) continue;      // not a real exit, or its group is already drawn
      handled.add(group);
      const ex = exitOf(group);
      if (ex.out.price == null) continue;              // no price, no mark
      const hit = consume(sym, ex);
      for (const { tr, take } of hit) {
        if (hit.length === 1) { tr.exits.push(ex.out); continue; }
        // One sale closing several entries: each trade gets its own share of it.
        const part = ex.qty > 0 && Number.isFinite(take) ? take / ex.qty : 1 / hit.length;
        tr.exits.push(Object.assign({}, ex.out, {
          qty: Number.isFinite(take) ? _round(take, 6) : ex.out.qty,
          pnl: ex.out.pnl != null ? _round(ex.out.pnl * part, 2) : null,
          shared: true,
        }));
      }
      if (!hit.length) {
        // An exit with no entry in the journal (opened before it began, or by hand). It is
        // still a real close: draw it, and its opening too when the row says when that was.
        list.push({
          book: 'day', t: ex.openedAt != null ? ex.openedAt : ex.t, sym, qty: ex.qty, remaining: 0,
          quote: ex.basis, fill: null, fillFrom: 'exit_row', noEntryTime: ex.openedAt == null,
          stopAtEntry: null, stop: null, target1: null, target2: null,
          exits: [ex.out], closedNote: null,
        });
      }
      continue;
    }

    // The overnight book: self-contained rows, one buy to one sale.
    if (r.event === 'overnight_book_buy') {
      const px = _pos(r.px), qty = _pos(r.qty);
      if (r.ok !== true || px == null) continue;       // a refused buy bought nothing
      list.push({
        book: 'overnight', t: x.t, sym, qty, remaining: qty != null ? qty : Infinity, day: nyDay(x.t),
        quote: px, fill: null, fillFrom: 'quote',
        stopAtEntry: null, stop: null, target1: null, target2: null,
        exits: [], closedNote: null,
      });
      continue;
    }
    if (r.event === 'overnight_book_sell' || r.event === 'overnight_book_gone') {
      const held = list.filter((tr) => tr.book === 'overnight' && (tr.remaining > QTY_EPS || tr.awaitingGone)
        && (!r.bought_day || tr.day === r.bought_day));
      const tr = held[held.length - 1];
      if (!tr) continue;
      if (r.event === 'overnight_book_sell') {
        if (r.ok !== true) continue;                   // a refused sale sold nothing
        const px = _pos(r.px);
        tr.remaining = 0; tr.awaitingGone = true;
        tr.exits = [{
          ts: _iso(x.t), price: px, qty: _pos(r.qty),
          pnl: (px != null && tr.qty != null) ? _round((px - tr.quote) * tr.qty, 2) : null,
          pnl_pct: _round(_num(r.ret_pct), 4),
          reason: 'overnight book: the morning sale',
          time_approx: false, time_note: null,
          price_estimated: true,                       // the order's quote, until the broker prices it
        }];
        continue;
      }
      // gone: the broker no longer shows the name. A sold one arrives priced.
      tr.awaitingGone = false;
      const cost = _pos(r.cost_px);
      if (cost != null && r.cost_from === 'position') { tr.fill = cost; tr.fillFrom = 'position'; }
      const sale = tr.exits[0];
      if (r.sold === true && sale) {
        const fill = _pos(r.fill_px);
        if (fill != null) { sale.price = fill; sale.price_estimated = false; }
        if (_num(r.pnl) != null) sale.pnl = _num(r.pnl);
        if (_num(r.ret_pct) != null) sale.pnl_pct = _round(_num(r.ret_pct), 4);
      } else if (!sale) {
        tr.remaining = 0;
        tr.closedNote = 'left_book';                   // not sold by the book: never filled, or closed by hand
      }
    }
  }

  // ── out ─────────────────────────────────────────────────────────────────────
  const out = {};
  for (const [sym, list] of bySym) {
    list.sort((a, b) => a.t - b.t);
    const trades = [];
    list.forEach((tr, i) => {
      const price = basisOf(tr);
      if (price == null) return;
      const exits = tr.exits.filter((e) => e.price != null);
      // Open: nothing closed it, and the symbol has not been entered `ledgers` times since.
      const newerSameBook = list.slice(i + 1).filter((o) => o.book === tr.book && !o.noEntryTime).length;
      const open = tr.remaining > QTY_EPS && newerSameBook < (tr.book === 'overnight' ? 1 : ledgers);
      const priced = exits.filter((e) => e.pnl != null);
      trades.push({
        id: [sym, tr.book === 'overnight' ? 'o' : 'd', tr.t].join('|'),
        symbol: sym,
        book: tr.book,
        qty: tr.qty,
        entry: {
          ts: tr.noEntryTime ? null : _iso(tr.t),
          price: _round(price, 6),
          price_from: tr.fillFrom,
          quote: _round(tr.quote, 6),
        },
        stop: open ? tr.stop : null,
        stop_at_entry: tr.stopAtEntry,
        target1: tr.target1,
        target2: tr.target2,
        open,
        exits,
        pnl: priced.length ? _round(priced.reduce((s, e) => s + e.pnl, 0), 2) : null,
        closed_note: (!open && !exits.length) ? (tr.closedNote || 'unconfirmed') : null,
      });
    });
    if (trades.length) out[sym] = trades;
  }
  return out;
}

module.exports = {
  buildTradeMarks, isTradeRow, wantRow, nyDay,
  REAL_EXIT, JOURNAL_ONLY_USERS, EVENTS,
};
