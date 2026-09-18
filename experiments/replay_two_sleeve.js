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
// Variants: REPLAY_VARIANTS=<json> ([{name, active, S:{env}, R:{env}, order:"SR"|"RS", exS:[], exR:[]}]).
// Universe: REPLAY_EXCLUDE=SYM,SYM (global). Sessions: REPLAY_DAYS=N (first N). Dumps: REPLAY_DUMP=<prefix>
// (per-variant trades + .daily.json with the per-sleeve MTM series, collisions, refusals).
const fs = require("fs"), path = require("path");
const LONGS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL", "TNA", "SPXL", "TQQQ", "UPRO"];
const INV = ["SQQQ", "SOXS", "SPXS", "TZA"];
const SYMS = [...LONGS, ...INV];
const CACHE = path.join(process.env.TEMP || "/tmp", "rev60cache");
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
for (const APP of [APP_S, APP_R]) {
  const mdPath = require.resolve(path.join(APP, "lib", "market-data-yahoo.js"));
  require.cache[mdPath] = { id: mdPath, filename: mdPath, loaded: true, exports: stub };
}
const TMP = fs.mkdtempSync(path.join(require("os").tmpdir(), "sleeves-"));
process.env.TRADER_AUTO_EXECUTE = "1"; process.env.TRADER_MANAGE_EXITS = "1"; process.env.TRADER_LIVE = "0";
process.env.TRADER_TRADES_LOG = path.join(TMP, "trades_S.jsonl"); process.env.TRADER_STATE_FILE = path.join(TMP, "state_S.json");
const atS = require(path.join(APP_S, "lib", "auto-trader"));
process.env.TRADER_TRADES_LOG = path.join(TMP, "trades_R.jsonl"); process.env.TRADER_STATE_FILE = path.join(TMP, "state_R.json");
const atR = require(path.join(APP_R, "lib", "auto-trader"));
const AT = { S: atS, R: atR };
const STATE_FILES = { S: path.join(TMP, "state_S.json"), R: path.join(TMP, "state_R.json") };

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
      if (o.orderType !== "STP" || o.status === "Filled") continue;
      if (!(o._placedAt < NOW_MS)) continue;
      const held = state.pos[o.symbol]; if (!held) continue;
      const b = barsUpTo(o.symbol, 1)[0]; if (!b) continue;
      const stop = Number(o.stopPrice);
      if (!(stop > 0) || !(Number(b.low) <= stop)) continue;
      const fillPx = Number(b.high) < stop ? Number(b.high) : stop;
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
        state.orders.push({ orderId: id, symbol: sym, side: "sell", orderType: "STP", status: "Submitted", qty: o.qty, stopPrice: o.stopPrice, _placedAt: NOW_MS, owner });
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
function signalsAt(day, m, sleeve) {
  const out = [];
  const thr = sleeve === "S"
    ? (m < 660 ? (Number(process.env.TRADER_IBS_MAX_MORNING) || 0.12) : (Number(process.env.TRADER_IBS_MAX) || 0.30))
    : (Number(process.env.TRADER_IBS_MAX) || 0.15);
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
    VARIANTS = list.map((v) => [v.name, { active: v.active, S: v.S || {}, R: v.R || {}, order: v.order || "SR", exS: v.exS || [], exR: v.exR || [] }]);
    console.log(`  [variants] ${VARIANTS.length} from ${process.env.REPLAY_VARIANTS}: ${VARIANTS.map(([n]) => n).join(" ")}`);
  }
  console.log(`\nTWO-SLEEVE ENGINE REPLAY (engine core) — ${days.length} sessions, ${Object.keys(DATA).length} symbols\n`);
  console.log(`  ${"variant".padEnd(18)}${"return".padStart(9)}${"trades".padStart(8)}${"WR".padStart(6)}${"avg win".padStart(9)}${"avg loss".padStart(10)}${"payoff".padStart(8)}   maxDD   per-sleeve`);

  for (const [name, v] of VARIANTS) {
    const t0 = _RealDate.now();
    const tag = name.replace(/\W+/g, "") + "-";
    const envFor = { S: { ...BASE_S, ...v.S }, R: { ...BASE_R, ...v.R } };
    const exc = { S: new Set(v.exS || []), R: new Set(v.exR || []) };
    const order = (v.order === "RS" ? ["R", "S"] : ["S", "R"]).filter((sl) => v.active.includes(sl));
    const state = { equity: 100000, pos: {}, orders: [], trades: [], seq: 0, curve: [], realBy: { S: 0, R: 0 }, collisions: [], daily: [] };
    const account = makeAccount(state, tag);
    const rows = [];
    const engine = createEngine({
      sleeves: order.map((id) => ({ id, brain: AT[id], env: envFor[id], userId: "replay-" + id, universe: SYMS.filter((s) => !exc[id].has(s)) })),
      order, facade: account, ownership: createOwnership({ defaultOwner: "S" }),
      journal: (r) => { if (r.event === "collision") state.collisions.push({ day: DAY(NOW_MS), ms: NOW_MS, sym: r.symbol, loser: r.loser, winner: r.winner }); rows.push(r); },
    });
    for (const sl of order) { try { fs.unlinkSync(STATE_FILES[sl]); } catch (_e) {} engine.applyEnv(envFor[sl]); AT[sl]._resetCooldowns(); AT[sl]._loadState(); }
    engine.restoreEnv();
    const census = { S: {}, R: {} };
    for (const day of days) {
      for (let m = 570; m <= 960; m += 5) {
        const cur = (DATA.SPY || []).find((b) => b.d === day && b.m === m);
        if (!cur) continue;
        NOW_MS = cur.t;
        const res = await engine.tick((sl) => ({ signals: signalsAt(day, m, sl.id) }), { now: NOW_MS, userId: "replay-" + order[0] });
        for (const sl of order) for (const s of (((res[sl] || {}).skipped) || [])) { const k = String(s.why || "?").split(/[—(:]/)[0].trim().slice(0, 26); census[sl][k] = (census[sl][k] || 0) + 1; }
      }
      const unreal = { S: 0, R: 0 };
      for (const [sym, p] of Object.entries(state.pos)) {
        const last = ((DATA[sym] || []).filter((b) => b.d === day).slice(-1)[0]) || { c: p.entry };
        unreal[p.owner] = (unreal[p.owner] || 0) + p.qty * (last.c - p.entry);
      }
      state.curve.push(state.equity + unreal.S + unreal.R);
      state.daily.push({ day, S: state.realBy.S + unreal.S, R: state.realBy.R + unreal.R, acct: state.equity + unreal.S + unreal.R, openS: Object.values(state.pos).filter((p) => p.owner === "S").length, openR: Object.values(state.pos).filter((p) => p.owner === "R").length });
    }
    for (const sym of Object.keys(state.pos)) {
      const a = (DATA[sym] || []).filter((b) => b.d <= days[days.length - 1]); const last = a[a.length - 1];
      if (last) { const p = state.pos[sym]; const pnl = p.qty * (last.c - p.entry); state.equity += pnl; state.realBy[p.owner] += pnl; state.trades.push({ sym, ret: last.c / p.entry - 1, pnl, day: last.d, why: "end_of_data", owner: p.owner, entry_ms: p.at, exit_ms: last.t }); }
      delete state.pos[sym];
    }
    const refused = engine.stats.refusedBy;
    if (process.env.REPLAY_DUMP) {
      fs.writeFileSync(process.env.REPLAY_DUMP + "." + name + ".json", JSON.stringify(state.trades));
      fs.writeFileSync(process.env.REPLAY_DUMP + "." + name + ".daily.json", JSON.stringify({ name, active: v.active, order, exS: v.exS, exR: v.exR, S: v.S, R: v.R, daily: state.daily, refused, collisions: state.collisions, engine: engine.stats }));
    }
    const tr = state.trades, w = tr.filter((t) => t.ret > 0), l = tr.filter((t) => t.ret < 0);
    const avg = (a) => (a.length ? a.reduce((s, t) => s + t.ret, 0) / a.length * 100 : 0);
    let pk = -Infinity, dd = 0; for (const e of state.curve) { pk = Math.max(pk, e); dd = Math.max(dd, (pk - e) / pk * 100); }
    const per = order.map((sl) => { const t = tr.filter((x) => x.owner === sl); return `${sl}:${t.length}tr ${(t.reduce((s, x) => s + x.ret, 0) * 100).toFixed(1)}%`; }).join("  ");
    const stops = tr.filter((t) => t.why === "stop").length;
    console.log(`  ${name.padEnd(18)}${((state.equity / 100000 - 1) * 100).toFixed(2).padStart(8)}%${String(tr.length).padStart(8)}${(tr.length ? (w.length / tr.length * 100).toFixed(0) + "%" : "-").padStart(6)}${(avg(w).toFixed(3) + "%").padStart(9)}${(avg(l).toFixed(3) + "%").padStart(10)}${(avg(l) !== 0 ? Math.abs(avg(w) / avg(l)).toFixed(2) : "-").padStart(8)}   ${dd.toFixed(2).padStart(5)}%   ${per}${Object.keys(refused).length ? "   refused " + JSON.stringify(refused) : ""}   stops ${stops}   ${((_RealDate.now() - t0) / 60000).toFixed(1)}min`);
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
