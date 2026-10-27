"use strict";
/**
 * two-sleeve-reserve.test.js — the engine's cash reserve (lib/two-sleeve/reserve.js, 2026-10-27).
 *
 * The reserve parks a share of equity in one cash-like fund (BOXX) that no sleeve may see or sell. These tests pin:
 * the sizing rules (target, band, cash floor, whole shares, unwind), the cadence (once per ET day, inside the
 * window only, retried when the account is unreadable), the ownership contract (the fund is adopted by RESERVE,
 * never by the default sleeve, and stays invisible to every sleeve's bridge), and the dry wall (a refused order
 * claims nothing).
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { reserveConfig, planReserve, createReserve, parseWindow, OWNER } = require("../lib/two-sleeve/reserve");
const { createOwnership } = require("../lib/two-sleeve/ownership");
const { createEngine } = require("../lib/two-sleeve/engine");
const { dryFacade } = require("../lib/two-sleeve/runner-support");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "two-sleeve-reserve-"));
// 2026-10-27 is a Tuesday; EDT (UTC-4) until 11-01, so 12:05 ET = 16:05Z.
const AT = (hhmm, day = "2026-10-27") => Date.parse(`${day}T${hhmm}:00-04:00`);
const CFG = { symbol: "BOXX", pct: 30, bandPct: 10, minCashPct: 5, window: "12:00-12:30" };

function stubFacade({ equity = 100000, cash = 80000, pos = {} } = {}) {
  const st = { equity, cash, pos: { ...pos }, placed: [], seq: 0, accountOk: true };
  return {
    st,
    getIBKRAccount: async () => (st.accountOk ? { equity: st.equity, cash: st.cash } : null),
    getIBKRPositions: async () => ({ positions: Object.entries(st.pos).map(([symbol, p]) => ({ symbol, qty: p.qty, current_price: p.price })) }),
    getIBKROpenOrders: async () => [],
    getIBKRDayPnl: async () => 0,
    cancelIBKROrder: async () => ({ status: "cancelled" }),
    placeIBKROrder: async (u, o) => {
      st.placed.push(o);
      const id = "r" + (++st.seq);
      const px = (st.pos[o.ticker] && st.pos[o.ticker].price) || 119;
      const cur = (st.pos[o.ticker] && st.pos[o.ticker].qty) || 0;
      const q = o.side === "buy" ? cur + o.qty : cur - o.qty;
      if (q > 0) st.pos[o.ticker] = { qty: q, price: px }; else delete st.pos[o.ticker];
      st.cash += (o.side === "buy" ? -1 : 1) * o.qty * px;
      return { status: "placed", order_id: id };
    },
  };
}

test("config: absent, missing pct, out of range or junk = no reserve; defaults fill the rest", () => {
  assert.equal(reserveConfig(undefined), null);
  assert.equal(reserveConfig({ symbol: "BOXX" }), null);
  assert.equal(reserveConfig({ pct: -1 }), null);
  assert.equal(reserveConfig({ pct: 95 }), null);
  assert.equal(reserveConfig({ pct: "x" }), null);
  const c = reserveConfig({ pct: 30 });
  assert.equal(c.symbol, "BOXX"); assert.equal(c.bandPct, 10); assert.equal(c.minCashPct, 5); assert.equal(c.window, "12:00-12:30");
  assert.deepEqual(c.win, { from: 720, to: 750 });
  assert.equal(reserveConfig({ pct: 30, window: "13:00-12:00" }).window, "12:00-12:30", "a backwards window falls back to the default");
  assert.equal(parseWindow("9:35-10:05").from, 575);
});

test("plan: buys whole shares up to the target, never below the cash floor", () => {
  const c = reserveConfig(CFG);
  const p = planReserve(c, { equity: 100000, cash: 80000, qty: 0, price: 119 });
  assert.equal(p.action, "buy"); assert.equal(p.qty, Math.floor(30000 / 119));
  // only 20k of cash: the 5k floor leaves 15k of room
  const q = planReserve(c, { equity: 100000, cash: 20000, qty: 0, price: 119 });
  assert.equal(q.action, "buy"); assert.equal(q.qty, Math.floor(15000 / 119)); assert.ok(q.cashAfter >= 5000);
  // nothing above the floor: hold
  assert.equal(planReserve(c, { equity: 100000, cash: 5000, qty: 0, price: 119 }).action, "hold");
});

test("plan: holds inside the band, trims above it, tops up below it", () => {
  const c = reserveConfig(CFG);
  assert.equal(planReserve(c, { equity: 100000, cash: 60000, qty: 260, price: 119 }).action, "hold");   // 30,940 vs 30,000 +- 3,000
  const s = planReserve(c, { equity: 100000, cash: 60000, qty: 300, price: 119 });                      // 35,700: 5,700 over
  assert.equal(s.action, "sell"); assert.equal(s.qty, Math.floor(5700 / 119));
  const b = planReserve(c, { equity: 100000, cash: 60000, qty: 200, price: 119 });                      // 23,800: 6,200 under
  assert.equal(b.action, "buy"); assert.equal(b.qty, Math.floor(6200 / 119));
});

test("plan: cash under the floor sells enough fund to restore it, even inside the band", () => {
  const c = reserveConfig(CFG);
  const p = planReserve(c, { equity: 100000, cash: -2000, qty: 252, price: 119 });   // 29,988 = on target, but cash is in debit
  assert.equal(p.action, "sell"); assert.equal(p.qty, Math.ceil(7000 / 119)); assert.ok(p.cashAfter >= 5000);
  const all = planReserve(c, { equity: 100000, cash: -50000, qty: 10, price: 119 });
  assert.equal(all.action, "sell"); assert.equal(all.qty, 10, "never sells more than it holds");
});

test("plan: pct 0 unwinds the whole holding; no price or no account means hold", () => {
  const c = reserveConfig({ ...CFG, pct: 0 });
  const p = planReserve(c, { equity: 100000, cash: 50000, qty: 252, price: 119 });
  assert.equal(p.action, "sell"); assert.equal(p.qty, 252);
  assert.equal(planReserve(c, { equity: 100000, cash: 50000, qty: 0, price: 119 }).action, "hold");
  const d = reserveConfig(CFG);
  assert.equal(planReserve(d, { equity: 100000, cash: 80000, qty: 0, price: 0 }).why, "no price");
  assert.equal(planReserve(d, { equity: 0, cash: 80000, qty: 0, price: 119 }).why, "account unreadable");
});

test("cadence: decides once per ET day, only inside the window, and a relaunch does not decide twice", async () => {
  const dir = tmpDir(); const stateFile = path.join(dir, "reserve.state.json");
  const facade = stubFacade();
  const own = createOwnership({ file: path.join(dir, "ownership.json"), reserved: { BOXX: OWNER } });
  const rows = [];
  const mk = () => createReserve({ cfg: CFG, facade, ownership: own, journal: (r) => rows.push(r), quote: async () => 119, userId: "u", stateFile });
  const r = mk();
  assert.equal((await r.maybeRun(AT("11:59"))).ran, false, "before the window");
  assert.equal((await r.maybeRun(AT("12:30"))).ran, false, "the window end is exclusive");
  const first = await r.maybeRun(AT("12:01"));
  assert.equal(first.ran, true); assert.equal(first.plan.action, "buy"); assert.equal(facade.st.placed.length, 1);
  assert.equal((await r.maybeRun(AT("12:06"))).why, "already decided today");
  const again = mk();   // a relaunch inside the window reads the state file
  assert.equal((await again.maybeRun(AT("12:11"))).why, "already decided today");
  assert.equal(facade.st.placed.length, 1);
  const next = await again.maybeRun(AT("12:02", "2026-10-28"));
  assert.equal(next.ran, true); assert.equal(next.plan.action, "hold", "on target the next day");
  assert.ok(rows.some((x) => x.event === "reserve_plan") && rows.some((x) => x.event === "reserve_order" && x.ok === true));
});

test("cadence: an unreadable account burns no day; the next tick in the window decides", async () => {
  const dir = tmpDir();
  const facade = stubFacade(); facade.st.accountOk = false;
  const own = createOwnership({ file: path.join(dir, "ownership.json"), reserved: { BOXX: OWNER } });
  const rows = [];
  const r = createReserve({ cfg: CFG, facade, ownership: own, journal: (x) => rows.push(x), quote: async () => 119, userId: "u", stateFile: path.join(dir, "s.json") });
  assert.equal((await r.maybeRun(AT("12:00"))).why, "unreadable");
  assert.ok(rows.some((x) => x.event === "reserve_skip"));
  facade.st.accountOk = true;
  assert.equal((await r.maybeRun(AT("12:01"))).plan.action, "buy");
});

test("ownership: a buy is claimed and tagged by RESERVE; a held, unclaimed fund is adopted by RESERVE, never by S", async () => {
  const dir = tmpDir();
  const facade = stubFacade();
  const own = createOwnership({ file: path.join(dir, "ownership.json"), defaultOwner: "S", reserved: { BOXX: OWNER } });
  const r = createReserve({ cfg: CFG, facade, ownership: own, quote: async () => 119, userId: "u", stateFile: path.join(dir, "s.json") });
  await r.maybeRun(AT("12:00"));
  assert.equal(own.ownerOf("BOXX"), OWNER);
  assert.equal(own.orderOwner("r1").owner, OWNER);
  // a lost registry: the fund is held and nobody claimed it
  const fresh = createOwnership({ file: path.join(dir, "lost.json"), defaultOwner: "S", reserved: { BOXX: OWNER } });
  const { adopted } = fresh.reconcile([{ symbol: "BOXX", qty: 252 }, { symbol: "SPY", qty: 7 }]);
  assert.deepEqual(adopted.sort(), ["BOXX", "SPY"]);
  assert.equal(fresh.ownerOf("BOXX"), OWNER); assert.equal(fresh.ownerOf("SPY"), "S");
  // without the reservation the old rule stands
  const plain = createOwnership({ file: path.join(dir, "plain.json"), defaultOwner: "S" });
  plain.reconcile([{ symbol: "BOXX", qty: 252 }]);
  assert.equal(plain.ownerOf("BOXX"), "S");
});

test("engine: no sleeve sees the reserve's position or may buy its fund", async () => {
  const dir = tmpDir();
  const facade = stubFacade({ pos: { BOXX: { qty: 252, price: 119 }, SPY: { qty: 7, price: 766 } } });
  const own = createOwnership({ file: path.join(dir, "ownership.json"), defaultOwner: "S", reserved: { BOXX: OWNER } });
  const seen = {};
  const brain = (id) => ({ runAutoTrade: async (scan, { bridge, userId, excludeSymbols }) => {
    seen[id] = { positions: (await bridge.getIBKRPositions(userId)).map((p) => p.symbol), exclude: excludeSymbols };
    return { placed: [await bridge.placeIBKROrder(userId, { ticker: "BOXX", side: "buy", qty: 1, type: "MKT" })] };
  } });
  const eng = createEngine({ sleeves: [{ id: "S", brain: brain("S"), env: {} }, { id: "C", brain: brain("C"), env: {} }], order: ["S", "C"], facade, ownership: own, defaultOwner: "S" });
  const res = await eng.tick({ signals: [] }, { userId: "u", excludeSymbols: ["BOXX"] });
  assert.deepEqual(seen.S.positions, ["SPY"], "S adopts SPY but never the reserve");
  assert.deepEqual(seen.C.positions, []);
  assert.ok(seen.S.exclude.includes("BOXX") && seen.C.exclude.includes("BOXX"), "every brain is told to leave the fund alone");
  for (const id of ["S", "C"]) assert.equal(res[id].placed[0].status, "error", `${id} may not buy the reserved fund`);
  assert.equal(facade.st.placed.length, 0);
});

test("dry wall: a refused reserve order claims nothing and is journaled as a dry order", async () => {
  const dir = tmpDir();
  const real = stubFacade();
  const rows = [];
  const facade = dryFacade(real, (x) => rows.push(x));
  const own = createOwnership({ file: path.join(dir, "ownership.json"), reserved: { BOXX: OWNER } });
  const r = createReserve({ cfg: CFG, facade, ownership: own, journal: (x) => rows.push(x), quote: async () => 119, userId: "u", stateFile: path.join(dir, "s.json") });
  const out = await r.maybeRun(AT("12:00"));
  assert.equal(out.plan.action, "buy"); assert.equal(out.ok, false);
  assert.equal(real.st.placed.length, 0, "nothing reached the broker");
  assert.equal(own.ownerOf("BOXX"), null, "a refused buy claims nothing");
  assert.ok(rows.some((x) => x.event === "dry_order" && x.owner === OWNER && x.order.ticker === "BOXX"));
  assert.ok(rows.some((x) => x.event === "reserve_order" && x.ok === false));
});
