'use strict';
// experiments/replay_two_sleeve.js — THE FAITHFUL REPLAY, engine edition (2026-09-18).
// The two-sleeve ENGINE CORE (lib/two-sleeve/engine.js + ownership.js) drives this replay
// exactly as the headless runner drives the live account: same bridge wrapper, same env
// isolation, same symbol ownership, same tick order. What this file adds is the replay
// world — cached bars, a pinned clock, a mock account that fills stops on the bar's low,
// and the measurement (per-trade $ P&L, per-sleeve mark-to-market daily series, collisions).
// A runtime that changes nothing between here and live is the validation: the engine must
// reproduce the harness numbers of the 2026-09-18 teamwork sweep (sleeve-teamwork-levers).
//
// Carries every harness repair (#1-#7): protective stops placed and swept, Date.now() pinned
// to the simulated instant, day P&L marked to market, filled stops kept visible to the fill
// ledger with unique ids per variant, no LLM judge, zero-trade and zero-stop-fill tripwires.
//
// Paths: REPLAY_APP_S / REPLAY_APP_R / REPLAY_ENV_S / REPLAY_ENV_R override the box trees.
// Variants: REPLAY_VARIANTS=<json> ([{name, active:["S","R","M"], S:{env}, R:{env}, M:{env}, order:"SRM", exS:[], exR:[], exM:[]}]).
// Sleeve M = a second instance of the race brain fed a STRENGTH signal (REPLAY_M_IBS / REPLAY_M_FROM / REPLAY_M_SYMS);
// REPLAY_FRI_PM_INV / REPLAY_FRI_PM_FROM / REPLAY_FRI_PM_SYMS = the Friday-afternoon inverse-strength rule for sleeve R.
// Both are signal-engine rules under measurement — the brains take the scan's direction and never re-gate on IBS.
// Universe: REPLAY_EXCLUDE=SYM,SYM (global). Sessions: REPLAY_DAYS=N (first N). Dumps: REPLAY_DUMP=<prefix>
// (per-variant trades + .daily.json with the per-sleeve MTM series, collisions, refusals).
const fs = require("fs"), path = require("path");
const LONGS = String(process.env.REPLAY_LONGS || "SPY,QQQ,IWM,DIA,GLD,TLT,SMH,XLK,SOXL,TNA,SPXL,TQQQ,UPRO").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);   // REPLAY_LONGS / REPLAY_INV widen the universe (2026-09-25); the cache must hold every name
const INV = String(process.env.REPLAY_INV || "SQQQ,SOXS,SPXS,TZA").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const SYMS = [...LONGS, ...INV];
// REPLAY_CACHE overrides the bar cache dir (default rev60cache = Jun 5 – Aug 31 2026; rev73cache adds September).
const CACHE = process.env.REPLAY_CACHE || path.join(process.env.TEMP || "/tmp", "rev60cache");
const APP_S = process.env.REPLAY_APP_S || "C:/dev/lantern-os-stable/apps/lantern-garage";
const APP_R = process.env.REPLAY_APP_R || "C:/dev/lantern-race/apps/lantern-garage";
const ENV_S = process.env.REPLAY_ENV_S || "C:/dev/lantern-os-stable/.env.local";
const ENV_R = process.env.REPLAY_ENV_R || "C:/dev/lantern-race/.env.local";
const { createEngine } = require(path.join(__dirname, "..", "apps", "lantern-garage", "lib", "two-sleeve", "engine"));
const { createOwnership } = require(path.join(__dirname, "..", "apps", "lantern-garage", "lib", "two-sleeve", "ownership"));

const ET = (ms) => new Date(new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York" }));
const DAY = (ms) => { const d = ET(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const MIN = (ms) => { const d = ET(ms); return d.getHours() * 60 + d.getMinutes(); };
const DATA = {};
for (const s of SYMS) {
  const f = path.join(CACHE, s + ".json");
  if (!fs.existsSync(f)) continue;
  const a = JSON.parse(fs.readFileSync(f, "utf8"));
  a.forEach((b, i) => { b.d = DAY(b.t); b.m = MIN(b.t); b._i = i; });
  DATA[s] = a;
}
if (!Object.keys(DATA).length) { console.error("no cached bars"); process.exit(1); }

let NOW_MS = Math.min(...Object.values(DATA).map((a) => (a[0] && a[0].t) || Infinity));
const barsUpTo = (sym, n) => {
  const a = DATA[String(sym).toUpperCase()] || [];
  const out = [];
  for (let i = a.length - 1; i >= 0 && out.length < n; i--) if (a[i].t <= NOW_MS) out.push(a[i]);
  return out.reverse().map((b) => ({ timestamp: new Date(b.t).toISOString(), open: b.c, high: b.h, low: b.l, close: b.c, volume: 0 }));
};
const stub = {
  getBarsMulti: async (tickers) => ({ bars: Object.fromEntries((tickers || []).map((t) => [String(t).toUpperCase(), { bars: barsUpTo(t, 400) }])) }),
  getBars: async (t) => barsUpTo(t, 400),
  getQuotes: async (tickers) => (tickers || []).map((t) => { const b = barsUpTo(t, 1)[0]; return { symbol: t, price: b ? b.close : 0 }; }),
  getSessionBars15m: async (t) => barsUpTo(t, 100),
};
const _RealDate = Date;
global.Date = class extends _RealDate {
  constructor(...a) { return a.length ? new _RealDate(...a) : new _RealDate(NOW_MS || _RealDate.now()); }
  static now() { return NOW_MS || _RealDate.now(); }
};
// Sleeve M (strength/momentum, under measurement) = a SECOND INSTANCE of the race brain: the race lib is
// copied to a temp app dir so its module-level state (entry clocks, peaks, stop registry) is its own.
// REPLAY_APP_M (2026-09-25): the tree the M sleeve's brain is copied from — the race lib by default (the #3656 design),
// or the master lib to give a strength entry MOMENTUM exits (ratchet floor + stop, no bounce/weakness exit).
const M_SRC = process.env.REPLAY_APP_M ? path.resolve(process.env.REPLAY_APP_M) : APP_R;
const APP_M = (() => { const d = path.join(fs.mkdtempSync(path.join(require("os").tmpdir(), "sleeve-M-")), "apps", "lantern-garage"); fs.cpSync(path.join(M_SRC, "lib"), path.join(d, "lib"), { recursive: true }); return d; })();
// When R points at the SAME tree as S, require() would hand both sleeves ONE auto-trader module (shared cooldowns,
// entry clocks, per-scan counters). Copy lib, as for M, so R is its own instance (2026-09-25, additive-sleeve runs).
const APP_R_EFF = (path.resolve(APP_R) === path.resolve(APP_S)) ? (() => { const d = path.join(fs.mkdtempSync(path.join(require("os").tmpdir(), "sleeve-R-")), "apps", "lantern-garage"); fs.cpSync(path.join(APP_R, "lib"), path.join(d, "lib"), { recursive: true }); console.log("  [sleeve R] own copy of " + APP_R + " lib at " + d); return d; })() : APP_R;
for (const APP of [APP_S, APP_R_EFF, APP_M]) {
  const mdPath = require.resolve(path.join(APP, "lib", "market-data-yahoo.js"));
  require.cache[mdPath] = { id: mdPath, filename: mdPath, loaded: true, exports: stub };
}
const TMP = fs.mkdtempSync(path.join(require("os").tmpdir(), "sleeves-"));
process.env.TRADER_AUTO_EXECUTE = "1"; process.env.TRADER_MANAGE_EXITS = "1"; process.env.TRADER_LIVE = "0";
process.env.TRADER_TRADES_LOG = path.join(TMP, "trades_S.jsonl"); process.env.TRADER_STATE_FILE = path.join(TMP, "state_S.json");
const atS = require(path.join(APP_S, "lib", "auto-trader"));
process.env.TRADER_TRADES_LOG = path.join(TMP, "trades_R.jsonl"); process.env.TRADER_STATE_FILE = path.join(TMP, "state_R.json");
const atR = require(path.join(APP_R_EFF, "lib", "auto-trader"));
process.env.TRADER_TRADES_LOG = path.join(TMP, "trades_M.jsonl"); process.env.TRADER_STATE_FILE = path.join(TMP, "state_M.json");
const atM = require(path.join(APP_M, "lib", "auto-trader"));
const AT = { S: atS, R: atR, M: atM };
const STATE_FILES = { S: path.join(TMP, "state_S.json"), R: path.join(TMP, "state_R.json"), M: path.join(TMP, "state_M.json") };
const SLEEVES = ["S", "R", "M"];

// ------------------------------------------------- END-OF-DAY RULES under measurement (variant.eod, 2026-09-23)
// Race's live losses 09-08..09-22 were all stop fills, and 58% of the dollars were carries stopped at
// the next open (SQQQ -815 through a weekend, SOXS -264, TNA -89). The operator's target: keep race's
// winners at race's size, cut those losses. The race brain has no end-of-day logic, so the rules are
// applied here to the MOCK BOOK at the day's last bar, as filled market sells the brain's fill ledger
// then books like any broker fill (tagged to the owning sleeve so it sees them):
//   flatLosers: true          close any position below its entry at the close (carry only winners)
//   flatWeekend: "inverse"|"lev"|"all"   close that class on Fridays (no weekend gap on inverse/3x)
//   trimLev: 0.5              close that fraction of every 3x/inverse position at the close (carry half)
//   owner: "R" (default)      which sleeve(s) the rules apply to
const LEV3X = new Set(["SOXL", "TNA", "SPXL", "TQQQ", "UPRO", "SQQQ", "SOXS", "SPXS", "TZA"]);
function applyEodRules(state, eod, day, tag, ownership) {
  const isFri = ET(NOW_MS).getDay() === 5;
  const owners = new Set(String(eod.owner || "R").split(""));
  for (const [sym, p] of Object.entries(state.pos)) {
    if (!owners.has(p.owner)) continue;
    const last = (DATA[sym] || []).filter((b) => b.d === day).slice(-1)[0];
    if (!last) continue;
    const px = last.c;
    const stopO = state.orders.find((o) => o.symbol === sym && /^(STP|Stop)$/.test(String(o.orderType)) && o.status !== "Filled");
    const stopPx = stopO ? Number(stopO.stopPrice) : NaN;
    let closeQty = 0, why = null;
    if (eod.flatLosers && px < p.entry) { closeQty = p.qty; why = "eod_flat_loser"; }
    else if (eod.flatLosersLev && LEV3X.has(sym) && px < p.entry) { closeQty = p.qty; why = "eod_flat_loser_lev"; }
    // within one gap of the stop at the close (SQQQ 2026-09-18 closed 0.4% above its stop and opened 2.4% below it)
    else if (eod.flatNearStop && stopPx > 0 && px <= stopPx * (1 + Number(eod.flatNearStop) / 100)) { closeQty = p.qty; why = "eod_flat_near_stop"; }
    else if (eod.flatWeekend && isFri && (eod.flatWeekend === "all" || (eod.flatWeekend === "inverse" && INV.includes(sym)) || (eod.flatWeekend === "lev" && LEV3X.has(sym)))) { closeQty = p.qty; why = "eod_flat_weekend"; }
    else if (eod.flatLev && LEV3X.has(sym)) { closeQty = p.qty; why = "eod_decarry_lev"; }   // eod.flatLev (2026-09-27): the stable decarry, every close
    else if (eod.trimLev && LEV3X.has(sym)) { closeQty = Math.floor(p.qty * eod.trimLev); why = "eod_trim_lev"; }
    if (!(closeQty > 0)) continue;
    const pnl = closeQty * (px - p.entry);
    state.equity += pnl; state.realBy[p.owner] = (state.realBy[p.owner] || 0) + pnl;
    state.trades.push({ sym, ret: px / p.entry - 1, pnl, day, why, owner: p.owner, entry_ms: p.at, exit_ms: NOW_MS });
    const id = tag + p.owner + "E" + (++state.seq);
    state.orders.push({ orderId: id, symbol: sym, side: "sell", orderType: "MKT", status: "Filled", qty: closeQty, filledQty: closeQty, avgPrice: px, time: NOW_MS, owner: p.owner });
    if (ownership && ownership.tagOrder) ownership.tagOrder(id, sym, p.owner);
    if (closeQty >= p.qty) { delete state.pos[sym]; state.orders = state.orders.filter((o) => !(o.symbol === sym && /^(STP|Stop)$/.test(String(o.orderType)) && o.status !== "Filled")); }
    else { p.qty -= closeQty; for (const o of state.orders) if (o.symbol === sym && /^(STP|Stop)$/.test(String(o.orderType)) && o.status !== "Filled") o.qty = p.qty; }
  }
}

// ------------------------------------------------- one mock account (no ownership here — the engine owns that)
function makeAccount(state, tag) {
  const priceOf = (sym) => { const b = barsUpTo(sym, 1)[0]; return b ? b.close : 0; };
  const book = (sym, held, px, why) => {
    const pnl = held.qty * (px - held.entry);
    state.equity += pnl; state.realBy[held.owner] = (state.realBy[held.owner] || 0) + pnl;
    state.trades.push({ sym, ret: px / held.entry - 1, pnl, day: DAY(NOW_MS), why, owner: held.owner, entry_ms: held.at, exit_ms: NOW_MS });
  };
  const sweepStops = () => {
    for (const o of [...state.orders]) {
      if (!/^(STP|Stop)$/.test(String(o.orderType)) || o.status === "Filled") continue;
      if (!(o._placedAt < NOW_MS)) continue;
      const held = state.pos[o.symbol]; if (!held) continue;
      const b = barsUpTo(o.symbol, 1)[0]; if (!b) continue;
      const stop = Number(o.stopPrice);
      if (!(stop > 0) || !(Number(b.low) <= stop)) continue;
      const _gf = String(process.env.REPLAY_GAP_FILL || "high").toLowerCase();   // REPLAY_GAP_FILL (2026-09-27): gap-through stop fill = high (default) | mid | close
      const fillPx = Number(b.high) < stop ? (_gf === "close" ? Number(b.close ?? b.c) : _gf === "mid" ? (Number(b.high) + Number(b.low)) / 2 : Number(b.high)) : stop;
      book(o.symbol, held, fillPx, "stop");
      delete state.pos[o.symbol];
      o.status = "Filled"; o.filledQty = o.qty; o.avgPrice = fillPx; o.time = NOW_MS;
      state.orders = state.orders.filter((x) => x.symbol !== o.symbol || x === o);
    }
  };
  return {
    getIBKRAccount: async () => ({ equity: state.equity, mode: "paper" }),
    getIBKRPositions: async () => { sweepStops(); return Object.entries(state.pos).map(([symbol, p]) => ({
      symbol, qty: p.qty, avg_entry_price: p.entry, current_price: priceOf(symbol),
      market_value: p.qty * priceOf(symbol), unrealized_pl: p.qty * (priceOf(symbol) - p.entry),
    })); },
    getIBKROpenOrders: async () => { sweepStops(); return state.orders; },
    getIBKRDayPnl: async () => {
      const mtm = state.equity + Object.entries(state.pos).reduce((a, [s, p]) => a + p.qty * (priceOf(s) - p.entry), 0);
      const d = DAY(NOW_MS);
      if (!state.dayStart || state.dayStart.day !== d) state.dayStart = { day: d, equity: mtm };
      return mtm - state.dayStart.equity;
    },
    getIBKROrderStatus: async () => null,
    cancelIBKROrder: async (u, id) => { state.orders = state.orders.filter((o) => String(o.orderId) !== String(id)); return { status: "cancelled" }; },
    placeIBKROrder: async (u, o) => {
      const sym = String(o.ticker).toUpperCase(), px = priceOf(sym), owner = o._owner || "?";
      if (!(px > 0)) return { status: "error", reason: "no price" };
      const held = state.pos[sym];
      if (/stop/i.test(o.type || "")) {
        const id = tag + owner + "S" + (++state.seq);
        // "Stop" is IBKR's spelling and what both brains' stop-fill detection (/^stop$/i on order_type)
        // recognizes; Alpaca's is "stop". Until 2026-09-23 the mock said "STP", which matched NEITHER,
        // so a filled stop never armed the post-stop cooldown or counted toward the daily breaker in
        // any replay to date — both live boxes run both (race since graft #15). Baselines move with this.
        state.orders.push({ orderId: id, symbol: sym, side: "sell", orderType: "Stop", status: "Submitted", qty: o.qty, stopPrice: o.stopPrice, _placedAt: NOW_MS, owner });
        return { status: "placed", order_id: id };
      }
      const qty = Number(o.qty) || 0;
      if (String(o.side).toLowerCase() === "buy") {
        if (held) return { status: "error", reason: "already held" };   // the engine refuses cross-sleeve buys before this; same-sleeve doubles are the brain's own guard
        state.pos[sym] = { qty, entry: px, owner, at: NOW_MS };
      } else {
        if (!held) return { status: "error", reason: "not held" };
        book(sym, held, px, "sell");
        delete state.pos[sym];
        state.orders = state.orders.filter((x) => x.symbol !== sym);
      }
      return { status: "placed", order_id: tag + owner + "O" + (++state.seq) };
    },
  };
}

// ------------------------------------------------- each sleeve's own entry rule (reads the sleeve's env: called after applyEnv)
// REPLAY_FRI_PM_INV=<ibs> (+ REPLAY_FRI_PM_FROM=<ET minute>, default 780 = 13:00): a SIGNAL-ENGINE rule under
// measurement (operator 2026-09-18: Friday afternoons fade, inverses drift up). On Fridays from that minute an
// inverse-family symbol whose session IBS is >= the threshold (STRENGTH, not a washout) is emitted BULLISH for
// the race sleeve. The brain takes the scan's direction and never re-gates on IBS, so this is where such a rule
// lives; live it would go in lib/signal-engine/scan.js, not in the brain.
const FRI_PM_INV = Number(process.env.REPLAY_FRI_PM_INV) || 0;
const FRI_PM_FROM = Number(process.env.REPLAY_FRI_PM_FROM) || 780;
const FRI_PM_SYMS = new Set(String(process.env.REPLAY_FRI_PM_SYMS || "SQQQ,SOXS,SPXS,TZA").split(",").map((s) => s.trim().toUpperCase()));
// Sleeve M signal (REPLAY_M_IBS, default 0.7; REPLAY_M_FROM ET minute, default 630 = 10:30; REPLAY_M_SYMS, default all):
// STRENGTH — a symbol at or above that fraction of its session range after the minute is BULLISH; WEAKNESS
// (IBS <= 1 - threshold) is BEARISH, which the brain uses only to close a long it holds (a signal exit).
const POLARITY = String(process.env.REPLAY_POLARITY || "raw").toLowerCase();
const LEV_CONFIRM = process.env.REPLAY_LEV_CONFIRM === "1";
const PLACEBO = String(process.env.REPLAY_PLACEBO || "").toLowerCase();   // REPLAY_PLACEBO=shuffle|shift (2026-09-27), sleeve S entries only
let _placeboSeed = (Number(process.env.REPLAY_PLACEBO_SEED) || 1) >>> 0;
const placeboRand = () => { _placeboSeed = (1664525 * _placeboSeed + 1013904223) >>> 0; return _placeboSeed / 4294967296; };
let _allDaysCache = null;
const allDays = () => _allDaysCache || (_allDaysCache = [...new Set(Object.values(DATA).flat().map((b) => b.d))].sort());
let _inShift = false;
const PLACEBO_SLEEVES = new Set(String(process.env.REPLAY_PLACEBO_SLEEVES || "S").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean));   // which sleeves the placebo applies to (default S; S,R for the engine)
let _posRef = null;   // the replay account's open positions (set per variant) so shuffle only moves fires that could have entered
function applyPlacebo(out, day, m, sleeve) {
  if (!PLACEBO || !PLACEBO_SLEEVES.has(sleeve) || _inShift) return out;
  const setBull = (o, on) => { o.direction = on ? "BULLISH" : (o.direction === "BEARISH" ? "BEARISH" : "NEUTRAL"); o.convergence.decision = (o.direction === "BULLISH" || o.direction === "BEARISH") ? "ENTER" : "SKIP"; };
  if (PLACEBO === "shuffle") {
    const held = new Set(Object.keys(_posRef || {}));
    const bulls = out.filter((o) => o.direction === "BULLISH" && !held.has(o.symbol)); if (!bulls.length) return out;
    const pool = out.filter((o) => o.direction === "NEUTRAL" && !held.has(o.symbol)); const spare = out.filter((o) => o.direction === "BEARISH" && !held.has(o.symbol));
    for (const o of bulls) { o.direction = "NEUTRAL"; o.convergence.decision = "SKIP"; }
    let k = bulls.length;
    const pick = (arr) => { while (k > 0 && arr.length) { const i = Math.floor(placeboRand() * arr.length); const o = arr.splice(i, 1)[0]; o.direction = "BULLISH"; o.convergence.decision = "ENTER"; k--; } };
    pick(pool); pick(spare);
    return out;
  }
  if (PLACEBO === "shift") {
    const days = allDays(); const i = days.indexOf(day); if (i <= 0) return out;
    _inShift = true; let prev; try { prev = signalsAt(days[i - 1], m, sleeve); } finally { _inShift = false; }
    const prevBull = new Set(prev.filter((o) => o.direction === "BULLISH").map((o) => o.symbol));
    for (const o of out) { if (o.direction === "BEARISH") continue; setBull(o, prevBull.has(o.symbol)); }
    return out;
  }
  throw new Error("REPLAY_PLACEBO must be shuffle or shift");
}
const LEV_UNDERLYING = { SOXL: "SMH", TNA: "IWM", SPXL: "SPY", UPRO: "SPY", TQQQ: "QQQ", NUGT: "GDX", JNUG: "GDX", UCO: "USO" };
function underlyingIbsAt(u, day, m) {
  const ua = DATA[u]; if (!ua) return null;
  const us = ua.filter((b) => b.d === day && b.m >= 570 && b.m <= m); if (us.length < 3) return null;
  const uhi = Math.max(...us.map((b) => b.h)), ulo = Math.min(...us.map((b) => b.l)), uc = us[us.length - 1].c;
  return uhi > ulo ? (uc - ulo) / (uhi - ulo) : null;
}
const _parseAdaptiveEnv = (raw) => { const v = String(raw || "").trim(); if (!v) return null; const i1 = v.indexOf(":"), i2 = v.indexOf(":", i1 + 1); if (i1 < 0 || i2 < 0) return null; const n = Number(v.slice(0, i1)) || 10, x = Number(v.slice(i1 + 1, i2)) || 0; const deep = {}; for (const kv of v.slice(i2 + 1).split(";")) { const j = kv.indexOf("="); if (j > 0) deep[kv.slice(0, j).trim()] = kv.slice(j + 1).trim(); } return Object.keys(deep).length ? { n, x, deep } : null; };
const ADAPTIVE_ENV_R = _parseAdaptiveEnv(process.env.REPLAY_ADAPTIVE_ENV_R);
const ADAPTIVE_ENV = (() => { const v = String(process.env.REPLAY_ADAPTIVE_ENV || "").trim(); if (!v) return null; const i1 = v.indexOf(":"), i2 = v.indexOf(":", i1 + 1); if (i1 < 0 || i2 < 0) return null; const n = Number(v.slice(0, i1)) || 10, x = Number(v.slice(i1 + 1, i2)) || 0; const deep = {}; for (const kv of v.slice(i2 + 1).split(";")) { const j = kv.indexOf("="); if (j > 0) deep[kv.slice(0, j).trim()] = kv.slice(j + 1).trim(); } return Object.keys(deep).length ? { n, x, deep } : null; })();
const ADAPTIVE_SYM = (() => { const v = String(process.env.REPLAY_ADAPTIVE_SYM || "").trim(); if (!v) return null; const [n, x] = v.split(":").map(Number); return { n: n || 10, x: Number.isFinite(x) ? x : 0 }; })();
let _tradesRef = null, _daysRef = null, _dayIdx = -1;   // the current variant's realized trades, the session list, and today's index (set by the run loop)
function symTrailingPnl(sym, n) {
  if (!_tradesRef || !_daysRef || _dayIdx < 1) return null;
  const from = _daysRef[Math.max(0, _dayIdx - n)], to = _daysRef[_dayIdx - 1];
  let sum = 0, cnt = 0;
  for (const t of _tradesRef) { if (t.sym === sym && t.day >= from && t.day <= to) { sum += t.pnl; cnt++; } }
  return cnt ? { sum, cnt } : null;
}
const ADAPTIVE_PNL = (() => { const v = String(process.env.REPLAY_ADAPTIVE_PNL || "").trim(); if (!v) return null; const [n, x, up, dn] = v.split(":").map(Number); return { n: n || 10, x: Number.isFinite(x) ? x : 0, up: up || 0.30, dn: dn || 0.20 }; })();
let _curveRef = null;   // the current variant's MTM equity curve (one point per completed session), set by the run loop
function trailingPnlPct(n) { const c = _curveRef; if (!c || c.length <= n) return null; const a = c[c.length - 1], b = c[c.length - 1 - n]; return b ? (a / b - 1) * 100 : null; }
const ADAPTIVE_IBS = (() => { const v = String(process.env.REPLAY_ADAPTIVE_IBS || "").trim(); if (!v) return null; const [n, x, up, dn] = v.split(":").map(Number); return { n: n || 10, x: Number.isFinite(x) ? x : 0, up: up || 0.30, dn: dn || 0.20 }; })();
// SPY session closes in order, and a lookup from an ET day to the close-to-close return over the last N sessions ending the PRIOR session
const _spyDays = (() => { const a = DATA.SPY || []; const byDay = new Map(); for (const b of a) byDay.set(b.d, b.c); const days = [...byDay.keys()].sort(); return { days, close: byDay }; })();
function spyTrendPct(day, n) {
  const i = _spyDays.days.indexOf(day); const j = (i >= 0 ? i : _spyDays.days.findIndex((d) => d > day)) - 1;   // prior session
  if (j < n) return null;
  const c1 = _spyDays.close.get(_spyDays.days[j]), c0 = _spyDays.close.get(_spyDays.days[j - n]);
  return c1 && c0 ? (c1 / c0 - 1) * 100 : null;
}   // raw | none | selective | top (see signalsAt)
// REGIME SWITCH (variant.regime, 2026-09-29; ledger row carry-3x-weeknights-regime200-13-windows):
//   regime: { n: 200, with: { ENV }, against: { ENV } }
// sets sleeve S's env for the session by SPY's trend as it stood BEFORE the session opened: the prior
// session's close against the mean of the n closes ending with it ("with" = above). One window's cache
// is too short for 200 sessions, so SPY's closes are read from EVERY oos_* cache beside REPLAY_CACHE.
// Not enough history = the variant's base env for that session (counted as "unknown").
let _spyLongMemo = null;
function _spyLong() {
  if (_spyLongMemo) return _spyLongMemo;
  const root = path.dirname(CACHE); const byDay = new Map();
  let dirs = []; try { dirs = fs.readdirSync(root).filter((d) => /^oos_/.test(d)); } catch (_e) { dirs = []; }
  for (const d of new Set([...dirs, path.basename(CACHE)])) {
    const f = path.join(root, d, "SPY.json"); if (!fs.existsSync(f)) continue;
    let a; try { a = JSON.parse(fs.readFileSync(f, "utf8")); } catch (_e) { continue; }
    for (const b of a) { const m = MIN(b.t); if (m < 570 || m >= 960) continue; const day = DAY(b.t); const cur = byDay.get(day); if (!cur || b.t >= cur.t) byDay.set(day, { t: b.t, c: Number(b.c) }); }
  }
  const days = [...byDay.keys()].sort();
  _spyLongMemo = { days, close: days.map((d) => byDay.get(d).c) };
  return _spyLongMemo;
}
function spyAboveMean(day, n) {
  const L = _spyLong();
  let j = L.days.indexOf(day); if (j < 0) { j = L.days.findIndex((d) => d > day); if (j < 0) j = L.days.length; }   // j = completed sessions before `day`
  if (j < n) return null;
  // a hole in the cached history would make "the last n closes" span more than n sessions: refuse rather than guess
  const spanDays = (Date.parse(L.days[j - 1] + "T00:00:00Z") - Date.parse(L.days[j - n] + "T00:00:00Z")) / 86400000;
  if (spanDays > n * 1.6) return null;
  let s = 0; for (let k = j - n; k < j; k++) s += L.close[k];
  return L.close[j - 1] > s / n;
}
const INV_UNDERLYING ={ SQQQ: "QQQ", SOXS: "SMH", SPXS: "SPY", TZA: "IWM" };     // wrapper -> the cached 1x proxy for its underlying
const M_IBS = Number(process.env.REPLAY_M_IBS) || 0.7;
const M_FROM = Number(process.env.REPLAY_M_FROM) || 630;
const M_NO_WEAKNESS = process.env.REPLAY_M_NO_WEAKNESS === "1";   // 2026-09-25: no weakness signal-exit; M exits by ratchet floor / stop / time only
const M_SYMS = new Set(String(process.env.REPLAY_M_SYMS || SYMS.join(",")).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
function signalsAt(day, m, sleeve) {
  const out = [];
  if (sleeve === "M") {
    if (m < M_FROM) return out;
    for (const s of SYMS) {
      if (!M_SYMS.has(s)) continue;
      const a = DATA[s]; if (!a) continue;
      const sess = a.filter((b) => b.d === day && b.m >= 570 && b.m <= m);
      if (sess.length < 3) continue;
      const hi = Math.max(...sess.map((b) => b.h)), lo = Math.min(...sess.map((b) => b.l));
      if (!(hi > lo)) continue;
      const cur = sess[sess.length - 1];
      const ibs = (cur.c - lo) / (hi - lo);
      const bullish = ibs >= M_IBS, bearish = !M_NO_WEAKNESS && ibs <= 1 - M_IBS;
      out.push({ symbol: s, direction: bullish ? "BULLISH" : (bearish ? "BEARISH" : "NEUTRAL"), entry_price: cur.c,
        decision_context: { ibs, spy_tape: 0 }, convergence: { decision: (bullish || bearish) ? "ENTER" : "SKIP", p_win: 0.6 } });
    }
    return out;
  }
  const thr = (sleeve === "S" || (sleeve === "R" && process.env.REPLAY_R_SIGNAL_LIKE_S === "1"))   // REPLAY_R_SIGNAL_LIKE_S=1: sleeve R takes the S thresholds (an additive master-brain sleeve, 2026-09-25)
    ? (m < 660 ? (Number(process.env.TRADER_IBS_MAX_MORNING) || 0.12) : (ADAPTIVE_PNL ? (() => { const t = trailingPnlPct(ADAPTIVE_PNL.n); return (t == null || t >= ADAPTIVE_PNL.x) ? ADAPTIVE_PNL.up : ADAPTIVE_PNL.dn; })() : ADAPTIVE_IBS ? (() => { const t = spyTrendPct(day, ADAPTIVE_IBS.n); return (t == null || t >= ADAPTIVE_IBS.x) ? ADAPTIVE_IBS.up : ADAPTIVE_IBS.dn; })() : (Number(process.env.TRADER_IBS_MAX) || 0.30)))
    : ((sleeve === "R" && m < 660 && process.env.TRADER_LAB_R_MORNING) ? Number(process.env.TRADER_LAB_R_MORNING) : (Number(process.env.TRADER_IBS_MAX) || 0.15));   // TRADER_LAB_R_MORNING (2026-09-27): stable-style morning depth for R
  const friPm = FRI_PM_INV > 0 && sleeve === "R" && m >= FRI_PM_FROM && new _RealDate(day + "T12:00:00Z").getUTCDay() === 5;
  for (const s of SYMS) {
    if (ADAPTIVE_SYM && sleeve === "S") { const tp = symTrailingPnl(s, ADAPTIVE_SYM.n); if (tp && tp.sum < ADAPTIVE_SYM.x) continue; }
    const a = DATA[s]; if (!a) continue;
    const sess = a.filter((b) => b.d === day && b.m >= 570 && b.m <= m);
    if (sess.length < 3) continue;
    const hi = Math.max(...sess.map((b) => b.h)), lo = Math.min(...sess.map((b) => b.l));
    if (!(hi > lo)) continue;
    const cur = sess[sess.length - 1];
    const ibs = (cur.c - lo) / (hi - lo);
    const strength = friPm && FRI_PM_SYMS.has(s) && ibs >= FRI_PM_INV;
    let bullish = ibs <= thr || strength, bearish = !strength && ibs >= 0.6;
    // POLARITY (2026-09-25). A BULLISH fire on an inverse wrapper is an economic short and live
    // it passes lib/signal-engine/scan.js applyPolarity under TRADER_SHORT_EDGE; this harness never
    // modelled that, so its inverse entries ran under a fifth rule (the wrapper's own IBS only).
    // REPLAY_POLARITY names the rule: raw (the harness as it was, default), none (SHORT_EDGE=0),
    // selective (the armed rule: wrapper fell no more than 1.5% from its session open, underlying
    // not up 0.5%+ from its open; the p_win time penalty is inert here because p_win is fixed), top
    // (SHORT_EDGE=1: underlying at its session top, IBS >= 1 - thr). Exits (bearish) are untouched.
    if (bullish && INV_UNDERLYING[s] && POLARITY !== "raw") {
      if (POLARITY === "none") bullish = false;
      else {
        const ua = DATA[INV_UNDERLYING[s]] || [];
        const us = ua.filter((b) => b.d === day && b.m >= 570 && b.m <= m);
        if (us.length < 3) bullish = false;
        else {
          const uhi = Math.max(...us.map((b) => b.h)), ulo = Math.min(...us.map((b) => b.l)), ucur = us[us.length - 1];
          const uIbs = uhi > ulo ? (ucur.c - ulo) / (uhi - ulo) : 0.5;
          const uTape = (ucur.c / us[0].c - 1) * 100;
          const wrapperDD = (cur.c / sess[0].c - 1) * 100;
          if (POLARITY === "top") bullish = uIbs >= 1 - thr;
          else if (POLARITY === "selective") bullish = wrapperDD > -1.5 && uTape < 0.5;
        }
      }
    }
    if (bullish && sleeve === "S" && process.env.TRADER_LAB_FRI_FROM_M !== undefined && process.env.TRADER_LAB_FRI_FROM_M !== "" && new _RealDate(day + "T12:00:00Z").getUTCDay() === 5 && m >= Number(process.env.TRADER_LAB_FRI_FROM_M)) bullish = false;   // TRADER_LAB_FRI_FROM_M (2026-09-27)
    if (bullish && sleeve === "S" && process.env.TRADER_LAB_LEV_FROM_M && ["SOXL", "TNA", "SPXL", "UPRO", "TQQQ"].includes(s) && m < Number(process.env.TRADER_LAB_LEV_FROM_M)) bullish = false;   // TRADER_LAB_LEV_FROM_M (2026-09-27)
    if (bullish && sleeve === "R" && process.env.TRADER_LAB_R_CADENCE) { const _N = Number(process.env.TRADER_LAB_R_CADENCE), _r = m % _N; if (_r !== 0 && _r < _N - 15) bullish = false; }   // the boundary bar and the three bars before it: the race brain's scan persistence/confirmation completes AT the boundary   // boundary bar + the bar before it, so the race brain's 2-scan confirmation can complete at the boundary   // TRADER_LAB_R_CADENCE (2026-09-27): R decides only on the boundary bar
    if (bullish && sleeve === "R" && process.env.TRADER_LAB_R_LATE_BLOCK && m >= Number(process.env.TRADER_LAB_R_LATE_BLOCK)) bullish = false;   // TRADER_LAB_R_LATE_BLOCK (2026-09-27): no late R entries
    if (bullish && LEV_CONFIRM && sleeve === "S" && LEV_UNDERLYING[s]) { const uIbs = underlyingIbsAt(LEV_UNDERLYING[s], day, m); if (uIbs == null || uIbs > thr) bullish = false; }   // REPLAY_LEV_CONFIRM (2026-09-27)
    out.push({ symbol: s, direction: bullish ? "BULLISH" : (bearish ? "BEARISH" : "NEUTRAL"), entry_price: cur.c,
      decision_context: { ibs, spy_tape: 0 }, convergence: { decision: (bullish || bearish) ? "ENTER" : "SKIP", p_win: 0.6 } });
  }
  if (sleeve === "S" && process.env.TRADER_LAB_BREADTH_MAX) {
    const max = Number(process.env.TRADER_LAB_BREADTH_MAX);
    const levOnly = process.env.TRADER_LAB_BREADTH_LEV_ONLY === "1";
    const LEVS = new Set(["SOXL", "TNA", "SPXL", "UPRO", "TQQQ", "NUGT", "JNUG", "UCO"]);
    const breadth = out.filter((o) => o.direction === "BULLISH" && !INV_UNDERLYING[o.symbol]).length;   // long names in washout right now
    if (breadth > max) for (const o of out) { if (o.direction === "BULLISH" && (!levOnly || LEVS.has(o.symbol))) { o.direction = "NEUTRAL"; o.convergence.decision = "SKIP"; o.decision_context.breadth_veto = breadth; } }
  }
  return applyPlacebo(out, day, m, sleeve);
}

function loadArmed(base, src) {
  const IGNORE = /^TRADER_(TRADES_LOG|STATE_FILE|LOCK_DIR|LIVE|AUTO_EXECUTE|AUTO_USER|SESSION_REVIEW|MANAGE_EXITS)$/;
  let n = 0;
  for (const line of fs.readFileSync(src, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(TRADER_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || IGNORE.test(m[1])) continue;
    if (base[m[1]] !== m[2]) { base[m[1]] = m[2]; n++; }
  }
  return n;
}

(async () => {
  const days = [...new Set(Object.values(DATA).flat().map((b) => b.d))].sort().slice(0, Number(process.env.REPLAY_DAYS) || undefined);
  const COMMON = {
    TRADER_IBS_EXIT: "0.6", TRADER_MAX_POSITION_PCT: "12", TRADER_POSITION_PCT: "12",
    TRADER_STOP_COOLDOWN_DAYS: "0",
    TRADER_SYMBOL_SIZE_MULT: "SOXL:1.5,SMH:1.5,QQQ:1.5,IWM:1.02,XLK:1.0,SPY:0.83,DIA:0.71,GLD:0.5,TLT:0.5",
    TRADER_SLOT_ORDER: "expectancy", TRADER_LOG_SKIPS: "0", TRADER_EOD_FLAT: "weekend",
    TRADER_PERSIST_WINDOW_MS: String(15 * 60 * 1000),
  };
  const BASE_S = { ...COMMON, TRADER_IBS_MAX: "0.30", TRADER_IBS_MAX_MORNING: "0.12", TRADER_MAX_CONCURRENT: "5",
    TRADER_ENTRY_CADENCE_MIN: "60", TRADER_ENTRY_CADENCE_PHASE: "0", TRADER_ENTRY_CADENCE_WINDOW: "3",
    TRADER_ZONE_EXIT: "0", TRADER_TAKE_PROFIT_R: "0", TRADER_MOMENTUM_EXIT: "0", TRADER_EXIT_MIN_PWIN: "0", TRADER_EOD_DECARRY: "0", TRADER_ENTRY_CONFIRM: "0" };
  const BASE_R = { ...COMMON, TRADER_IBS_MAX: "0.30", TRADER_IBS_MAX_MORNING: "0.12", TRADER_MAX_CONCURRENT: "5",
    TRADER_ENTRY_CADENCE_MIN: "60", TRADER_ENTRY_CADENCE_PHASE: "0", TRADER_ENTRY_CADENCE_WINDOW: "3", TRADER_ENTRY_CONFIRM: "0" };
  console.log(`  [armed-env] stable: ${loadArmed(BASE_S, ENV_S)} knobs from ${ENV_S}`);
  console.log(`  [armed-env] race:   ${loadArmed(BASE_R, ENV_R)} knobs from ${ENV_R}`);
  BASE_S.TRADER_ENTRY_JUDGE = "0"; BASE_R.TRADER_ENTRY_JUDGE = "0";
  const EXCL = new Set(String(process.env.REPLAY_EXCLUDE || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
  if (EXCL.size) { for (const s of EXCL) delete DATA[s]; console.log(`  [exclude] ${[...EXCL].join(" ")} removed from the universe`); }
  const HALF = { TRADER_MAX_CONCURRENT: "3", TRADER_POSITION_PCT: "6", TRADER_MAX_POSITION_PCT: "6" };
  let VARIANTS = [
    ["S_full",     { active: ["S"],      S: {},   R: {} }],
    ["R_full",     { active: ["R"],      S: {},   R: {} }],
    ["blend_half", { active: ["S", "R"], S: HALF, R: HALF }],
    ["blend_full", { active: ["S", "R"], S: {},   R: {} }],
  ];
  if (process.env.REPLAY_VARIANTS) {
    const list = JSON.parse(fs.readFileSync(process.env.REPLAY_VARIANTS, "utf8"));
    VARIANTS = list.map((v) => [v.name, { active: v.active, S: v.S || {}, R: v.R || {}, M: v.M || {}, order: v.order || "SR", exS: v.exS || [], exR: v.exR || [], exM: v.exM || [], eod: v.eod || null, regime: v.regime || null }]);
    console.log(`  [variants] ${VARIANTS.length} from ${process.env.REPLAY_VARIANTS}: ${VARIANTS.map(([n]) => n).join(" ")}`);
  }
  console.log(`\nTWO-SLEEVE ENGINE REPLAY (engine core) — ${days.length} sessions, ${Object.keys(DATA).length} symbols\n`);
  console.log(`  ${"variant".padEnd(18)}${"return".padStart(9)}${"trades".padStart(8)}${"WR".padStart(6)}${"avg win".padStart(9)}${"avg loss".padStart(10)}${"payoff".padStart(8)}   maxDD   per-sleeve`);

  for (const [name, v] of VARIANTS) {
    const t0 = _RealDate.now();
    const tag = name.replace(/\W+/g, "") + "-";
    const envFor = { S: { ...BASE_S, ...v.S }, R: { ...BASE_R, ...v.R }, M: { ...BASE_R, ...(v.M || {}) } };
    const exc = { S: new Set(v.exS || []), R: new Set(v.exR || []), M: new Set(v.exM || []) };
    const order = (typeof v.order === "string" && v.order.length ? v.order.split("") : ["S", "R"]).filter((sl) => SLEEVES.includes(sl) && v.active.includes(sl));
    for (const sl of v.active) if (!order.includes(sl)) order.push(sl);
    const state = { equity: 100000, pos: {}, orders: [], trades: [], seq: 0, curve: [], realBy: { S: 0, R: 0, M: 0 }, collisions: [], daily: [] }; _curveRef = state.curve; _posRef = state.pos; _tradesRef = state.trades;
    const account = makeAccount(state, tag);
    const rows = [];
    const ownership = createOwnership({ defaultOwner: "S" });
    const engine = createEngine({
      sleeves: order.map((id) => ({ id, brain: AT[id], env: envFor[id], userId: "replay-" + id, universe: SYMS.filter((s) => !exc[id].has(s)) })),
      order, facade: account, ownership,
      journal: (r) => { if (r.event === "collision") state.collisions.push({ day: DAY(NOW_MS), ms: NOW_MS, sym: r.symbol, loser: r.loser, winner: r.winner }); rows.push(r); },
    });
    for (const sl of order) { try { fs.unlinkSync(STATE_FILES[sl]); } catch (_e) {} engine.applyEnv(envFor[sl]); AT[sl]._resetCooldowns(); AT[sl]._loadState(); }
    engine.restoreEnv();
    const census = { S: {}, R: {}, M: {} };
    for (const day of days) {
      _daysRef = days; _dayIdx = days.indexOf(day);
      if (ADAPTIVE_ENV && envFor.S) {
        if (!envFor.S.__adaptiveBase) Object.defineProperty(envFor.S, "__adaptiveBase", { value: Object.fromEntries(Object.keys(ADAPTIVE_ENV.deep).map((k) => [k, envFor.S[k]])), enumerable: false });
        const t = trailingPnlPct(ADAPTIVE_ENV.n); const isDeep = t != null && t < ADAPTIVE_ENV.x;
        for (const k of Object.keys(ADAPTIVE_ENV.deep)) { const base = envFor.S.__adaptiveBase[k]; if (isDeep) envFor.S[k] = ADAPTIVE_ENV.deep[k]; else if (base === undefined) delete envFor.S[k]; else envFor.S[k] = base; }
        if (isDeep) state.adaptiveDeepDays = (state.adaptiveDeepDays || 0) + 1;
      }
      if (ADAPTIVE_ENV_R && envFor.R) {
        if (!envFor.R.__adaptiveBase) Object.defineProperty(envFor.R, "__adaptiveBase", { value: Object.fromEntries(Object.keys(ADAPTIVE_ENV_R.deep).map((k) => [k, envFor.R[k]])), enumerable: false });
        const tR = trailingPnlPct(ADAPTIVE_ENV_R.n); const deepR = tR != null && tR < ADAPTIVE_ENV_R.x;
        for (const k of Object.keys(ADAPTIVE_ENV_R.deep)) { const base = envFor.R.__adaptiveBase[k]; if (deepR) envFor.R[k] = ADAPTIVE_ENV_R.deep[k]; else if (base === undefined) delete envFor.R[k]; else envFor.R[k] = base; }
      }
      if (v.regime && envFor.S) {
        const keys = [...new Set([...Object.keys(v.regime.with || {}), ...Object.keys(v.regime.against || {})])];
        if (!envFor.S.__regimeBase) Object.defineProperty(envFor.S, "__regimeBase", { value: Object.fromEntries(keys.map((k) => [k, envFor.S[k]])), enumerable: false });
        const up = spyAboveMean(day, Number(v.regime.n) || 200);
        const set = up == null ? {} : ((up ? v.regime.with : v.regime.against) || {});
        for (const k of keys) { const base = envFor.S.__regimeBase[k]; if (k in set) envFor.S[k] = String(set[k]); else if (base === undefined) delete envFor.S[k]; else envFor.S[k] = base; }
        state.regimeDays = state.regimeDays || { with: 0, against: 0, unknown: 0 }; state.regimeDays[up == null ? "unknown" : up ? "with" : "against"]++;
      }
      for (let m = 570; m <= 960; m += 5) {
        const cur = (DATA.SPY || []).find((b) => b.d === day && b.m === m);
        if (!cur) continue;
        NOW_MS = cur.t;
        const res = await engine.tick((sl) => ({ signals: signalsAt(day, m, sl.id) }), { now: NOW_MS, userId: "replay-" + order[0] });
        for (const sl of order) for (const s of (((res[sl] || {}).skipped) || [])) { const k = String(s.why || "?").split(/[—(:]/)[0].trim().slice(0, 26); census[sl][k] = (census[sl][k] || 0) + 1; }
      }
      if (v.eod) applyEodRules(state, v.eod, day, tag, ownership);   // end-of-day rules under measurement, at the day's last bar
      const unreal = { S: 0, R: 0, M: 0 };
      for (const [sym, p] of Object.entries(state.pos)) {
        const last = ((DATA[sym] || []).filter((b) => b.d === day).slice(-1)[0]) || { c: p.entry };
        unreal[p.owner] = (unreal[p.owner] || 0) + p.qty * (last.c - p.entry);
      }
      state.curve.push(state.equity + unreal.S + unreal.R + unreal.M);
      state.daily.push({ day, S: state.realBy.S + unreal.S, R: state.realBy.R + unreal.R, M: state.realBy.M + unreal.M, acct: state.equity + unreal.S + unreal.R + unreal.M, openS: Object.values(state.pos).filter((p) => p.owner === "S").length, openR: Object.values(state.pos).filter((p) => p.owner === "R").length, openM: Object.values(state.pos).filter((p) => p.owner === "M").length });
    }
    for (const sym of Object.keys(state.pos)) {
      const a = (DATA[sym] || []).filter((b) => b.d <= days[days.length - 1]); const last = a[a.length - 1];
      if (last) { const p = state.pos[sym]; const pnl = p.qty * (last.c - p.entry); state.equity += pnl; state.realBy[p.owner] += pnl; state.trades.push({ sym, ret: last.c / p.entry - 1, pnl, day: last.d, why: "end_of_data", owner: p.owner, entry_ms: p.at, exit_ms: last.t }); }
      delete state.pos[sym];
    }
    const refused = engine.stats.refusedBy;
    if (process.env.REPLAY_DUMP) {
      fs.writeFileSync(process.env.REPLAY_DUMP + "." + name + ".json", JSON.stringify(state.trades));
      fs.writeFileSync(process.env.REPLAY_DUMP + "." + name + ".daily.json", JSON.stringify({ name, active: v.active, order, exS: v.exS, exR: v.exR, exM: v.exM, S: v.S, R: v.R, M: v.M, daily: state.daily, refused, collisions: state.collisions, engine: engine.stats }));
    }
    const tr = state.trades, w = tr.filter((t) => t.ret > 0), l = tr.filter((t) => t.ret < 0);
    const avg = (a) => (a.length ? a.reduce((s, t) => s + t.ret, 0) / a.length * 100 : 0);
    let pk = -Infinity, dd = 0; for (const e of state.curve) { pk = Math.max(pk, e); dd = Math.max(dd, (pk - e) / pk * 100); }
    const per = order.map((sl) => { const t = tr.filter((x) => x.owner === sl); return `${sl}:${t.length}tr ${(t.reduce((s, x) => s + x.ret, 0) * 100).toFixed(1)}%`; }).join("  ");
    const stops = tr.filter((t) => t.why === "stop").length;
    console.log(`  ${name.padEnd(18)}${((state.equity / 100000 - 1) * 100).toFixed(2).padStart(8)}%${String(tr.length).padStart(8)}${(tr.length ? (w.length / tr.length * 100).toFixed(0) + "%" : "-").padStart(6)}${(avg(w).toFixed(3) + "%").padStart(9)}${(avg(l).toFixed(3) + "%").padStart(10)}${(avg(l) !== 0 ? Math.abs(avg(w) / avg(l)).toFixed(2) : "-").padStart(8)}   ${dd.toFixed(2).padStart(5)}%   ${per}${Object.keys(refused).length ? "   refused " + JSON.stringify(refused) : ""}   stops ${stops}   ${((_RealDate.now() - t0) / 60000).toFixed(1)}min`);
    if (state.regimeDays) console.log(`      regime days (SPY against the mean of its last ${Number(v.regime.n) || 200} closes): ${JSON.stringify(state.regimeDays)}`);
    if (!tr.length) console.log("      !! TRIPWIRE: zero trades");
    if (!stops) console.log("      !! TRIPWIRE: zero stop fills");
    for (const sl of order) { const c = Object.entries(census[sl]).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k}:${n}`).join("  "); if (c) console.log(`      gates ${sl}: ${c}`); }
    const h1 = new Set(days.slice(0, Math.floor(days.length / 2)));
    for (const [hn, ht] of [["h1", tr.filter((t) => h1.has(t.day))], ["h2", tr.filter((t) => !h1.has(t.day))]]) {
      const hw = ht.filter((t) => t.ret > 0);
      console.log(`      ${hn}: n=${String(ht.length).padStart(3)}  WR=${(ht.length ? (hw.length / ht.length * 100).toFixed(0) : "-")}%  sum ${(ht.reduce((s, t) => s + t.ret, 0) * 100).toFixed(2)}%`);
    }
  }
})().catch((e) => { console.error("replay failed:", e.message, e.stack); process.exit(1); });
