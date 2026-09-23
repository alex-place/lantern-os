"use strict";
/**
 * two-sleeve-engine.test.js — two brains, one account, symbol ownership (#3656).
 *
 * The teamwork sweep of 2026-09-18 settled the design: the stable sleeve claims a shared
 * washout first at a small budget, the race sleeve keeps its identity, neither may buy a
 * symbol the other holds, and no env knob may leak between them. These tests pin those
 * contracts on the engine core with stub brains and a stub broker, so the replay harness
 * and the live runner (which both drive this core) inherit them.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createOwnership } = require("../lib/two-sleeve/ownership");
const { createEngine } = require("../lib/two-sleeve/engine");

// A minimal broker: positions keyed by symbol, orders with ids, no prices.
function stubFacade() {
  const st = { pos: {}, orders: [], seq: 0, placed: [] };
  return {
    st,
    getIBKRAccount: async () => ({ equity: 100000 }),
    getIBKRPositions: async () => Object.entries(st.pos).map(([symbol, p]) => ({ symbol, qty: p.qty })),
    getIBKROpenOrders: async () => st.orders,
    getIBKRDayPnl: async () => 0,
    cancelIBKROrder: async (u, id) => { st.orders = st.orders.filter((o) => o.orderId !== id); return { status: "cancelled" }; },
    placeIBKROrder: async (u, o) => {
      st.placed.push(o);
      const id = "o" + (++st.seq);
      if (/stop/i.test(o.type || "")) { st.orders.push({ orderId: id, symbol: o.ticker, type: "STP" }); return { status: "placed", order_id: id }; }
      if (o.side === "buy") st.pos[o.ticker] = { qty: o.qty };
      else delete st.pos[o.ticker];
      return { status: "placed", order_id: id };
    },
  };
}

// A brain that records the env it saw and does what its script says.
function stubBrain(script) {
  const seen = [];
  return {
    seen,
    runAutoTrade: async (scan, { bridge, userId }) => {
      seen.push({ env: { ...process.env }, signals: (scan.signals || []).map((s) => s.symbol) });
      const out = { placed: [], positions: await bridge.getIBKRPositions(userId), orders: await bridge.getIBKROpenOrders(userId) };
      for (const step of script(scan, out)) out.placed.push(await bridge.placeIBKROrder(userId, step));
      return out;
    },
  };
}

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "two-sleeve-")), "ownership.json");

test("a buy on a symbol the other sleeve holds is refused, and counted as a collision", async () => {
  const facade = stubFacade();
  const S = stubBrain(() => [{ ticker: "SPY", side: "buy", qty: 10, type: "MKT" }]);
  const R = stubBrain(() => [{ ticker: "SPY", side: "buy", qty: 20, type: "MKT" }]);
  const rows = [];
  const eng = createEngine({ sleeves: [{ id: "S", brain: S, env: {}, userId: "u" }, { id: "R", brain: R, env: {}, userId: "u" }], order: ["S", "R"], facade, ownership: createOwnership({ file: tmpFile() }), journal: (r) => rows.push(r) });
  const res = await eng.tick({ signals: [] }, { userId: "u" });
  assert.equal(res.S.placed[0].status, "placed");
  assert.equal(res.R.placed[0].status, "error");
  assert.match(res.R.placed[0].reason, /owned by the other sleeve/);
  assert.equal(facade.st.pos.SPY.qty, 10, "the account holds S's 10 shares, never R's 20 on top");
  assert.equal(eng.stats.collisions, 1);
  assert.deepEqual(rows.filter((r) => r.event === "collision").map((r) => [r.symbol, r.loser, r.winner]), [["SPY", "R", "S"]]);
});

test("order decides who claims a shared washout: race-first gives race the name", async () => {
  const facade = stubFacade();
  const S = stubBrain(() => [{ ticker: "SPY", side: "buy", qty: 10, type: "MKT" }]);
  const R = stubBrain(() => [{ ticker: "SPY", side: "buy", qty: 20, type: "MKT" }]);
  const eng = createEngine({ sleeves: [{ id: "S", brain: S, env: {}, userId: "u" }, { id: "R", brain: R, env: {}, userId: "u" }], order: ["R", "S"], facade, ownership: createOwnership({ file: tmpFile() }) });
  const res = await eng.tick({ signals: [] }, { userId: "u" });
  assert.equal(res.R.placed[0].status, "placed");
  assert.equal(res.S.placed[0].status, "error");
  assert.equal(eng.ownership.ownerOf("SPY"), "R");
});

test("each sleeve sees only its own positions and orders; a sell or a stop on the other sleeve's name is refused", async () => {
  const facade = stubFacade();
  let phase = 0;
  const S = stubBrain(() => (phase === 0 ? [{ ticker: "QQQ", side: "buy", qty: 5, type: "MKT" }, { ticker: "QQQ", side: "sell", qty: 5, type: "STOP", stopPrice: 1 }] : []));
  const R = stubBrain(() => (phase === 0 ? [{ ticker: "IWM", side: "buy", qty: 7, type: "MKT" }] : [{ ticker: "QQQ", side: "sell", qty: 5, type: "MKT" }, { ticker: "QQQ", side: "sell", qty: 5, type: "STOP", stopPrice: 1 }]));
  const eng = createEngine({ sleeves: [{ id: "S", brain: S, env: {}, userId: "u" }, { id: "R", brain: R, env: {}, userId: "u" }], order: ["S", "R"], facade, ownership: createOwnership({ file: tmpFile() }) });
  await eng.tick({ signals: [] }, { userId: "u" });
  phase = 1;
  const res = await eng.tick({ signals: [] }, { userId: "u" });
  assert.deepEqual(res.S.positions.map((p) => p.symbol), ["QQQ"]);
  assert.deepEqual(res.R.positions.map((p) => p.symbol), ["IWM"]);
  assert.deepEqual(res.S.orders.map((o) => o.symbol), ["QQQ"], "S sees its own resting stop");
  assert.deepEqual(res.R.orders, [], "R does not see S's stop");
  assert.equal(res.R.placed[0].status, "error", "R may not sell S's QQQ");
  assert.equal(res.R.placed[1].status, "error", "R may not place a stop on S's QQQ");
  assert.equal(facade.st.pos.QQQ.qty, 5, "the position is intact");
});

test("env is applied per sleeve and never leaks: a key one sleeve omits is absent for it, and the baseline returns after the tick", async () => {
  process.env.TRADER_IBS_MAX = "0.99";              // process baseline for a scoped key
  delete process.env.TRADER_FRESHLOW_SIZE_MULT;
  const facade = stubFacade();
  const S = stubBrain(() => []);
  const R = stubBrain(() => []);
  const eng = createEngine({
    sleeves: [
      { id: "S", brain: S, env: { TRADER_IBS_MAX: "0.30", TRADER_MAX_CONCURRENT: "2" }, userId: "u" },
      { id: "R", brain: R, env: { TRADER_IBS_MAX: "0.15", TRADER_FRESHLOW_SIZE_MULT: "1.5" }, userId: "u" },
    ],
    order: ["S", "R"], facade, ownership: createOwnership({ file: tmpFile() }),
  });
  await eng.tick({ signals: [] }, { userId: "u" });
  assert.equal(S.seen[0].env.TRADER_IBS_MAX, "0.30");
  assert.equal(S.seen[0].env.TRADER_MAX_CONCURRENT, "2");
  assert.equal(S.seen[0].env.TRADER_FRESHLOW_SIZE_MULT, undefined, "R's graft knob must not reach S");
  assert.equal(R.seen[0].env.TRADER_IBS_MAX, "0.15");
  assert.equal(R.seen[0].env.TRADER_FRESHLOW_SIZE_MULT, "1.5");
  assert.equal(R.seen[0].env.TRADER_MAX_CONCURRENT, undefined, "S's cap must not reach R");
  assert.equal(process.env.TRADER_IBS_MAX, "0.99", "baseline restored after the tick");
  assert.equal(process.env.TRADER_FRESHLOW_SIZE_MULT, undefined);
  delete process.env.TRADER_IBS_MAX;
});

test("a non-scoped key in a sleeve map is rejected at construction", () => {
  assert.throws(() => createEngine({ sleeves: [{ id: "S", brain: stubBrain(() => []), env: { PORT: "1" } }], facade: stubFacade(), ownership: createOwnership({}) }), /not sleeve-scoped/);
});

test("each sleeve only sees the signals of its own universe", async () => {
  const facade = stubFacade();
  const S = stubBrain(() => []);
  const R = stubBrain(() => []);
  const eng = createEngine({ sleeves: [{ id: "S", brain: S, env: {}, userId: "u", universe: ["SPY", "TZA"] }, { id: "R", brain: R, env: {}, userId: "u", universe: ["SPY", "TNA"] }], order: ["S", "R"], facade, ownership: createOwnership({ file: tmpFile() }) });
  await eng.tick({ signals: [{ symbol: "SPY" }, { symbol: "TNA" }, { symbol: "TZA" }, { symbol: "UPRO" }] }, { userId: "u" });
  assert.deepEqual(S.seen[0].signals, ["SPY", "TZA"]);
  assert.deepEqual(R.seen[0].signals, ["SPY", "TNA"]);
});

test("ownership is released when a position leaves the book, adopted by the default sleeve when nobody claimed it, and survives a restart", async () => {
  const file = tmpFile();
  const facade = stubFacade();
  const S = stubBrain(() => [{ ticker: "SPY", side: "buy", qty: 10, type: "MKT" }]);
  const R = stubBrain(() => []);
  const rows = [];
  let eng = createEngine({ sleeves: [{ id: "S", brain: S, env: {}, userId: "u" }, { id: "R", brain: R, env: {}, userId: "u" }], order: ["S", "R"], facade, ownership: createOwnership({ file }), journal: (r) => rows.push(r) });
  await eng.tick({ signals: [] }, { userId: "u" });
  assert.equal(eng.ownership.ownerOf("SPY"), "S");
  // restart: a fresh registry from the same file remembers S
  const reg2 = createOwnership({ file });
  assert.equal(reg2.ownerOf("SPY"), "S");
  // a position appears that nobody claimed (manual buy, foreign engine) → adopted by S
  facade.st.pos.GLD = { qty: 3 };
  // SPY leaves the book (stop filled at the broker) → released
  delete facade.st.pos.SPY;
  const S2 = stubBrain(() => []);
  eng = createEngine({ sleeves: [{ id: "S", brain: S2, env: {}, userId: "u" }, { id: "R", brain: R, env: {}, userId: "u" }], order: ["S", "R"], facade, ownership: reg2, journal: (r) => rows.push(r) });
  await eng.tick({ signals: [] }, { userId: "u" });
  assert.equal(reg2.ownerOf("SPY"), null);
  assert.equal(reg2.ownerOf("GLD"), "S");
  assert.ok(rows.some((r) => r.event === "ownership_adopted" && r.symbols.includes("GLD")));
  assert.ok(rows.some((r) => r.event === "ownership_released" && r.symbols.includes("SPY")));
});

test("a filled stop stays visible to the sleeve that placed it after the position leaves the book; the tag goes only when the broker stops listing the order", async () => {
  // Found by the engine validation of 2026-09-18: releasing a symbol used to drop its order
  // tags, so R's filled stop fell to the default sleeve and R read its own stop-out as an
  // external close — one SOXL trade then hit a stale max-hold clock and sold 10 minutes in.
  const facade = stubFacade();
  let phase = 0;
  const S = stubBrain(() => []);
  const R = stubBrain(() => (phase === 0 ? [{ ticker: "SOXL", side: "buy", qty: 9, type: "MKT" }, { ticker: "SOXL", side: "sell", qty: 9, type: "STOP", stopPrice: 1 }] : []));
  const eng = createEngine({ sleeves: [{ id: "S", brain: S, env: {}, userId: "u" }, { id: "R", brain: R, env: {}, userId: "u" }], order: ["S", "R"], facade, ownership: createOwnership({ file: tmpFile() }) });
  await eng.tick({ signals: [] }, { userId: "u" });
  phase = 1;
  // one tick with the position on the book: a fresh claim is released only once the position
  // has been SEEN held (2026-09-23: a positions read lagging the fill orphaned S's UPRO to R)
  await eng.tick({ signals: [] }, { userId: "u" });
  assert.equal(eng.ownership.ownerOf("SOXL"), "R");
  // the stop fills at the broker: the position is gone, the order is still listed as filled
  delete facade.st.pos.SOXL;
  facade.st.orders[0].status = "Filled";
  let res = await eng.tick({ signals: [] }, { userId: "u" });
  assert.equal(eng.ownership.ownerOf("SOXL"), null, "the symbol was released");
  assert.deepEqual(res.R.orders.map((o) => [o.symbol, o.status]), [["SOXL", "Filled"]], "R still sees its own filled stop");
  assert.deepEqual(res.S.orders, [], "S never sees R's fill");
  // the broker stops listing it → the tag is pruned, nothing leaks to the default sleeve
  facade.st.orders = [];
  res = await eng.tick({ signals: [] }, { userId: "u" });
  assert.deepEqual(res.R.orders, []);
  assert.deepEqual(res.S.orders, []);
  assert.deepEqual(Object.keys(eng.ownership.snapshot().orders), [], "stale tags pruned");
});

test("a brain that throws does not stop the other sleeve, and the env is still restored", async () => {
  process.env.TRADER_IBS_MAX = "0.42";
  const facade = stubFacade();
  const S = { runAutoTrade: async () => { throw new Error("boom"); } };
  const R = stubBrain(() => [{ ticker: "TNA", side: "buy", qty: 1, type: "MKT" }]);
  const rows = [];
  const eng = createEngine({ sleeves: [{ id: "S", brain: S, env: { TRADER_IBS_MAX: "0.30" }, userId: "u" }, { id: "R", brain: R, env: { TRADER_IBS_MAX: "0.15" }, userId: "u" }], order: ["S", "R"], facade, ownership: createOwnership({ file: tmpFile() }), journal: (r) => rows.push(r) });
  const res = await eng.tick({ signals: [] }, { userId: "u" });
  assert.match(res.S.error, /boom/);
  assert.equal(res.R.placed[0].status, "placed");
  assert.ok(rows.some((r) => r.event === "sleeve_error" && r.owner === "S"));
  assert.equal(process.env.TRADER_IBS_MAX, "0.42");
  delete process.env.TRADER_IBS_MAX;
});
