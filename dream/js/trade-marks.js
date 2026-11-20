/*
 * trade-marks.js — where the trader got in and out, drawn on a ticker's chart.
 *
 * The data is /api/trading/chart-trades (lib/chart-trade-marks: journal rows → trades).
 * This is the page's half: which BAR a moment belongs to, the marks themselves, and the
 * card that says the exact time when one is pointed at.
 *
 * A MARK SITS ON ITS BAR; THE CARD HAS THE SECOND. A chart can only place a trade on a
 * bar — the five-minute one it happened in, or on a daily chart the day's. So the mark's
 * x is the bar and its tip is the fill PRICE, exact on every time-frame, and the exact
 * time is in the card, always in New York time, whatever zone the axis reads in.
 *
 *   entry   ▲  tip on the fill price, in the accent colour
 *   exit    ▼  tip on the exit price; the gain colour for a win, the loss colour for a
 *              loss; drawn hollow when the journal cannot vouch for its time
 *   open    a dashed line at the entry price and one at the stop, to the right edge
 *
 * WHICH BAR. Intraday: the bar whose span holds the moment. A moment in a gap between
 * bars (pre-market on a regular-hours chart, a weekend) goes to the nearer side of the
 * gap, so a 07:47 fill sits on the open it preceded, not on yesterday's close. Daily and
 * longer: the bar of that New York DAY — never "the last bar before this instant", which
 * puts an evening fill on tomorrow's bar when bars are stamped in UTC. A moment before
 * the first bar is not drawn at all (pan left and it appears); an open position's lines
 * still are, with the entry time written on the line.
 *
 * TWO RUNTIMES. Loaded by the trader page (window.TradeMarks) and require()d by the
 * tests. Nothing touches the DOM until draw() or hover() is called.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TradeMarks = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NY = 'America/New_York';
  const INTRADAY = ['1m', '5m', '15m', '30m', '1h', '2h', '4h'];
  const ENDPOINT = '/api/trading/chart-trades';

  const _ms = (ts) => { const t = typeof ts === 'number' ? ts : Date.parse(String(ts == null ? '' : ts).replace(' ', 'T')); return Number.isFinite(t) ? t : null; };
  const _dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit' });
  const nyDay = (ms) => _dayFmt.format(new Date(ms));

  /** The New York day a daily (or longer) bar stands for. A bar stamped at exactly
      midnight UTC is a calendar date, not a moment: read it as written. */
  const _barDays = new Map();   // a chart repaints many times a second while it is dragged; Intl is slow
  function barDay(ts) {
    let d = _barDays.get(ts);
    if (d !== undefined) return d;
    const t = _ms(ts);
    d = t == null ? null : (t % 86400000 === 0) ? new Date(t).toISOString().slice(0, 10) : nyDay(t);
    if (_barDays.size > 20000) _barDays.clear();
    _barDays.set(ts, d);
    return d;
  }

  /**
   * bars + time-frame → at(ms): the index of the bar a moment belongs to.
   *   -1            before the first bar (not on this chart)
   *   0 … n-1       that bar
   *   n             a daily chart whose newest bar is an earlier day (the slot after it)
   * `gap` is true when the moment fell between bars and was moved to the nearer one.
   */
  function placer(bars, tf) {
    const n = (bars || []).length;
    const intraday = INTRADAY.indexOf(tf) !== -1;
    if (!n) return { n: 0, at: () => ({ idx: -1, gap: false }) };

    if (!intraday) {
      const days = bars.map((b) => barDay(b.timestamp));
      return {
        n,
        at(ms) {
          const day = nyDay(ms);
          if (days[0] == null || day < days[0]) return { idx: -1, gap: false };
          let lo = 0, hi = n - 1;                             // last bar whose day <= day
          while (lo < hi) { const m = (lo + hi + 1) >> 1; if (days[m] != null && days[m] <= day) lo = m; else hi = m - 1; }
          if (tf === '1d' && lo === n - 1 && day > days[lo]) return { idx: n, gap: false };
          return { idx: lo, gap: false };
        },
      };
    }

    const T = bars.map((b) => _ms(b.timestamp));
    let step = 60000;
    if (n > 1) {
      const ds = []; for (let i = 1; i < n; i++) ds.push(T[i] - T[i - 1]);
      ds.sort((p, q) => p - q);
      step = ds[Math.floor(ds.length / 2)] || step;           // the median: an overnight does not count
    }
    return {
      n,
      at(ms) {
        if (ms < T[0]) return { idx: -1, gap: false };
        let lo = 0, hi = n - 1;                               // last bar that started at or before ms
        while (lo < hi) { const m = (lo + hi + 1) >> 1; if (T[m] <= ms) lo = m; else hi = m - 1; }
        if (lo === n - 1 || ms < T[lo] + step) return { idx: lo, gap: false };
        // Between two bars: the nearer side of the gap.
        return { idx: (ms - (T[lo] + step)) <= (T[lo + 1] - ms) ? lo : lo + 1, gap: true };
      },
    };
  }

  /**
   * One symbol's trades, placed on a chart's bars.
   *   marks: [{ kind: 'entry' | 'exit', idx, price, trade, exit, k, gap }]   (on the chart only)
   *   open:  [trade]   every trade still open, on the chart or older than it
   */
  function layout(trades, bars, tf) {
    const p = placer(bars, tf);
    const marks = [], open = [];
    for (const tr of trades || []) {
      if (!tr || !tr.entry) continue;
      if (tr.open) open.push(tr);
      const t0 = _ms(tr.entry.ts);
      if (t0 != null && tr.entry.price > 0) {
        const at = p.at(t0);
        if (at.idx >= 0) marks.push({ kind: 'entry', idx: at.idx, price: tr.entry.price, trade: tr, exit: null, k: -1, gap: at.gap });
      }
      (tr.exits || []).forEach((ex, k) => {
        const t1 = _ms(ex.ts);
        if (t1 == null || !(ex.price > 0)) return;
        const at = p.at(t1);
        if (at.idx >= 0) marks.push({ kind: 'exit', idx: at.idx, price: ex.price, trade: tr, exit: ex, k, gap: at.gap });
      });
    }
    marks.sort((a, b) => (a.idx - b.idx) || (a.kind === 'entry' ? -1 : 1));
    return { marks, open, n: p.n };
  }

  // ── words ────────────────────────────────────────────────────────────────────
  /** "Thu Nov 19, 12:29:13 PM ET" — always New York, always to the second. */
  function fmtTime(ts, opts) {
    const t = _ms(ts);
    if (t == null) return '';
    const o = { timeZone: NY, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true };
    if (opts && opts.short) { delete o.weekday; delete o.second; }
    return new Date(t).toLocaleString('en-US', o) + ' ET';
  }
  function fmtPrice(p) {
    if (!(p > 0)) return '—';
    const d = p >= 100 ? 2 : p >= 1 ? 3 : 4;
    return Number(p).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: d });
  }
  function fmtMoney(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    return (v >= 0 ? '+' : '−') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtQty(q) { return q == null ? '' : Number(q).toLocaleString('en-US', { maximumFractionDigits: 4 }); }
  function fmtHeld(ms) {
    if (!(ms > 0)) return '';
    const m = Math.floor(ms / 60000);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    return h < 48 ? h + 'h ' + (m % 60) + 'm' : Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  }
  const PRICE_FROM = { fill: 'fill', position: 'fill', quote: 'order quote', exit_row: 'average cost' };
  const TIME_NOTE = {
    seen: 'Time is when the fill was seen; the fill came just before.',
    order_time: 'Time is when the stop order was placed or last moved; the fill came at or after it.',
    reconstructed: 'The position left the account with no exit of ours; time and price are estimates.',
  };

  /**
   * What the card says for a mark, as rows of { k, v, tone, note }: `k` the label, `v` the
   * value, `tone` 'win' | 'loss' | undefined, `note` a line of small print under the row.
   * @param held  true / false when the broker's positions are known, else null
   */
  function describe(mark, held) {
    const tr = mark.trade, rows = [];
    const title = tr.symbol + ' · bought ' + fmtQty(tr.qty) + (tr.book === 'overnight' ? ' · overnight book' : '');
    const inTime = tr.entry.ts ? fmtTime(tr.entry.ts) : 'time not in the journal';
    rows.push({ k: 'In', v: inTime + '  @ ' + fmtPrice(tr.entry.price), note: PRICE_FROM[tr.entry.price_from] || '' });

    const exits = tr.exits || [];
    exits.forEach((ex, i) => {
      const many = exits.length > 1;
      const tone = ex.pnl == null ? undefined : (ex.pnl >= 0 ? 'win' : 'loss');
      rows.push({
        k: many ? 'Out ' + (i + 1) + '/' + exits.length : 'Out',
        v: (ex.time_approx ? '≈ ' : '') + fmtTime(ex.ts) + '  @ ' + fmtPrice(ex.price) + (many && ex.qty ? '  × ' + fmtQty(ex.qty) : ''),
        note: [ex.price_estimated ? 'estimated price' : '', TIME_NOTE[ex.time_note] || ''].filter(Boolean).join(' · '),
        here: mark.kind === 'exit' && mark.k === i,
      });
      if (many) rows.push({ k: '', v: fmtMoney(ex.pnl) + (ex.reason ? '  ·  ' + ex.reason : ''), tone });
    });

    if (exits.length) {
      const last = exits[exits.length - 1], one = exits.length === 1;
      const tone = tr.pnl == null ? undefined : (tr.pnl >= 0 ? 'win' : 'loss');
      const pct = one && last.pnl_pct != null ? '  (' + (last.pnl_pct >= 0 ? '+' : '−') + Math.abs(last.pnl_pct).toFixed(2) + '%)' : '';
      rows.push({ k: 'P&L', v: fmtMoney(tr.pnl) + pct, tone });
      if (one && last.reason) rows.push({ k: 'Why', v: last.reason });
      const held0 = _ms(tr.entry.ts), held1 = _ms(last.ts);
      if (held0 != null && held1 != null && held1 > held0) rows.push({ k: 'Held', v: fmtHeld(held1 - held0) });
    }
    if (tr.open) {
      if (held === false) rows.push({ k: 'Now', v: 'No exit in the journal; the account no longer holds it.' });
      else rows.push({ k: 'Now', v: (exits.length ? 'Part still open' : 'Open') + (tr.stop > 0 ? '  ·  stop ' + fmtPrice(tr.stop) : '') });
    } else if (!exits.length) {
      rows.push({ k: 'Out', v: tr.closed_note === 'left_book' ? 'Left the book without a sale of its own.' : 'No confirmed exit in the journal.' });
    }
    return { title, rows };
  }

  // ── the canvas ───────────────────────────────────────────────────────────────
  // A mark is 2R wide and 1.8R tall. A chart with a year of trades on it gets smaller
  // marks, and labels only for the newest trade: forty labels are no labels at all.
  const R_ROOMY = 5, R_DENSE = 3.5, DENSE_MARKS = 24, LABEL_ALL_MARKS = 12;

  function _tri(ctx, x, y, up, r) {
    const h = r * 1.8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    if (up) { ctx.lineTo(x - r, y + h); ctx.lineTo(x + r, y + h); }
    else { ctx.lineTo(x - r, y - h); ctx.lineTo(x + r, y - h); }
    ctx.closePath();
  }

  /**
   * Paint one symbol's trades. The caller has already clipped to the price pane.
   *   o = { trades, bars, tf, slotW, pw, priceH, y(price), held, labels,
   *         colors: { entry, win, loss, flat, bg, text }, font }
   * Returns the hit list for hover(): [{ x, y, mark }].
   */
  function draw(ctx, o) {
    const L = layout(o.trades, o.bars, o.tf);
    const hits = [];
    if (!L.n) return hits;
    const c = o.colors, y = o.y;
    const xOf = (idx) => Math.min(idx, Math.max(L.n - 1, Math.floor(o.pw / o.slotW) - 1)) * o.slotW + o.slotW / 2;
    const toneOf = (pnl) => (pnl == null ? c.flat : pnl >= 0 ? c.win : c.loss);
    const pt = (m) => ({ x: xOf(m.idx), y: y(m.price) });
    const R = L.marks.length > DENSE_MARKS ? R_DENSE : R_ROOMY;
    ctx.save();
    ctx.font = o.font || '10px ui-monospace, Menlo, Consolas, monospace';

    // An open position: its entry price and its stop, out to the right edge. Only while
    // the account still holds the name, when that is known.
    const plates = [];                                        // label boxes already painted
    const plate = (txt, x, yy, align, colour) => {
      const w = ctx.measureText(txt).width + 6, h = 13;
      let bx = align === 'right' ? x - w : x;
      bx = Math.max(1, Math.min(o.pw - w - 1, bx));
      const by = Math.max(1, Math.min(o.priceH - h - 1, yy - h / 2));
      const box = { x: bx, y: by, w, h };
      if (plates.some((p) => bx < p.x + p.w + 2 && bx + w + 2 > p.x && by < p.y + p.h + 1 && by + h + 1 > p.y)) return false;
      plates.push(box);
      ctx.save();
      ctx.globalAlpha = 0.86; ctx.fillStyle = c.bg; ctx.fillRect(bx, by, w, h);
      ctx.globalAlpha = 1; ctx.fillStyle = colour; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(txt, bx + 3, by + h / 2 + 0.5);
      ctx.restore();
      return true;
    };
    if (o.held !== false) {
      for (const tr of L.open) {
        const em = L.marks.find((m) => m.trade === tr && m.kind === 'entry');
        const x0 = em ? xOf(em.idx) : 0;
        const line = (price, colour, txt) => {
          const yy = Math.round(y(price)) + 0.5;
          // Off the visible prices (a stop 8% under a chart showing 3%): no line to draw,
          // so the level is named at the edge it lies beyond. The scale is left alone.
          if (!(yy >= 0)) { plate(txt + ' ↑', o.pw - 3, 8, 'right', colour); return; }
          if (!(yy <= o.priceH)) { plate(txt + ' ↓', o.pw - 3, o.priceH - 8, 'right', colour); return; }
          ctx.save();
          ctx.strokeStyle = colour; ctx.lineWidth = 1; ctx.setLineDash([5, 4]); ctx.globalAlpha = 0.9;
          ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(o.pw, yy); ctx.stroke();
          ctx.restore();
          plate(txt, o.pw - 3, yy - 8, 'right', colour);
        };
        line(tr.entry.price, c.entry, 'Entry ' + fmtPrice(tr.entry.price) + (em ? '' : '  ·  in ' + fmtTime(tr.entry.ts, { short: true })));
        if (tr.stop > 0) line(tr.stop, c.loss, 'Stop ' + fmtPrice(tr.stop));
      }
    }

    // Entry to exit, joined: the round trip reads as one thing.
    for (const m of L.marks) {
      if (m.kind !== 'exit') continue;
      const em = L.marks.find((e) => e.trade === m.trade && e.kind === 'entry');
      if (!em) continue;
      const a = pt(em), b = pt(m);
      ctx.save();
      ctx.strokeStyle = toneOf(m.exit.pnl); ctx.globalAlpha = 0.55; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.restore();
    }

    // The marks, then their labels (newest first, so the latest trade wins the room).
    for (const m of L.marks) {
      const p = pt(m), entry = m.kind === 'entry';
      const colour = entry ? c.entry : toneOf(m.exit.pnl);
      const hollow = !entry && m.exit.time_approx;
      _tri(ctx, p.x, p.y, entry, R);
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3; ctx.strokeStyle = c.bg; ctx.stroke();   // a halo, so it reads over candles
      ctx.fillStyle = hollow ? c.bg : colour; ctx.fill();
      ctx.lineWidth = 1.4; ctx.strokeStyle = colour; ctx.stroke();
      hits.push({ x: p.x, y: p.y + (entry ? R : -R), mark: m });
    }
    if (o.labels !== false) {
      const clock = (ts) => {
        const t = _ms(ts); if (t == null) return '';
        const d = new Date(t);
        const hm = d.toLocaleTimeString('en-US', { timeZone: NY, hour: 'numeric', minute: '2-digit', hour12: true });
        return INTRADAY.indexOf(o.tf) !== -1 ? hm : d.toLocaleDateString('en-US', { timeZone: NY, month: 'short', day: 'numeric' }) + ' ' + hm;
      };
      const newest = L.marks.length ? L.marks[L.marks.length - 1].trade : null;
      for (let i = L.marks.length - 1; i >= 0; i--) {
        const m = L.marks[i], p = pt(m), entry = m.kind === 'entry';
        if (L.marks.length > LABEL_ALL_MARKS && m.trade !== newest) continue;
        if (!(p.y >= 0 && p.y <= o.priceH)) continue;
        const txt = entry ? 'Buy ' + clock(m.trade.entry.ts)
          : 'Sell ' + (m.exit.time_approx ? '≈' : '') + clock(m.exit.ts) + (m.exit.pnl != null ? ' ' + fmtMoney(m.exit.pnl).replace(/\.\d\d$/, '') : '');
        const ly = p.y + (entry ? R * 1.8 + 1 : -(R * 1.8 + 1)), colour = entry ? c.entry : toneOf(m.exit.pnl);
        // Right of the mark; left of it when that room is taken.
        if (!plate(txt, p.x + R + 3, ly, 'left', colour)) plate(txt, p.x - R - 3, ly, 'right', colour);
      }
    }
    ctx.restore();
    return hits;
  }

  // ── the card (DOM, built on demand) ──────────────────────────────────────────
  const hitsFor = {};        // canvas id -> { hits, held }
  let styled = false, stickyUntil = 0, listening = false;

  function _style() {
    if (styled || typeof document === 'undefined') return;
    styled = true;
    const st = document.createElement('style');
    st.textContent = '.tm-tip{position:absolute;z-index:9;display:none;pointer-events:none;max-width:min(330px,calc(100% - 8px));box-sizing:border-box;'
      + 'padding:7px 9px;border-radius:6px;border:1px solid var(--border,#2a2e39);background:var(--bg2,#14171c);color:var(--text0,#e8eaed);'
      + 'font-family:var(--mono,ui-monospace,Menlo,Consolas,monospace);font-size:11px;line-height:1.45;box-shadow:0 6px 18px rgba(0,0,0,.28)}'
      + '.tm-tip b{display:block;font-size:11.5px;margin-bottom:3px}'
      + '.tm-tip .tm-r{display:flex;gap:8px}.tm-tip .tm-k{flex:0 0 46px;color:var(--text2,#8892a0)}.tm-tip .tm-v{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}'
      + '.tm-tip .tm-here .tm-k{color:var(--text0,#e8eaed);font-weight:700}'
      + '.tm-tip .tm-win{color:var(--green,#00d4aa)}.tm-tip .tm-loss{color:var(--red,#ff5f6d)}'
      + '.tm-tip .tm-n{margin:0 0 2px 54px;font-size:10px;color:var(--text2,#8892a0)}';
    document.head.appendChild(st);
  }
  function _listen() {
    if (listening || typeof document === 'undefined') return;
    listening = true;
    // A tap ends in the same instant it starts. The page hides its crosshair on touchend;
    // the card outlives that, until the next touch.
    document.addEventListener('touchend', () => { stickyUntil = Date.now() + 250; }, true);
    document.addEventListener('touchstart', (e) => {
      stickyUntil = 0;
      for (const el of document.querySelectorAll('.tm-tip')) if (!e.target.closest || el.parentNode !== e.target.closest('.zone-ladder')) el.style.display = 'none';
    }, true);
  }

  /** Remember what was painted on a canvas, for hover(). */
  function remember(canvasId, hits, held) { hitsFor[canvasId] = { hits: hits || [], held: held == null ? null : held }; }

  /** The mark under (x, y), within `reach` pixels. */
  function hitAt(canvasId, x, y, reach) {
    const h = hitsFor[canvasId];
    if (!h || !h.hits.length) return null;
    let best = null, bd = (reach || 12) * (reach || 12);
    for (const it of h.hits) {
      const d = (it.x - x) * (it.x - x) + (it.y - y) * (it.y - y);
      if (d <= bd) { bd = d; best = it; }
    }
    return best;
  }

  /** Show the card for the mark under the pointer, or hide it. Returns true when shown. */
  function hover(ladder, canvasId, x, y, opts) {
    if (!ladder) return false;
    const hit = hitAt(canvasId, x, y, opts && opts.touch ? 26 : 12);
    if (!hit) { unhover(ladder, true); return false; }
    _style(); _listen();
    let tip = ladder._tmTip;
    if (!tip) { tip = ladder._tmTip = document.createElement('div'); tip.className = 'tm-tip'; ladder.appendChild(tip); }
    if (tip._mark !== hit.mark) {
      tip._mark = hit.mark;
      const d = describe(hit.mark, hitsFor[canvasId].held);
      tip.textContent = '';
      const b = document.createElement('b'); b.textContent = d.title; tip.appendChild(b);
      for (const r of d.rows) {
        const row = document.createElement('div'); row.className = 'tm-r' + (r.here ? ' tm-here' : '');
        const k = document.createElement('span'); k.className = 'tm-k'; k.textContent = r.k;
        const v = document.createElement('span'); v.className = 'tm-v' + (r.tone ? ' tm-' + r.tone : ''); v.textContent = r.v;
        row.appendChild(k); row.appendChild(v); tip.appendChild(row);
        if (r.note) { const n = document.createElement('div'); n.className = 'tm-n'; n.textContent = r.note; tip.appendChild(n); }
      }
    }
    tip.style.display = 'block';
    // Beside the mark, inside the chart: right of it when there is room, else left; below
    // it when there is room, else above.
    const W = ladder.clientWidth, H = ladder.clientHeight, tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = hit.x + 14; if (left + tw > W - 4) left = hit.x - 14 - tw; left = Math.max(4, Math.min(W - tw - 4, left));
    let top = hit.y + 12; if (top + th > H - 4) top = hit.y - 12 - th; top = Math.max(4, Math.min(H - th - 4, top));
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
    return true;
  }
  function unhover(ladder, force) {
    const tip = ladder && ladder._tmTip;
    if (!tip || (!force && Date.now() < stickyUntil)) return;
    tip.style.display = 'none';
  }

  // ── the data ─────────────────────────────────────────────────────────────────
  const state = { version: null, symbols: {}, loaded: false };

  /** Fetch the trades; resolves true when what a chart draws has changed. */
  async function load(fetchImpl) {
    const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!f) return false;
    try {
      const r = await f(ENDPOINT + (state.version ? '?have=' + encodeURIComponent(state.version) : ''), { cache: 'no-store' });
      if (!r || !r.ok || !/json/i.test((r.headers && r.headers.get && r.headers.get('content-type')) || 'json')) return false;
      const d = await r.json();
      if (!d || d.unchanged || !d.symbols || typeof d.symbols !== 'object') return false;
      state.version = d.version || null; state.symbols = d.symbols; state.loaded = true;
      return true;
    } catch (_e) { return false; }                            // a chart without marks, never a broken chart
  }
  const forSymbol = (sym) => state.symbols[String(sym || '').toUpperCase()] || [];

  return {
    ENDPOINT, INTRADAY, nyDay, barDay, placer, layout, describe,
    fmtTime, fmtPrice, fmtMoney, fmtHeld,
    draw, remember, hitAt, hover, unhover, load, forSymbol,
    _state: state,
    _resetForTests() { state.version = null; state.symbols = {}; state.loaded = false; for (const k of Object.keys(hitsFor)) delete hitsFor[k]; },
  };
}));
