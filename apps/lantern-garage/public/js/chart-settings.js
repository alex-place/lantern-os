/*
 * chart-settings.js — the trading chart's own settings (the ⚙ on the trader toolbar).
 *
 * WHY A SCHEMA. TradingView's chart settings are seven tabs of switches, and the reason
 * they never feel like seven tabs of switches is that every one of them does exactly what
 * it says. The way to keep that promise across a hundred controls is to have ONE table
 * describe them -- key, type, default, label, where it sits -- and let everything else be
 * derived from it: the dialog renders from the table, normalise() validates against it,
 * the tests walk it and refuse any key the chart never reads. A checkbox that is wired to
 * nothing cannot be added here without a test noticing.
 *
 * WHAT IS STORED. Only the DIFFERENCE from the defaults, as flat dot-keys
 * ({ 'candles.bodyUp': '#00c805' }). Two reasons. A reader who never touched a setting
 * keeps following the product's defaults when those change -- a saved copy of every
 * default would freeze them at whatever they were the day the dialog was first opened.
 * And the same object travels to the account (preferences.chart, #3592's pattern), where
 * small is polite.
 *
 * null MEANS "FOLLOW THE THEME". Every colour here is nullable and null by default: the
 * candle colours follow the reader's gain/loss palette (#3592), the grid and axis follow
 * the light/dark theme. A stored hex is an explicit override and nothing else is. This is
 * what keeps the palette work winning for everyone who has not asked for something else,
 * and what lets "Reset" mean something.
 *
 * TWO RUNTIMES. Loaded by the trader page in <head> (it defines window.ChartSettings) and
 * require()d by the tests. No DOM is touched at load; the dialog is built on demand.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChartSettings = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORAGE_KEY = 'trader.chart';
  const TEMPLATE_KEY = 'trader.chartTemplates';
  const MAX_TEMPLATES = 12;

  const LINE_STYLES = [{ v: 'solid', l: 'Solid' }, { v: 'dashed', l: 'Dashed' }, { v: 'dotted', l: 'Dotted' }];
  const TIMEZONES = [
    { v: 'exchange', l: 'Exchange (New York)' }, { v: 'local', l: 'Your device' }, { v: 'UTC', l: 'UTC' },
    { v: 'America/Chicago', l: 'Chicago' }, { v: 'America/Los_Angeles', l: 'Los Angeles' },
    { v: 'Europe/London', l: 'London' }, { v: 'Europe/Berlin', l: 'Berlin' },
    { v: 'Asia/Tokyo', l: 'Tokyo' }, { v: 'Asia/Singapore', l: 'Singapore' }, { v: 'Australia/Sydney', l: 'Sydney' },
  ];

  /* ── the fields ────────────────────────────────────────────────────────────
     key → { type, def, ... }. Types: check · color (nullable hex) · select · number · range.
     Every key the chart reads is here and nowhere else. */
  const F = {};
  const check = (k, def) => { F[k] = { type: 'check', def: !!def }; };
  const color = (k, def) => { F[k] = { type: 'color', def: def == null ? null : def }; };
  const select = (k, def, options) => { F[k] = { type: 'select', def, options }; };
  const number = (k, def, min, max, step) => { F[k] = { type: 'number', def, min, max, step: step || 1 }; };
  const range = (k, def) => { F[k] = { type: 'range', def, min: 0, max: 100, step: 1 }; };

  // Symbol
  check('candles.byPrevClose', false);
  check('candles.body', true);   color('candles.bodyUp');   color('candles.bodyDown');
  check('candles.border', false); color('candles.borderUp'); color('candles.borderDown');
  check('candles.wick', true);   color('candles.wickUp');   color('candles.wickDown');
  color('line.color'); number('line.width', 2, 1, 5, 0.5); check('line.area', true);
  // Regular hours by default, as TradingView's RTH: the range densities are built on the
  // regular session (1D at 1m is 390 candles). Extended hours are the RTH/ETH toggle on
  // the strip under the charts, and here.
  select('data.session', 'regular', [{ v: 'regular', l: 'Regular hours only' }, { v: 'extended', l: 'Extended hours' }]);
  select('data.precision', 'default', [{ v: 'default', l: 'Default' }, { v: '0', l: '0' }, { v: '1', l: '1' }, { v: '2', l: '2' }, { v: '3', l: '3' }, { v: '4', l: '4' }]);
  select('data.timezone', 'exchange', TIMEZONES);
  // Status line
  check('status.ohlc', false); check('status.change', false); check('status.volume', false);
  check('status.indTitles', true); check('status.indInputs', true); check('status.indValues', true);
  // The legend's TEXT is its own decision, apart from the line's colour: a reader may want
  // a blue EMA and a legend that stays black or white.
  select('status.indText', 'line', [{ v: 'line', l: 'Line colour' }, { v: 'text', l: 'Chart text' }, { v: 'custom', l: 'Custom' }]);
  color('status.indTextColor');
  check('status.background', false); range('status.bgOpacity', 60);
  // Scales and lines
  check('scales.lastPrice', true);
  select('scales.lastPriceColor', 'neutral', [{ v: 'neutral', l: 'Neutral' }, { v: 'direction', l: 'By bar direction' }]);
  check('scales.prevClose', false); color('scales.prevCloseColor');
  check('scales.highLow', false);
  check('scales.countdown', false);
  check('scales.indLabels', false);
  check('scales.prePost', false); color('scales.preColor', '#ff9800'); color('scales.postColor', '#2962ff');
  check('scales.dayOfWeek', false);
  select('scales.timeFormat', '12h', [{ v: '12h', l: '12-hour' }, { v: '24h', l: '24-hour' }]);
  // Canvas
  select('canvas.bgMode', 'theme', [{ v: 'theme', l: 'Theme' }, { v: 'solid', l: 'Solid' }, { v: 'gradient', l: 'Gradient' }]);
  color('canvas.bgColor'); color('canvas.bgColor2');
  check('canvas.vGrid', true); check('canvas.hGrid', true); color('canvas.gridColor'); select('canvas.gridStyle', 'solid', LINE_STYLES);
  color('canvas.paneSepColor');
  color('canvas.crosshairColor'); select('canvas.crosshairStyle', 'dashed', LINE_STYLES);
  check('canvas.watermark', false); range('canvas.watermarkOpacity', 8);
  color('canvas.axisTextColor'); number('canvas.axisFontSize', 11, 9, 15, 1);
  number('canvas.marginTop', 8, 0, 40, 1); number('canvas.marginBottom', 8, 0, 40, 1); number('canvas.marginRight', 25, 0, 60, 1);
  // Trading
  check('trading.buySell', true);
  check('trading.sound', false); range('trading.soundVolume', 60);
  check('trading.rejectionsOnly', false);
  select('trading.pnl', 'percent', [{ v: 'percent', l: 'Percent' }, { v: 'money', l: 'Money' }, { v: 'hidden', l: 'Hidden' }]);
  check('trading.executionMarks', false); check('trading.executionLabels', false);
  select('trading.labelSide', 'left', [{ v: 'left', l: 'Left' }, { v: 'right', l: 'Right' }]);
  // Alerts
  check('alerts.lines', false); color('alerts.lineColor'); check('alerts.onlyActive', true);
  check('alerts.sound', false); range('alerts.soundVolume', 60); check('alerts.autoHideToasts', true);
  // Events
  check('events.sessionBreaks', false); color('events.sessionBreakColor');

  const FIELDS = F;
  const KEYS = Object.keys(FIELDS);
  const DEFAULTS = {};
  for (const k of KEYS) DEFAULTS[k] = FIELDS[k].def;

  /* ── the dialog, as data ───────────────────────────────────────────────────
     Tabs → sections → rows. A row names the keys it edits; nothing else. `external`
     rows edit state the PAGE owns (the pattern layers) and are not stored here -- they
     appear in the dialog because a reader looking for "show my entry line" should find
     it where TradingView puts it, not have to learn a second menu. */
  const TABS = [
    { id: 'symbol', label: 'Symbol', sections: [
      { title: 'Candles', rows: [
        { row: 'check', k: 'candles.byPrevClose', label: 'Colour bars based on previous close',
          hint: 'Up when the close beats the previous bar’s close, instead of its own open.' },
        { row: 'colorpair', toggle: 'candles.body', up: 'candles.bodyUp', down: 'candles.bodyDown', label: 'Body' },
        { row: 'colorpair', toggle: 'candles.border', up: 'candles.borderUp', down: 'candles.borderDown', label: 'Borders' },
        { row: 'colorpair', toggle: 'candles.wick', up: 'candles.wickUp', down: 'candles.wickDown', label: 'Wick' },
      ] },
      { title: 'Line chart', rows: [
        { row: 'color', k: 'line.color', label: 'Line colour', hint: 'Follows the gain/loss colour of the visible window unless set.' },
        { row: 'number', k: 'line.width', label: 'Line width', unit: 'px' },
        { row: 'check', k: 'line.area', label: 'Shade the area under the line' },
      ] },
      { title: 'Data', rows: [
        { row: 'select', k: 'data.session', label: 'Session' },
        { row: 'select', k: 'data.precision', label: 'Precision' },
        { row: 'select', k: 'data.timezone', label: 'Timezone' },
      ] },
    ] },
    { id: 'status', label: 'Status line', sections: [
      { title: 'Chart values', rows: [
        { row: 'check', k: 'status.ohlc', label: 'Open, high, low, close', hint: 'For the bar under the cursor, or the last bar.' },
        { row: 'check', k: 'status.change', label: 'Bar change values' },
        { row: 'check', k: 'status.volume', label: 'Volume' },
      ] },
      { title: 'Indicators', rows: [
        { row: 'check', k: 'status.indTitles', label: 'Titles' },
        { row: 'check', k: 'status.indInputs', label: 'Inputs', hint: 'EMA 21 rather than EMA.' },
        { row: 'check', k: 'status.indValues', label: 'Values' },
        { row: 'selectcolor', k: 'status.indText', color: 'status.indTextColor', when: 'custom', label: 'Text colour',
          hint: 'Line colour writes each legend in its indicator’s colour; chart text keeps it black or white.' },
      ] },
      { title: 'Legend', rows: [
        { row: 'checkrange', toggle: 'status.background', range: 'status.bgOpacity', label: 'Background' },
      ] },
    ] },
    { id: 'scales', label: 'Scales and lines', sections: [
      { title: 'Price labels & lines', rows: [
        { row: 'check', k: 'scales.lastPrice', label: 'Last price line and label' },
        { row: 'select', k: 'scales.lastPriceColor', label: 'Last price colour' },
        { row: 'checkcolor', toggle: 'scales.prevClose', color: 'scales.prevCloseColor', label: 'Previous day close' },
        { row: 'check', k: 'scales.highLow', label: 'High and low of the visible window' },
        { row: 'check', k: 'scales.countdown', label: 'Countdown to bar close' },
        { row: 'check', k: 'scales.indLabels', label: 'Indicator values on the price scale' },
        { row: 'checkcolor2', toggle: 'scales.prePost', a: 'scales.preColor', b: 'scales.postColor', label: 'Pre / post market',
          hint: 'Shades bars outside 09:30–16:00 ET. Only when the session includes extended hours.' },
      ] },
      { title: 'Time scale', rows: [
        { row: 'check', k: 'scales.dayOfWeek', label: 'Day of week on labels' },
        { row: 'select', k: 'scales.timeFormat', label: 'Clock' },
      ] },
    ] },
    { id: 'canvas', label: 'Canvas', sections: [
      { title: 'Chart basic styles', rows: [
        { row: 'bgmode', k: 'canvas.bgMode', a: 'canvas.bgColor', b: 'canvas.bgColor2', label: 'Background' },
        { row: 'checkcolor', toggle: 'canvas.vGrid', color: 'canvas.gridColor', label: 'Vertical grid lines' },
        { row: 'checkcolor', toggle: 'canvas.hGrid', color: 'canvas.gridColor', label: 'Horizontal grid lines' },
        { row: 'select', k: 'canvas.gridStyle', label: 'Grid line style' },
        { row: 'color', k: 'canvas.paneSepColor', label: 'Pane separators' },
        { row: 'colorstyle', color: 'canvas.crosshairColor', style: 'canvas.crosshairStyle', label: 'Crosshair' },
        { row: 'checkrange', toggle: 'canvas.watermark', range: 'canvas.watermarkOpacity', label: 'Symbol watermark' },
      ] },
      { title: 'Scales', rows: [
        { row: 'color', k: 'canvas.axisTextColor', label: 'Text colour' },
        { row: 'number', k: 'canvas.axisFontSize', label: 'Text size', unit: 'px' },
      ] },
      { title: 'Margins', rows: [
        { row: 'number', k: 'canvas.marginTop', label: 'Top', unit: '%' },
        { row: 'number', k: 'canvas.marginBottom', label: 'Bottom', unit: '%' },
        { row: 'number', k: 'canvas.marginRight', label: 'Right', unit: 'bars' },
      ] },
    ] },
    { id: 'trading', label: 'Trading', sections: [
      { title: 'General', rows: [
        { row: 'check', k: 'trading.buySell', label: 'Buy/sell buttons', hint: 'Displays buy and sell buttons directly on the chart.' },
        { row: 'checkrange', toggle: 'trading.sound', range: 'trading.soundVolume', label: 'Execution sound' },
        { row: 'check', k: 'trading.rejectionsOnly', label: 'Show only rejection notifications' },
      ] },
      { title: 'Appearance', rows: [
        { row: 'external', k: 'levels', label: 'Positions and orders', hint: 'Entry, stop and target lines for an open position.' },
        { row: 'external', k: 'zones', label: 'Support and resistance zones' },
        { row: 'select', k: 'trading.pnl', label: 'Profit and loss value' },
        { row: 'check', k: 'trading.executionMarks', label: 'Execution marks', hint: 'Where your orders filled, on the bar they filled on.' },
        { row: 'check', k: 'trading.executionLabels', label: 'Execution labels' },
        { row: 'select', k: 'trading.labelSide', label: 'Order and position label side' },
      ] },
    ] },
    { id: 'alerts', label: 'Alerts', sections: [
      { title: 'Chart line visibility', rows: [
        { row: 'checkcolor', toggle: 'alerts.lines', color: 'alerts.lineColor', label: 'Alert lines' },
        { row: 'check', k: 'alerts.onlyActive', label: 'Only active alerts' },
      ] },
      { title: 'Notifications', rows: [
        { row: 'checkrange', toggle: 'alerts.sound', range: 'alerts.soundVolume', label: 'Alert sound' },
        { row: 'check', k: 'alerts.autoHideToasts', label: 'Automatically hide notifications', hint: 'Off keeps a notification up until you dismiss it.' },
      ] },
    ] },
    { id: 'events', label: 'Events', sections: [
      { title: 'Sessions', rows: [
        { row: 'checkcolor', toggle: 'events.sessionBreaks', color: 'events.sessionBreakColor', label: 'Session breaks',
          hint: 'A line where each new trading day starts, on intraday charts.' },
      ] },
    ] },
  ];

  /** Every key a row edits (externals excluded). Used by the tests and by nothing else. */
  function rowKeys(row) {
    if (row.row === 'external') return [];
    const out = [];
    for (const p of ['k', 'toggle', 'up', 'down', 'color', 'style', 'range', 'a', 'b']) if (row[p]) out.push(row[p]);
    return out;
  }

  // ── validation ─────────────────────────────────────────────────────────────
  const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

  /** One value, checked against its field. Returns undefined when it is not usable. */
  function coerce(k, v) {
    const f = FIELDS[k];
    if (!f) return undefined;
    switch (f.type) {
      case 'check': return typeof v === 'boolean' ? v : (v === 'true' ? true : v === 'false' ? false : undefined);
      case 'color': return v == null || v === '' ? null : (isHex(v) ? v.toLowerCase() : undefined);
      case 'select': return f.options.some((o) => o.v === v) ? v : undefined;
      case 'number': case 'range': {
        const n = Number(v);
        if (!Number.isFinite(n)) return undefined;
        const c = Math.min(f.max, Math.max(f.min, n));
        return f.step >= 1 ? Math.round(c) : Math.round(c / f.step) * f.step;
      }
      default: return undefined;
    }
  }

  /**
   * A full, valid settings object from anything: unknown keys are dropped, bad values fall
   * back to the default. Never throws -- a corrupted device copy or a hand-edited profile
   * must degrade to defaults, not to a chart that will not draw.
   */
  function normalise(obj) {
    const out = Object.assign({}, DEFAULTS);
    if (!obj || typeof obj !== 'object') return out;
    for (const k of KEYS) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      const v = coerce(k, obj[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  /** Only what differs from the defaults -- what gets stored and what travels. */
  function diff(obj) {
    const out = {};
    for (const k of KEYS) if (obj[k] !== DEFAULTS[k]) out[k] = obj[k];
    return out;
  }

  // ── storage ────────────────────────────────────────────────────────────────
  function readRaw(key) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
    catch (e) { return null; }
  }
  function writeRaw(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* private window: the choice lasts for this page and no longer */ }
  }
  function read() { return normalise(readRaw(STORAGE_KEY)); }
  function write(obj) {
    const d = diff(normalise(obj));
    writeRaw(STORAGE_KEY, Object.keys(d).length ? d : null);
    return d;
  }

  // ── the live copy ──────────────────────────────────────────────────────────
  let current = null;
  const listeners = [];
  function state() { if (!current) current = read(); return current; }
  function get(k) { return state()[k]; }
  function emit(keys) { for (const fn of listeners) { try { fn(keys, state()); } catch (e) { /* one bad listener must not stop the rest */ } } }
  function onChange(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; }

  /** Set one key. Returns true when the value changed. */
  function set(k, v) {
    const c = coerce(k, v);
    if (c === undefined) return false;
    const s = state();
    if (s[k] === c) return false;
    s[k] = c;
    write(s);
    emit([k]);
    return true;
  }
  /** Replace everything -- Reset and templates use this. */
  function replace(obj) {
    const next = normalise(obj);
    const changed = KEYS.filter((k) => next[k] !== state()[k]);
    current = next;
    write(next);
    if (changed.length) emit(changed);
    return changed;
  }
  function reset() { return replace({}); }
  function isDefault(k) { return state()[k] === DEFAULTS[k]; }

  /**
   * The account's copy, arriving with the session after the page has already drawn from
   * the device's. Same rule as the palette (#3592): local paints first, the account
   * corrects, and an equal copy is a no-op. Returns the keys that changed.
   */
  function adopt(remote) {
    if (!remote || typeof remote !== 'object') return [];
    const next = normalise(remote);
    const changed = KEYS.filter((k) => next[k] !== state()[k]);
    if (!changed.length) return [];
    current = next;
    write(next);
    emit(changed);
    return changed;
  }

  // ── templates ──────────────────────────────────────────────────────────────
  function templates() {
    const t = readRaw(TEMPLATE_KEY);
    return (t && typeof t === 'object' && !Array.isArray(t)) ? t : {};
  }
  function saveTemplate(name) {
    const n = String(name || '').trim().slice(0, 40);
    if (!n) return false;
    const t = templates();
    if (!t[n] && Object.keys(t).length >= MAX_TEMPLATES) return false;
    t[n] = diff(state());
    writeRaw(TEMPLATE_KEY, t);
    return true;
  }
  function applyTemplate(name) {
    const t = templates();
    if (!Object.prototype.hasOwnProperty.call(t, name)) return null;
    return replace(t[name]);
  }
  function deleteTemplate(name) {
    const t = templates();
    if (!Object.prototype.hasOwnProperty.call(t, name)) return false;
    delete t[name];
    writeRaw(TEMPLATE_KEY, Object.keys(t).length ? t : null);
    return true;
  }

  /* ── the dialog ────────────────────────────────────────────────────────────
     Built from TABS on first open, re-rendered per tab. Every control writes through
     set(), so the chart follows as you drag -- and Cancel puts back the snapshot taken
     on open, which is what makes live preview safe to offer. Nothing here runs unless a
     page calls open(); the tests never reach it. */
  let ui = null;           // { bg, modal, pane, tabs, opts, tab, snapshot, opener }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const h = (tag, attrs, html) => {
    const el = document.createElement(tag);
    for (const k in (attrs || {})) { if (attrs[k] != null && attrs[k] !== false) el.setAttribute(k, attrs[k] === true ? '' : attrs[k]); }
    if (html != null) el.innerHTML = html;
    return el;
  };

  /** What a null colour currently paints, for the swatch. The page knows; we ask it. */
  function shown(k) {
    const v = get(k);
    if (v != null) return v;
    try { const r = ui && ui.opts.resolveDefault && ui.opts.resolveDefault(k); if (r) return r; } catch (e) { /* the swatch stays neutral */ }
    return '#808080';
  }

  /** A colour swatch: click to pick; the ↺ (only when overridden) goes back to the theme. */
  function swatch(k, label) {
    const wrap = h('span', { class: 'cs-sw' + (get(k) == null ? ' auto' : ''), title: get(k) == null ? label + ' — following the theme' : label });
    const inp = h('input', { type: 'color', 'aria-label': label, value: toHex6(shown(k)) });
    const chip = h('i', { style: 'background:' + esc(shown(k)) });
    inp.addEventListener('input', () => { set(k, inp.value); chip.style.background = inp.value; wrap.classList.remove('auto'); undo.hidden = false; wrap.title = label; });
    const undo = h('button', { type: 'button', class: 'cs-sw-undo', title: 'Back to the theme colour', 'aria-label': label + ': back to the theme colour', hidden: get(k) == null }, '↺');
    undo.addEventListener('click', () => { set(k, null); inp.value = toHex6(shown(k)); chip.style.background = shown(k); wrap.classList.add('auto'); undo.hidden = true; wrap.title = label + ' — following the theme'; });
    wrap.append(inp, chip, undo);
    return wrap;
  }
  /** <input type=color> only accepts #rrggbb; a theme value may be rgb()/rgba(). */
  function toHex6(c) {
    if (isHex(c)) return c.toLowerCase();
    const m = String(c || '').match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
    if (!m) return '#808080';
    return '#' + [m[1], m[2], m[3]].map((n) => Math.max(0, Math.min(255, Math.round(+n))).toString(16).padStart(2, '0')).join('');
  }
  function checkbox(k, label, ext) {
    const inp = h('input', { type: 'checkbox', 'aria-label': label });
    inp.checked = ext ? !!ext.get() : !!get(k);
    inp.addEventListener('change', () => { if (ext) ext.set(inp.checked); else set(k, inp.checked); });
    return inp;
  }
  function selectEl(k, label) {
    const f = FIELDS[k];
    const sel = h('select', { 'aria-label': label });
    for (const o of f.options) { const op = h('option', { value: o.v }, esc(o.l)); if (o.v === get(k)) op.selected = true; sel.appendChild(op); }
    sel.addEventListener('change', () => set(k, sel.value));
    return sel;
  }
  function numberEl(k, label, unit) {
    const f = FIELDS[k];
    const wrap = h('span', { class: 'cs-num' });
    const inp = h('input', { type: 'number', 'aria-label': label, min: f.min, max: f.max, step: f.step, value: get(k) });
    inp.addEventListener('input', () => { if (inp.value !== '') set(k, inp.value); });
    inp.addEventListener('blur', () => { inp.value = get(k); });     // show what was actually kept
    wrap.appendChild(inp);
    if (unit) wrap.appendChild(h('span', { class: 'cs-unit' }, esc(unit)));
    return wrap;
  }
  function rangeEl(k, label) {
    const inp = h('input', { type: 'range', 'aria-label': label, min: 0, max: 100, step: 1, value: get(k) });
    inp.addEventListener('input', () => set(k, inp.value));
    return inp;
  }

  function renderRow(row) {
    const li = h('div', { class: 'cs-row cs-' + row.row });
    const lab = h('span', { class: 'cs-label' }, esc(row.label));
    const ctl = h('span', { class: 'cs-ctl' });
    switch (row.row) {
      case 'check': li.append(checkbox(row.k, row.label), lab); break;
      case 'external': {
        const ext = ui.opts.externals && ui.opts.externals[row.k];
        if (!ext) return null;                          // the page did not offer it: no dead switch
        li.append(checkbox(null, row.label, ext), lab); break;
      }
      case 'color': li.append(lab, ctl); ctl.append(swatch(row.k, row.label)); break;
      case 'colorpair': li.append(checkbox(row.toggle, row.label), lab, ctl); ctl.append(swatch(row.up, row.label + ' up'), swatch(row.down, row.label + ' down')); break;
      case 'checkcolor': li.append(checkbox(row.toggle, row.label), lab, ctl); ctl.append(swatch(row.color, row.label)); break;
      case 'checkcolor2': li.append(checkbox(row.toggle, row.label), lab, ctl); ctl.append(swatch(row.a, row.label + ' pre'), swatch(row.b, row.label + ' post')); break;
      case 'colorstyle': li.append(lab, ctl); ctl.append(swatch(row.color, row.label), selectEl(row.style, row.label + ' style')); break;
      case 'checkrange': li.append(checkbox(row.toggle, row.label), lab, ctl); ctl.append(rangeEl(row.range, row.label + ' opacity')); break;
      case 'select': li.append(lab, ctl); ctl.append(selectEl(row.k, row.label)); break;
      case 'number': li.append(lab, ctl); ctl.append(numberEl(row.k, row.label, row.unit)); break;
      case 'selectcolor': {
        // A select, and a swatch that only appears for the option that needs one.
        li.append(lab, ctl);
        const sel = selectEl(row.k, row.label), sw = swatch(row.color, row.label);
        const sync = () => { sw.hidden = get(row.k) !== row.when; };
        sel.addEventListener('change', sync); sync();
        ctl.append(sel, sw); break;
      }
      case 'bgmode': {
        li.append(lab, ctl);
        const sel = selectEl(row.k, row.label), a = swatch(row.a, row.label), b = swatch(row.b, row.label + ' second colour');
        const sync = () => { a.hidden = get(row.k) === 'theme'; b.hidden = get(row.k) !== 'gradient'; };
        sel.addEventListener('change', sync); sync();
        ctl.append(sel, a, b); break;
      }
      default: return null;
    }
    if (row.hint) li.appendChild(h('p', { class: 'cs-hint' }, esc(row.hint)));
    return li;
  }

  function renderPane() {
    const tab = TABS.find((t) => t.id === ui.tab) || TABS[0];
    ui.pane.innerHTML = '';
    ui.pane.setAttribute('aria-labelledby', 'cs-tab-' + tab.id);
    for (const sec of tab.sections) {
      const s = h('section', { class: 'cs-section' });
      s.appendChild(h('h3', null, esc(sec.title)));
      let n = 0;
      for (const row of sec.rows) { const el = renderRow(row); if (el) { s.appendChild(el); n += 1; } }
      if (n) ui.pane.appendChild(s);
    }
    for (const b of ui.tabs.querySelectorAll('[role=tab]')) {
      const on = b.dataset.tab === tab.id;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('on', on);
    }
  }

  function renderTemplateMenu() {
    const m = ui.tplMenu; m.innerHTML = '';
    const t = templates(), names = Object.keys(t);
    if (names.length) m.appendChild(h('div', { class: 'cs-tpl-h' }, 'Saved'));
    for (const name of names) {
      const row = h('div', { class: 'cs-tpl-row' });
      const use = h('button', { type: 'button' }, esc(name));
      use.addEventListener('click', () => { applyTemplate(name); renderPane(); m.hidden = true; });
      const del = h('button', { type: 'button', class: 'cs-tpl-del', 'aria-label': 'Delete template ' + name, title: 'Delete' }, '✕');
      del.addEventListener('click', () => { deleteTemplate(name); renderTemplateMenu(); });
      row.append(use, del); m.appendChild(row);
    }
    const save = h('div', { class: 'cs-tpl-save' });
    const inp = h('input', { type: 'text', placeholder: 'Save as…', maxlength: 40, 'aria-label': 'Template name' });
    const ok = h('button', { type: 'button' }, 'Save');
    const doSave = () => { if (saveTemplate(inp.value)) { inp.value = ''; renderTemplateMenu(); } else inp.classList.add('bad'); };
    ok.addEventListener('click', doSave);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } inp.classList.remove('bad'); });
    save.append(inp, ok); m.appendChild(save);
    const def = h('button', { type: 'button', class: 'cs-tpl-def' }, 'Apply defaults');
    def.addEventListener('click', () => { reset(); renderPane(); m.hidden = true; });
    m.appendChild(def);
  }

  function build(opts) {
    const bg = h('div', { class: 'cs-bg', hidden: true });
    const modal = h('div', { class: 'cs-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cs-title' });
    const head = h('header', { class: 'cs-head' });
    head.appendChild(h('h2', { id: 'cs-title' }, 'Settings'));
    const x = h('button', { type: 'button', class: 'cs-x', 'aria-label': 'Close settings' }, '✕');
    x.addEventListener('click', () => close(false));
    head.appendChild(x);
    const body = h('div', { class: 'cs-body' });
    const tabs = h('nav', { class: 'cs-tabs', role: 'tablist', 'aria-label': 'Settings sections' });
    for (const t of TABS) {
      const b = h('button', { type: 'button', role: 'tab', id: 'cs-tab-' + t.id, 'data-tab': t.id, 'aria-selected': 'false' }, esc(t.label));
      b.addEventListener('click', () => { ui.tab = t.id; renderPane(); });
      tabs.appendChild(b);
    }
    tabs.addEventListener('keydown', (e) => {
      const list = [...tabs.querySelectorAll('[role=tab]')], i = list.indexOf(document.activeElement);
      if (i < 0) return;
      const j = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : -1;
      if (j < 0) return;
      e.preventDefault();
      const n = list[(j + list.length) % list.length];
      ui.tab = n.dataset.tab; renderPane(); n.focus();
    });
    const pane = h('section', { class: 'cs-pane', role: 'tabpanel', tabindex: '0' });
    body.append(tabs, pane);
    const foot = h('footer', { class: 'cs-foot' });
    const tpl = h('div', { class: 'cs-tpl' });
    const tplBtn = h('button', { type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, 'Template ▾');
    const tplMenu = h('div', { class: 'cs-tpl-menu', hidden: true });
    tplBtn.addEventListener('click', () => { tplMenu.hidden = !tplMenu.hidden; tplBtn.setAttribute('aria-expanded', tplMenu.hidden ? 'false' : 'true'); if (!tplMenu.hidden) renderTemplateMenu(); });
    tpl.append(tplBtn, tplMenu);
    const cancel = h('button', { type: 'button', class: 'cs-cancel' }, 'Cancel');
    cancel.addEventListener('click', () => close(true));
    const ok = h('button', { type: 'button', class: 'cs-ok' }, 'Ok');
    ok.addEventListener('click', () => close(false));
    foot.append(tpl, h('span', { class: 'cs-sp' }), cancel, ok);
    modal.append(head, body, foot);
    bg.appendChild(modal);
    bg.addEventListener('click', (e) => { if (e.target === bg) close(false); });
    modal.addEventListener('click', (e) => { if (!tpl.contains(e.target) && !tplMenu.hidden) { tplMenu.hidden = true; tplBtn.setAttribute('aria-expanded', 'false'); } });
    bg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); return; }
      if (e.key !== 'Tab') return;
      // Keep focus inside while it is open.
      const f = [...modal.querySelectorAll('button:not([hidden]),input:not([hidden]),select,[tabindex="0"]')].filter((el) => el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    document.body.appendChild(bg);
    ui = { bg, modal, pane, tabs, tplMenu, tplBtn, opts: opts || {}, tab: TABS[0].id, snapshot: null, opener: null };
  }

  /**
   * Open the dialog. opts: { externals: { levels:{get,set}, zones:{get,set} },
   * resolveDefault(key) → css colour, tab: 'symbol' }.
   */
  function open(opts) {
    if (typeof document === 'undefined') return null;
    if (!ui) build(opts); else if (opts) Object.assign(ui.opts, opts);
    ui.snapshot = Object.assign({}, state());
    ui.opener = document.activeElement;
    if (opts && opts.tab) ui.tab = opts.tab;
    renderPane();
    ui.tplMenu.hidden = true;
    ui.bg.hidden = false;
    const first = ui.tabs.querySelector('[aria-selected="true"]');
    if (first) first.focus();
    return ui.modal;
  }
  /** cancel=true puts back what was there when the dialog opened. */
  function close(cancel) {
    if (!ui || ui.bg.hidden) return false;
    if (cancel && ui.snapshot) replace(ui.snapshot);
    ui.bg.hidden = true;
    if (ui.opener && ui.opener.focus) { try { ui.opener.focus(); } catch (e) { /* gone */ } }
    return true;
  }
  const isOpen = () => !!(ui && !ui.bg.hidden);

  return {
    STORAGE_KEY, TEMPLATE_KEY, MAX_TEMPLATES, FIELDS, KEYS, DEFAULTS, TABS, TIMEZONES, LINE_STYLES,
    rowKeys, isHex, coerce, normalise, diff, read, write,
    state, get, set, replace, reset, isDefault, adopt, onChange,
    templates, saveTemplate, applyTemplate, deleteTemplate,
    open, close, isOpen,
    _resetForTests() { current = null; listeners.length = 0; },
  };
});
