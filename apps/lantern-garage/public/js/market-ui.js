/* market-ui.js — what every market page draws with (2026-10-11): number formatting, an
   instrument tile, a quote table, an area chart. /markets.html and /market.html share it,
   so a price reads the same way on both.

   Data is always TEXT: a name or a symbol from the feed goes in with textContent, never
   through innerHTML. */
(function (global) {
  'use strict';
  var SVGNS = 'http://www.w3.org/2000/svg';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function svg(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }
  function get(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function isNum(n) { return n != null && n !== '' && isFinite(Number(n)); }

  // Yahoo's price hint says how many decimals a quote carries (2 for an index, 4 for a
  // currency pair). Below 1 the price also keeps four significant figures whatever the
  // hint says: SHIB at 0.00000547 carries a hint of 5 and printed as "0.00001".
  function decimals(r) {
    var p = Math.abs(Number(r && r.price));
    var d = r && typeof r.hint === 'number' && r.hint >= 0 ? Math.min(8, r.hint) : (p >= 1 ? 2 : 4);
    if (isFinite(p) && p > 0 && p < 1) d = Math.max(d, Math.min(10, Math.ceil(-Math.log10(p)) + 3));
    return d;
  }
  function fmt(n, d) {
    if (!isNum(n)) return '—';
    var k = d == null ? 2 : d;
    return Number(n).toLocaleString(undefined, { minimumFractionDigits: k, maximumFractionDigits: k });
  }
  function price(r) { return r ? fmt(r.price, decimals(r)) : '—'; }
  function pct(n) { if (!isNum(n)) return '—'; var v = Number(n); return (v > 0 ? '+' : '') + v.toFixed(2) + '%'; }
  function signed(n, d) { if (!isNum(n)) return '—'; var v = Number(n); return (v > 0 ? '+' : '') + fmt(v, d); }
  function dirCls(n) { if (!isNum(n)) return 'flat'; var v = Number(n); return v === 0 ? 'flat' : v > 0 ? 'up' : 'down'; }
  function big(n) {
    if (!isNum(n)) return '—';
    var v = Number(n), u = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (var i = 0; i < u.length; i++) if (Math.abs(v) >= u[i][0]) return (v / u[i][0]).toFixed(2) + u[i][1];
    return String(Math.round(v));
  }
  function symHref(sym) { return '/symbol.html?t=' + encodeURIComponent(sym); }
  function ago(ms) {
    var t = Number(ms);
    if (!isFinite(t) || t <= 0) return '';
    var m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    var h = Math.round(m / 60);
    return h < 48 ? h + 'h ago' : Math.round(h / 24) + 'd ago';
  }

  // The moving-average read, in words. It is where the price sits against its own 50- and
  // 200-day averages — a description, never a buy or sell call.
  function trend(r) {
    if (!r || !isNum(r.price) || !isNum(r.avg50) || !isNum(r.avg200)) return null;
    var a50 = Number(r.price) > Number(r.avg50), a200 = Number(r.price) > Number(r.avg200);
    if (a50 && a200) return { text: 'Above 50d · 200d', cls: 'up' };
    if (!a50 && !a200) return { text: 'Below 50d · 200d', cls: 'down' };
    return { text: a200 ? 'Above 200d only' : 'Above 50d only', cls: 'flat' };
  }
  function trendChip(r) {
    var t = trend(r);
    return t ? el('span', 'trend ' + t.cls, t.text) : el('span', 'trend flat', '—');
  }
  function badge(r) { return el('span', 'badge', String((r && (r.short || r.symbol)) || '—').replace(/[^A-Z0-9]/gi, '').slice(0, 3)); }

  /** One instrument: name, code, price with its unit, the day's move. Links to its page. */
  function tile(r) {
    var a = el('a', 'tile');
    a.href = symHref(r.symbol);
    a.appendChild(el('div', 'tn', r.name || r.symbol));
    a.appendChild(el('div', 'tc', r.short || r.symbol));
    var p = el('div', 'tp', price(r));
    if (r.unit) p.appendChild(el('span', 'tu', r.unit));
    a.appendChild(p);
    a.appendChild(el('div', 'tm ' + dirCls(r.chg_pct), pct(r.chg_pct)));
    return a;
  }

  /** The name cell every table starts with: badge, name, code. */
  function nameCell(r) {
    var td = el('td');
    var a = el('a', 'qn');
    a.href = symHref(r.symbol);
    a.appendChild(badge(r));
    var w = el('span', 'ql');
    w.appendChild(el('span', 'qnn', r.name || r.symbol));
    var sub = (r.short || r.symbol) + (r.unit ? ' · ' + r.unit : '')
      + (r.kind === 'leveraged' ? ' · leveraged fund' : r.kind === 'etf' ? ' · ETF' : '');
    w.appendChild(el('div', 'qns', sub));
    a.appendChild(w);
    td.appendChild(a);
    return td;
  }

  /** A quote table. cols: [{ label, cell(r) -> string | Node, cls?(r) -> string }]. */
  function table(rows, cols) {
    var wrap = el('div', 'qwrap');
    var t = el('table', 'qtable');
    var thead = el('thead'), hr = el('tr');
    hr.appendChild(el('th', null, 'Name'));
    cols.forEach(function (c) { var th = el('th', null, c.label); th.scope = 'col'; hr.appendChild(th); });
    thead.appendChild(hr);
    t.appendChild(thead);
    var tb = el('tbody');
    rows.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(nameCell(r));
      cols.forEach(function (c) {
        var v = c.cell(r);
        var td = el('td', c.cls ? c.cls(r) : null);
        if (v && typeof v === 'object' && v.nodeType) td.appendChild(v); else td.textContent = v == null ? '—' : String(v);
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    wrap.appendChild(t);
    return wrap;
  }

  // Column builders, so each page names its columns instead of re-writing them.
  var COL = {
    price: { label: 'Price', cell: function (r) { return price(r); } },
    chgPct: { label: 'Chg %', cell: function (r) { return pct(r.chg_pct); }, cls: function (r) { return dirCls(r.chg_pct); } },
    chg: { label: 'Chg', cell: function (r) { return signed(r.chg, decimals(r)); }, cls: function (r) { return dirCls(r.chg); } },
    high: { label: 'High', cell: function (r) { return isNum(r.high) ? fmt(r.high, decimals(r)) : '—'; } },
    low: { label: 'Low', cell: function (r) { return isNum(r.low) ? fmt(r.low, decimals(r)) : '—'; } },
    volume: { label: 'Volume', cell: function (r) { return big(r.volume); } },
    mcap: { label: 'Mkt cap', cell: function (r) { return isNum(r.mcap) ? '$' + big(r.mcap) : '—'; } },
    supply: { label: 'Circ. supply', cell: function (r) { return big(r.supply); } },
    trend: { label: 'Trend', cell: function (r) { return trendChip(r); } },
  };
  function perfCol(key, label) {
    return { label: label, cell: function (r) { return pct(r.perf && r.perf[key]); },
             cls: function (r) { return dirCls(r.perf && r.perf[key]); } };
  }
  var PERF = [perfCol('w1', '1W'), perfCol('m1', '1M'), perfCol('m3', '3M'), perfCol('m6', '6M'),
              perfCol('ytd', 'YTD'), perfCol('y1', '1Y')];

  /** An area chart over [[ms, close], …]. Green when the window ended above where it is
   *  measured from (opts.base, else the first point), red when below. A base is drawn as
   *  a dotted line — the previous close on a 1D chart. */
  function areaChart(points, opts) {
    var o = opts || {};
    var W = 1000, H = o.height || 220, PAD = 8;
    var vals = (points || []).map(function (p) { return Number(p[1]); }).filter(isFinite);
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', class: o.cls || 'mk-chart',
                         role: 'img', 'aria-label': (o.label || 'Price') + ', ' + vals.length + ' points' });
    if (vals.length < 2) return s;
    var base = isNum(o.base) && Number(o.base) > 0 ? Number(o.base) : null;
    var lo = Math.min.apply(null, vals.concat(base ? [base] : []));
    var hi = Math.max.apply(null, vals.concat(base ? [base] : []));
    var span = (hi - lo) || 1;
    var c = vals[vals.length - 1] >= (base || vals[0]) ? 'var(--green)' : 'var(--red)';
    var x = function (i) { return (i / (vals.length - 1)) * W; };
    var y = function (v) { return PAD + (1 - (v - lo) / span) * (H - PAD * 2); };
    var d = vals.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join(' ');
    var id = 'mg' + Math.random().toString(36).slice(2, 8);
    var defs = svg('defs', {}), g = svg('linearGradient', { id: id, x1: '0', y1: '0', x2: '0', y2: '1' });
    g.appendChild(svg('stop', { offset: '0%', 'stop-color': c, 'stop-opacity': '.24' }));
    g.appendChild(svg('stop', { offset: '100%', 'stop-color': c, 'stop-opacity': '0' }));
    defs.appendChild(g);
    s.appendChild(defs);
    s.appendChild(svg('path', { d: d + ' L ' + W + ' ' + H + ' L 0 ' + H + ' Z', fill: 'url(#' + id + ')' }));
    s.appendChild(svg('path', { d: d, fill: 'none', stroke: c, 'stroke-width': '2', 'stroke-linejoin': 'round',
                                'vector-effect': 'non-scaling-stroke' }));
    if (base) {
      s.appendChild(svg('line', { x1: '0', x2: String(W), y1: y(base).toFixed(1), y2: y(base).toFixed(1),
                                  stroke: 'var(--muted)', 'stroke-width': '1', 'stroke-dasharray': '3 5',
                                  'vector-effect': 'non-scaling-stroke', opacity: '.7' }));
    }
    return s;
  }

  /** A range switcher of buttons; calls onPick(id) and marks the pressed one. */
  function rangeBar(ids, current, onPick) {
    var bar = el('span', 'tfbar');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Range');
    ids.forEach(function (id) {
      var b = el('button', 'tf' + (id === current ? ' on' : ''), id);
      b.type = 'button';
      b.setAttribute('aria-pressed', id === current ? 'true' : 'false');
      b.onclick = function () {
        [].forEach.call(bar.children, function (c) {
          var on = c === b;
          c.className = 'tf' + (on ? ' on' : '');
          c.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        onPick(id);
      };
      bar.appendChild(b);
    });
    return bar;
  }

  /** The lead chart card: name, last price, the move over the window, and the switcher. */
  function leadChart(box, lead, ranges, first) {
    box.innerHTML = '';
    var head = el('div', 'mk-lead-h');
    var nameA = el('a', 'ln', lead.name || lead.symbol);
    nameA.href = symHref(lead.symbol);
    nameA.style.color = 'inherit';
    nameA.style.textDecoration = 'none';
    head.appendChild(nameA);
    var last = el('span', 'lp', '—');
    var mv = el('span', 'ch');
    head.appendChild(last);
    head.appendChild(mv);
    head.appendChild(el('span', 'spacer'));
    var area = el('div');
    function draw(r) {
      area.innerHTML = '';
      area.appendChild(el('div', 'state', 'Loading ' + r + '…'));
      get('/api/trading/markets/series?s=' + encodeURIComponent(lead.symbol) + '&r=' + encodeURIComponent(r))
        .then(function (d) {
          var pts = (d && d.points) || [];
          area.innerHTML = '';
          if (pts.length < 2) { area.appendChild(el('div', 'state', 'No price history over this range.')); return; }
          area.appendChild(areaChart(pts, { label: lead.name, base: d.base }));
          // 1D shows the quote's own price and change (d.last), the same numbers as every
          // row beside it; a longer window is measured from its own first point.
          var a = isNum(d.base) && d.base > 0 ? Number(d.base) : pts[0][1], b = pts[pts.length - 1][1];
          var ch = a ? ((b - a) / a) * 100 : null;
          if (r === '1D' && d.last && isNum(d.last.price)) { b = Number(d.last.price); ch = d.last.chg_pct; }
          last.textContent = fmt(b, decimals({ price: b, hint: lead.hint }));
          mv.className = 'ch ' + dirCls(ch);
          mv.textContent = pct(ch) + ' · ' + (r === '1D' && d.base ? 'today' : r);
        })
        .catch(function (e) { area.innerHTML = ''; area.appendChild(el('div', 'state err', 'Could not load the chart (' + e.message + ').')); });
    }
    head.appendChild(rangeBar(ranges, first, draw));
    box.appendChild(head);
    box.appendChild(area);
    draw(first);
  }

  global.MarketUI = {
    el: el, svg: svg, get: get, isNum: isNum, fmt: fmt, price: price, pct: pct, signed: signed,
    dirCls: dirCls, big: big, decimals: decimals, symHref: symHref, ago: ago, trend: trend,
    trendChip: trendChip, badge: badge, tile: tile, table: table, COL: COL, PERF: PERF,
    areaChart: areaChart, rangeBar: rangeBar, leadChart: leadChart,
  };
})(window);
