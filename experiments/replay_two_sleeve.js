'use strict';
// experiments/replay_two_sleeve.js — THE FAITHFUL REPLAY (2026-09-16). Supersedes every earlier scratch
// harness: this is the first one that places protective stops (harness bug #7 left every single-
// sleeve run since 09-16 00:20 stopless), pins Date.now() to the simulated instant, marks day P&L,
// keeps filled stops visible to the fill ledger with unique ids per variant, resets env between
// variants, never calls the LLM judge, and carries zero-trade AND zero-stop-fill tripwires.
// Paths: REPLAY_APP_S / REPLAY_APP_R / REPLAY_ENV_S / REPLAY_ENV_R override the box trees.
// Universe: REPLAY_EXCLUDE=SYM,SYM. Dumps: REPLAY_DUMP=<prefix> (per-variant trades with timestamps).
// TWO-SLEEVE ENGINE REPLAY (2026-09-16). The operator's endgoal test: BOTH brains,
// intact, on ONE account. Sleeve S = stable's ecology (T2 + invgate + morning 0.30 +
// cadence + decarry + weekend-flat, intraday bias). Sleeve R = race's ecology (IBS 0.15
// flat, zone ladder, max-hold, carries, regime dial). They share equity under a
// symbol-ownership rule (whoever enters a name owns its exits; the other sleeve is
// refused that name) and split slots/size. Carries every harness repair (#1-#6).
//   S_full / R_full  = each sleeve alone at full size (must reproduce the clean controls)
//   blend_half       = both sleeves at half size + half slots (= the equal-risk blend)
//   blend_full       = both at full size (2x gross; shows whether the account can carry it)
const fs = require("fs"), path = require("path");
const LONGS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL", "TNA", "SPXL", "TQQQ", "UPRO"];
const INV = ["SQQQ", "SOXS", "SPXS", "TZA"];
const SYMS = [...LONGS, ...INV];
const CACHE = path.join(process.env.TEMP || "/tmp", "rev60cache");
const APP_S = process.env.REPLAY_APP_S || "C:/dev/lantern-os-stable/apps/lantern-garage";   // the stable (master) tree
const APP_R = process.env.REPLAY_APP_R || "C:/dev/lantern-race/apps/lantern-garage";       // the race (week-1 hybrid) tree
const ENV_S = process.env.REPLAY_ENV_S || "C:/dev/lantern-os-stable/.env.local";
const ENV_R = process.env.REPLAY_ENV_R || "C:/dev/lantern-race/.env.local";

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
for (const APP of [APP_S, APP_R]) {
  const mdPath = require.resolve(path.join(APP, "lib", "market-data-yahoo.js"));
  require.cache[mdPath] = { id: mdPath, filename: mdPath, loaded: true, exports: stub };
}
const TMP = fs.mkdtempSync(path.join(require("os").tmpdir(), "sleeves-"));
process.env.TRADER_AUTO_EXECUTE = "1"; process.env.TRADER_MANAGE_EXITS = "1"; process.env.TRADER_LIVE = "0";
// each brain captures its journal/state paths at load; give each its own
process.env.TRADER_TRADES_LOG = path.join(TMP, "trades_S.jsonl"); process.env.TRADER_STATE_FILE = path.join(TMP, "state_S.json");
const atS = require(path.join(APP_S, "lib", "auto-trader"));
process.env.TRADER_TRADES_LOG = path.join(TMP, "trades_R.jsonl"); process.env.TRADER_STATE_FILE = path.join(TMP, "state_R.json");
const atR = require(path.join(APP_R, "lib", "auto-trader"));
const AT = { S: atS, R: atR };
const STATE_FILES = { S: path.join(TMP, "state_S.json"), R: path.join(TMP, "state_R.json") };

// ------------------------------------------------- one account, two owners
function makeBroker(state, owner, tag) {
  const priceOf = (sym) => { const b = barsUpTo(sym, 1)[0]; return b ? b.close : 0; };
  const sweepStops = () => {
    for (const o of [...state.orders]) {
      if (o.orderType !== "STP" || o.status === "Filled") continue;
      if (!(o._placedAt < NOW_MS)) continue;
      const held = state.pos[o.symbol]; if (!held || held.owner !== o.owner) continue;
      const b = barsUpTo(o.symbol, 1)[0]; if (!b) continue;
      const stop = Number(o.stopPrice);
      if (!(stop > 0) || !(Number(b.low) <= stop)) continue;
      const fillPx = Number(b.high) < stop ? Number(b.high) : stop;
      state.equity += held.qty * (fillPx - held.entry);
      state.trades.push({ sym: o.symbol, ret: fillPx / held.entry - 1, day: DAY(NOW_MS), why: "stop", owner: held.owner, entry_ms: held.at, exit_ms: NOW_MS });
      delete state.pos[o.symbol];
      o.status = "Filled"; o.filledQty = o.qty; o.avgPrice = fillPx; o.time = NOW_MS;
      state.orders = state.orders.filter((x) => x.symbol !== o.symbol || x === o);
    }
  };
  const mine = (p) => p.owner === owner;
  return {
    getIBKRAccount: async () => ({ equity: state.equity, mode: "paper" }),
    getIBKRPositions: async () => { sweepStops(); return Object.entries(state.pos).filter(([, p]) => mine(p)).map(([symbol, p]) => ({
      symbol, qty: p.qty, avg_entry_price: p.entry, current_price: priceOf(symbol),
      market_value: p.qty * priceOf(symbol), unrealized_pl: p.qty * (priceOf(symbol) - p.entry),
    })); },
    getIBKROpenOrders: async () => { sweepStops(); return state.orders.filter(mine); },
    getIBKRDayPnl: async () => {
      const mtm = state.equity + Object.entries(state.pos).reduce((a, [s, p]) => a + p.qty * (priceOf(s) - p.entry), 0);
      const d = DAY(NOW_MS);
      if (!state.dayStart || state.dayStart.day !== d) state.dayStart = { day: d, equity: mtm };
      return mtm - state.dayStart.equity;
    },
    getIBKROrderStatus: async () => null,
    cancelIBKROrder: async (u, id) => { state.orders = state.orders.filter((o) => !(String(o.orderId) === String(id) && mine(o))); return { status: "cancelled" }; },
    placeIBKROrder: async (u, o) => {
      const sym = String(o.ticker).toUpperCase(), px = priceOf(sym);
      if (!(px > 0)) return { status: "error", reason: "no price" };
      const held = state.pos[sym];
      if (/stop/i.test(o.type || "")) {
        if (held && !mine(held)) return { status: "error", reason: "symbol owned by the other sleeve" };
        state.orders.push({ orderId: tag + owner + "S" + (++state.seq), symbol: sym, side: "sell", orderType: "STP", status: "Submitted", qty: o.qty, stopPrice: o.stopPrice, _placedAt: NOW_MS, owner });
        return { status: "placed", order_id: tag + owner + "S" + state.seq };
      }
      const qty = Number(o.qty) || 0;
      if (String(o.side).toLowerCase() === "buy") {
        // SYMBOL OWNERSHIP: a name held by the other sleeve is refused, so the sleeves
        // never double a position or fight over its exit.
        if (held && !mine(held)) { state.refused[owner] = (state.refused[owner] || 0) + 1; return { status: "error", reason: "symbol owned by the other sleeve" }; }
        state.pos[sym] = { qty, entry: px, owner, at: NOW_MS };
      } else {
        if (!held || !mine(held)) return { status: "error", reason: held ? "symbol owned by the other sleeve" : "not held" };
        state.equity += held.qty * (px - held.entry);
        state.trades.push({ sym, ret: px / held.entry - 1, day: DAY(NOW_MS), owner, entry_ms: held.at, exit_ms: NOW_MS });
        delete state.pos[sym];
        state.orders = state.orders.filter((x) => x.symbol !== sym || !mine(x));
      }
      return { status: "placed", order_id: tag + owner + "O" + (++state.seq) };
    },
  };
}

// ------------------------------------------------- each sleeve's own entry rule
function signalsAt(day, m, sleeve) {
  const out = [];
  const thr = sleeve === "S"
    ? (m < 660 ? (Number(process.env.TRADER_IBS_MAX_MORNING) || 0.12) : (Number(process.env.TRADER_IBS_MAX) || 0.30))   // stable: scan.js morning gate + all-day threshold
    : (Number(process.env.TRADER_IBS_MAX) || 0.15);                                                                   // race: flat all day
  for (const s of SYMS) {
    const a = DATA[s]; if (!a) continue;
    const sess = a.filter((b) => b.d === day && b.m >= 570 && b.m <= m);
    if (sess.length < 3) continue;
    const hi = Math.max(...sess.map((b) => b.h)), lo = Math.min(...sess.map((b) => b.l));
    if (!(hi > lo)) continue;
    const cur = sess[sess.length - 1];
    const ibs = (cur.c - lo) / (hi - lo);
    const bullish = ibs <= thr, bearish = ibs >= 0.6;
    out.push({ symbol: s, direction: bullish ? "BULLISH" : (bearish ? "BEARISH" : "NEUTRAL"), entry_price: cur.c,
      decision_context: { ibs, spy_tape: 0 }, convergence: { decision: (bullish || bearish) ? "ENTER" : "SKIP", p_win: 0.6 } });
  }
  return out;
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
  const days = [...new Set(Object.values(DATA).flat().map((b) => b.d))].sort();
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
  // The LLM entry judge fires inside runAutoTrade and journals into the LIVE
  // entry-judge.jsonl — with no key in a replay it wrote ~4,900 degraded rows into
  // stable's journal. Never let a replay call it.
  BASE_S.TRADER_ENTRY_JUDGE = "0"; BASE_R.TRADER_ENTRY_JUDGE = "0";
  // REPLAY_EXCLUDE=SYM,SYM removes names from the signal universe (entry-quality tests)
  const EXCL = new Set(String(process.env.REPLAY_EXCLUDE || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
  if (EXCL.size) { for (const s of EXCL) delete DATA[s]; console.log(`  [exclude] ${[...EXCL].join(" ")} removed from the universe`); }
  const HALF = { TRADER_MAX_CONCURRENT: "3", TRADER_POSITION_PCT: "6", TRADER_MAX_POSITION_PCT: "6" };
  const VARIANTS = [
    ["S_full",     { active: ["S"],      S: {},   R: {} }],
    ["R_full",     { active: ["R"],      S: {},   R: {} }],
    ["blend_half", { active: ["S", "R"], S: HALF, R: HALF }],
    ["blend_full", { active: ["S", "R"], S: {},   R: {} }],
  ];
  const ALL_KEYS = new Set([...Object.keys(BASE_S), ...Object.keys(BASE_R), ...VARIANTS.flatMap(([, v]) => [...Object.keys(v.S), ...Object.keys(v.R)])]);
  const applyEnv = (map) => { for (const k of ALL_KEYS) delete process.env[k]; for (const [k, v] of Object.entries(map)) process.env[k] = v; };
  console.log(`\nTWO-SLEEVE ENGINE REPLAY — ${days.length} sessions, ${Object.keys(DATA).length} symbols\n`);
  console.log(`  ${"variant".padEnd(14)}${"return".padStart(9)}${"trades".padStart(8)}${"WR".padStart(6)}${"avg win".padStart(9)}${"avg loss".padStart(10)}${"payoff".padStart(8)}   maxDD   per-sleeve`);

  for (const [name, v] of VARIANTS) {
    const tag = name.replace(/\W+/g, "") + "-";
    const envFor = { S: { ...BASE_S, ...v.S }, R: { ...BASE_R, ...v.R } };
    for (const sl of v.active) { try { fs.unlinkSync(STATE_FILES[sl]); } catch (_e) {} applyEnv(envFor[sl]); AT[sl]._resetCooldowns(); AT[sl]._loadState(); }
    const state = { equity: 100000, pos: {}, orders: [], trades: [], seq: 0, curve: [], refused: {} };
    const bridges = { S: makeBroker(state, "S", tag), R: makeBroker(state, "R", tag) };
    const census = { S: {}, R: {} };
    for (const day of days) {
      for (let m = 570; m <= 960; m += 5) {
        const cur = (DATA.SPY || []).find((b) => b.d === day && b.m === m);
        if (!cur) continue;
        NOW_MS = cur.t;
        for (const sl of v.active) {
          applyEnv(envFor[sl]);
          try {
            const r = await AT[sl].runAutoTrade({ signals: signalsAt(day, m, sl) }, { bridge: bridges[sl], userId: "replay-" + sl, now: NOW_MS });
            for (const s of ((r && r.skipped) || [])) { const k = String(s.why || "?").split(/[—(:]/)[0].trim().slice(0, 26); census[sl][k] = (census[sl][k] || 0) + 1; }
          } catch (_e) { /* fail-soft */ }
        }
      }
      state.curve.push(state.equity + Object.entries(state.pos).reduce((s, [sym, p]) => s + p.qty * ((((DATA[sym] || []).filter((b) => b.d === day).slice(-1)[0]) || { c: p.entry }).c - p.entry), 0));
    }
    for (const sym of Object.keys(state.pos)) {
      const a = DATA[sym] || []; const last = a[a.length - 1];
      if (last) { const p = state.pos[sym]; state.equity += p.qty * (last.c - p.entry); state.trades.push({ sym, ret: last.c / p.entry - 1, day: last.d, why: "end_of_data", owner: p.owner, entry_ms: p.at, exit_ms: last.t }); }
      delete state.pos[sym];
    }
    if (process.env.REPLAY_DUMP) fs.writeFileSync(process.env.REPLAY_DUMP + "." + name + ".json", JSON.stringify(state.trades));
    const tr = state.trades, w = tr.filter((t) => t.ret > 0), l = tr.filter((t) => t.ret < 0);
    const avg = (a) => (a.length ? a.reduce((s, t) => s + t.ret, 0) / a.length * 100 : 0);
    let pk = -Infinity, dd = 0; for (const e of state.curve) { pk = Math.max(pk, e); dd = Math.max(dd, (pk - e) / pk * 100); }
    const per = v.active.map((sl) => { const t = tr.filter((x) => x.owner === sl); return `${sl}:${t.length}tr ${(t.reduce((s, x) => s + x.ret, 0) * 100).toFixed(1)}%`; }).join("  ");
    console.log(`  ${name.padEnd(14)}${((state.equity / 100000 - 1) * 100).toFixed(2).padStart(8)}%${String(tr.length).padStart(8)}${(tr.length ? (w.length / tr.length * 100).toFixed(0) + "%" : "-").padStart(6)}${(avg(w).toFixed(3) + "%").padStart(9)}${(avg(l).toFixed(3) + "%").padStart(10)}${(avg(l) !== 0 ? Math.abs(avg(w) / avg(l)).toFixed(2) : "-").padStart(8)}   ${dd.toFixed(2).padStart(5)}%   ${per}${Object.keys(state.refused).length ? "   refused " + JSON.stringify(state.refused) : ""}`);
    for (const sl of v.active) { const c = Object.entries(census[sl]).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k}:${n}`).join("  "); if (c) console.log(`      gates ${sl}: ${c}`); }
    const h1 = new Set(days.slice(0, Math.floor(days.length / 2)));
    for (const [hn, ht] of [["h1", tr.filter((t) => h1.has(t.day))], ["h2", tr.filter((t) => !h1.has(t.day))]]) {
      const hw = ht.filter((t) => t.ret > 0);
      console.log(`      ${hn}: n=${String(ht.length).padStart(3)}  WR=${(ht.length ? (hw.length / ht.length * 100).toFixed(0) : "-")}%  sum ${(ht.reduce((s, t) => s + t.ret, 0) * 100).toFixed(2)}%`);
    }
  }
})().catch((e) => { console.error("replay failed:", e.message, e.stack); process.exit(1); });
