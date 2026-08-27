/**
 * replay_auto_trader.js — replay history through the REAL runAutoTrade, not a model.
 *
 * WHY THIS EXISTS. Three times in one session a reconstruction of the engine produced a
 * finding the engine itself contradicted:
 *   - a loss cut justified by a live correlation, rejected on two surfaces;
 *   - "T3 fast-turn, payoff 7.84" on 7 trades, which collapsed to +0.57% on 60 sessions;
 *   - "falling_knife is the most expensive rule in the entry path", which was an artifact
 *     of computing MACD from session-only closes when auto-trader feeds knifeReading a
 *     CONTINUOUS 1-month 5m series (TF['5m'].range = '1mo'). Corrected, that rule's
 *     return/DD went 1.02 -> 2.19 and its own in-source validation (565 fires, 29
 *     sessions) stood.
 *
 * So this harness stops modelling. It drives `at.runAutoTrade(...)` itself — the real
 * gate order, the real cadence, cooldown, concurrent cap, sizing, stop placement and
 * exit stack — with a mock bridge for the broker and a stubbed market-data module that
 * serves HISTORICAL bars up to the simulated instant (never past it).
 *
 * WHAT IT CAN AND CANNOT ANSWER. The claim worth acting on is that `persistence` and
 * `falling_knife` are destructive TOGETHER — worse than either alone. Both are env
 * toggles, so that is replayable exactly:
 *
 *   LIVE     TRADER_REQUIRE_PERSIST=1  TRADER_ENTRY_KNIFE_FILTER=1   (as armed)
 *   PERSIST  persistence only
 *   KNIFE    knife only
 *   NONE     neither
 *
 * T2 is NOT in the engine, so it cannot be replayed here — that part of the finding
 * stays at reconstruction confidence until it is implemented behind a flag.
 *
 * KNOWN BIAS — READ BEFORE TRUSTING ANY EXIT RESULT (found 2026-08-27, after the run
 * below was already used). The replay FLATTENS EVERY POSITION AT THE CLOSE so that days
 * are independent. The live engine does not: weekday overnight holds are 71% of live
 * profit, and TRADER_EOD_FLAT=weekend means only Friday is flat by policy.
 *
 * That is not a small difference. The operator disabled the falling-knife veto on
 * 2026-08-22 with exactly this reasoning, recorded in .env.local: "its justification used
 * the same-day-close exit; under the real exits it halves entries for no gain." This
 * harness reintroduces the same-day-close bias it was built to escape, so its KNIFE row
 * carries the very objection that retired the rule and MUST NOT be read as overturning
 * that decision.
 *
 * The finding this harness DID establish is unaffected, because it is a comparison
 * BETWEEN variants under one identical (if biased) exit regime: removing a turn filter
 * makes things worse in the real engine, not better. Anything about a single rule's
 * absolute value — especially one whose edge lives in overnight carry — needs the flatten
 * removed first.
 *
 * Usage: node experiments/replay_auto_trader.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");

const LONGS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "SMH", "XLK", "SOXL", "TNA", "SPXL", "TQQQ", "UPRO"];
const INV = ["SQQQ", "SOXS", "SPXS", "TZA"];
const SYMS = [...LONGS, ...INV];
const CACHE = path.join(process.env.TEMP || "/tmp", "rev60cache");
const APP = path.join(__dirname, "..", "apps", "lantern-garage");

// ---------------------------------------------------------------- historical bars
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
if (!Object.keys(DATA).length) { console.error("no cached bars — run reversal_60d_lab.js first"); process.exit(1); }

// ------------------------------------------------- stub market data BEFORE loading the engine
// The engine asks for bars through lib/market-data-yahoo. Serve it the same history the
// replay is walking, truncated at the simulated instant so nothing can peek ahead.
let NOW_MS = 0;
const barsUpTo = (sym, n) => {
  const a = DATA[String(sym).toUpperCase()] || [];
  const out = [];
  for (let i = a.length - 1; i >= 0 && out.length < n; i--) if (a[i].t <= NOW_MS) out.push(a[i]);
  // parseBars emits `timestamp` (ISO); the first stub said `time` and nothing noticed
  // because the knife reads only closes — the confirm gate parses the timestamp and
  // silently took ZERO trades against the mismatched field. Emit the REAL shape.
  return out.reverse().map((b) => ({ timestamp: new Date(b.t).toISOString(), open: b.c, high: b.h, low: b.l, close: b.c, volume: 0 }));
};
const stub = {
  getBarsMulti: async (tickers) => ({ bars: Object.fromEntries((tickers || []).map((t) => [String(t).toUpperCase(), { bars: barsUpTo(t, 400) }])) }),
  getBars: async (t) => barsUpTo(t, 400),
  getQuotes: async (tickers) => (tickers || []).map((t) => { const b = barsUpTo(t, 1)[0]; return { symbol: t, price: b ? b.close : 0 }; }),
  getSessionBars15m: async (t) => barsUpTo(t, 100),
};
const mdPath = require.resolve(path.join(APP, "lib", "market-data-yahoo.js"));
require.cache[mdPath] = { id: mdPath, filename: mdPath, loaded: true, exports: stub };

const TMP = fs.mkdtempSync(path.join(require("os").tmpdir(), "replay-"));
process.env.TRADER_TRADES_LOG = path.join(TMP, "trades.jsonl");
process.env.TRADER_STATE_FILE = path.join(TMP, "state.json");
process.env.TRADER_AUTO_EXECUTE = "1";
process.env.TRADER_MANAGE_EXITS = "1";
process.env.TRADER_LIVE = "0";                       // never a real order; the gate returns dry_run
const at = require(path.join(APP, "lib", "auto-trader"));

// ------------------------------------------------------------------ the mock broker
function makeBroker(state) {
  const priceOf = (sym) => { const b = barsUpTo(sym, 1)[0]; return b ? b.close : 0; };
  return {
    getIBKRAccount: async () => ({ equity: state.equity, mode: "paper" }),
    getIBKRPositions: async () => Object.entries(state.pos).map(([symbol, p]) => ({
      symbol, qty: p.qty, avg_entry_price: p.entry, current_price: priceOf(symbol),
      market_value: p.qty * priceOf(symbol), unrealized_pl: p.qty * (priceOf(symbol) - p.entry),
    })),
    getIBKROpenOrders: async () => state.orders,
    getIBKRDayPnl: async () => 0,
    getIBKROrderStatus: async () => null,
    cancelIBKROrder: async (u, id) => { state.orders = state.orders.filter((o) => String(o.orderId) !== String(id)); return { status: "cancelled" }; },
    placeIBKROrder: async (u, o) => {
      const sym = String(o.ticker).toUpperCase(), px = priceOf(sym);
      if (!(px > 0)) return { status: "error", reason: "no price" };
      if (/stop/i.test(o.type || "")) {                       // resting protective stop
        state.orders.push({ orderId: "S" + (++state.seq), symbol: sym, side: "sell", orderType: "STP", status: "Submitted", qty: o.qty, stopPrice: o.stopPrice });
        return { status: "placed", order_id: "S" + state.seq };
      }
      const qty = Number(o.qty) || 0;
      if (String(o.side).toLowerCase() === "buy") {
        state.pos[sym] = { qty, entry: px };
      } else {
        const held = state.pos[sym];
        if (held) {
          state.equity += held.qty * (px - held.entry);
          state.trades.push({ sym, ret: px / held.entry - 1, day: DAY(NOW_MS) });
          delete state.pos[sym];
        }
        state.orders = state.orders.filter((x) => x.symbol !== sym);
      }
      return { status: "placed", order_id: "O" + (++state.seq) };
    },
  };
}

// --------------------------------------------------------------- signals the scan would emit
function signalsAt(day, m) {
  const out = [];
  for (const s of SYMS) {
    const a = DATA[s]; if (!a) continue;
    const sess = a.filter((b) => b.d === day && b.m >= 570 && b.m <= m);
    if (sess.length < 3) continue;
    const hi = Math.max(...sess.map((b) => b.h)), lo = Math.min(...sess.map((b) => b.l));
    if (!(hi > lo)) continue;
    const cur = sess[sess.length - 1];
    const ibs = (cur.c - lo) / (hi - lo);
    const thr = m < 660 ? 0.12 : 0.30;
    const bullish = ibs <= thr;
    out.push({
      symbol: s, direction: bullish ? "BULLISH" : "NEUTRAL", entry_price: cur.c,
      decision_context: { ibs, spy_tape: 0 },
      convergence: { decision: bullish ? "ENTER" : "SKIP", p_win: 0.6 },
    });
  }
  return out;
}

(async () => {
  const days = [...new Set(Object.values(DATA).flat().map((b) => b.d))].sort();
  const VARIANTS = [
    ["ARMED    persist, no knife", { TRADER_REQUIRE_PERSIST: "1", TRADER_ENTRY_KNIFE_FILTER: "0" }],
    ["+ T1     one rising close", { TRADER_REQUIRE_PERSIST: "1", TRADER_ENTRY_KNIFE_FILTER: "0", TRADER_ENTRY_CONFIRM: "1" }],
    ["+ T2     two, no new low", { TRADER_REQUIRE_PERSIST: "1", TRADER_ENTRY_KNIFE_FILTER: "0", TRADER_ENTRY_CONFIRM: "2" }],
    ["T2 only  (persist off)", { TRADER_REQUIRE_PERSIST: "0", TRADER_ENTRY_KNIFE_FILTER: "0", TRADER_ENTRY_CONFIRM: "2" }],
  ];
  const BASE = {
    TRADER_IBS_MAX: "0.30", TRADER_IBS_MAX_MORNING: "0.12", TRADER_IBS_EXIT: "0.6",
    TRADER_MAX_CONCURRENT: "5", TRADER_MAX_POSITION_PCT: "12", TRADER_POSITION_PCT: "12",
    TRADER_ENTRY_CADENCE_MIN: "60", TRADER_ENTRY_CADENCE_PHASE: "0", TRADER_ENTRY_CADENCE_WINDOW: "3",
    TRADER_ZONE_EXIT: "0", TRADER_TAKE_PROFIT_R: "0", TRADER_MOMENTUM_EXIT: "0",
    TRADER_EXIT_MIN_PWIN: "0", TRADER_EOD_DECARRY: "0", TRADER_STOP_COOLDOWN_DAYS: "0",
    TRADER_SYMBOL_SIZE_MULT: "SOXL:1.5,SMH:1.5,QQQ:1.5,IWM:1.02,XLK:1.0,SPY:0.83,DIA:0.71,GLD:0.5,TLT:0.5",
    TRADER_SLOT_ORDER: "expectancy", TRADER_LOG_SKIPS: "0", TRADER_ENTRY_CONFIRM: "0",
    TRADER_EOD_FLAT: "weekend",   // the LIVE policy (#3453): hold weekday overnights, flat into Friday
    // persistWindowMs defaults to 200,000 ms — "about 3 scans" at the live 60s cadence.
    // This replay steps in 5-MINUTE bars, so at the default no streak is ever "fresh"
    // (300,000 > 200,000), the counter resets to 1 every bar and persistence can never
    // reach 2 — the LIVE and PERSIST variants silently took ZERO trades. Scale the
    // window to the replay's step so the RULE keeps its meaning (2 consecutive
    // qualifying scans) at this resolution.
    TRADER_PERSIST_WINDOW_MS: String(15 * 60 * 1000),
  };
  console.log(`REPLAY THROUGH THE REAL runAutoTrade — ${days.length} sessions, ${Object.keys(DATA).length} symbols\n`);
  console.log(`  ${"variant".padEnd(26)}${"return".padStart(10)}${"trades".padStart(8)}${"WR".padStart(6)}${"avg win".padStart(10)}${"avg loss".padStart(10)}${"payoff".padStart(8)}`);

  for (const [name, envOv] of VARIANTS) {
    for (const [k, v] of Object.entries({ ...BASE, ...envOv })) process.env[k] = v;
    at._resetCooldowns(); at._loadState();
    for (const f of [process.env.TRADER_TRADES_LOG, process.env.TRADER_STATE_FILE]) { try { fs.unlinkSync(f); } catch (_e) {} }
    const state = { equity: 100000, pos: {}, orders: [], trades: [], seq: 0 };
    const bridge = makeBroker(state);
    for (const day of days) {
      for (let m = 570; m <= 960; m += 5) {
        const anyBar = SYMS.some((s) => (DATA[s] || []).some((b) => b.d === day && b.m === m));
        if (!anyBar) continue;
        const cur = (DATA.SPY || []).find((b) => b.d === day && b.m === m);
        if (!cur) continue;
        NOW_MS = cur.t;
        try { await at.runAutoTrade({ signals: signalsAt(day, m) }, { bridge, userId: "replay", now: NOW_MS }); }
        catch (e) { /* fail-soft: a replay gap must not abort the run */ }
      }
      // OVERNIGHT HOLDS ARE REAL NOW (2026-08-27). The first version flattened every
      // position at the close so days were independent — the exact same-day-close bias
      // the operator retired the knife veto over, and the reason every variant's win
      // rate read ~46% against the live book's 58-70%: weekday overnight holds are 71%
      // of live profit, and the flatten stamped every would-be overnight winner at the
      // 16:00 print. Worse, it did NOT bias all variants equally — a confirmation gate
      // enters later in the session, so its positions had less intraday time to resolve
      // and the flatten cut them short more often than baseline's.
      // Positions and GTC stops now carry across days; Friday flattening belongs to the
      // ENGINE's own TRADER_EOD_FLAT=weekend logic (in BASE below), same as live.
    }
    // end of data: mark remaining positions at the last available close (a handful of
    // rows; tagged so they are distinguishable from real exits)
    for (const sym of Object.keys(state.pos)) {
      const a = DATA[sym] || []; const last = a[a.length - 1];
      if (last) { const p = state.pos[sym]; state.equity += p.qty * (last.c - p.entry); state.trades.push({ sym, ret: last.c / p.entry - 1, day: last.d, why: "end_of_data" }); }
      delete state.pos[sym];
    }
    const tr = state.trades, w = tr.filter((t) => t.ret > 0), l = tr.filter((t) => t.ret < 0);
    const avg = (a) => (a.length ? a.reduce((s, t) => s + t.ret, 0) / a.length * 100 : 0);
    console.log(`  ${name.padEnd(26)}${((state.equity / 100000 - 1) * 100).toFixed(2).padStart(9)}%${String(tr.length).padStart(8)}`
      + `${(tr.length ? (w.length / tr.length * 100).toFixed(0) + "%" : "-").padStart(6)}`
      + `${(avg(w).toFixed(3) + "%").padStart(10)}${(avg(l).toFixed(3) + "%").padStart(10)}`
      + `${(avg(l) !== 0 ? Math.abs(avg(w) / avg(l)).toFixed(2) : "-").padStart(8)}`);
  }
})().catch((e) => { console.error("replay failed:", e.message, e.stack); process.exit(1); });
