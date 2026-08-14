// Per-user ledger attribution (#3275) — the WRITE side.
//
// The autopilot drives every connected account from one process, sequentially.
// Before this, a ledger row said WHAT was traded and never FOR WHOM, so one
// user's journal could only ever be answered with everyone's. This locks the
// guarantee that each row carries the account it was traded for, and that the
// acting-account scalar never leaks across accounts or survives a throw.
//
// Run: node apps/lantern-garage/test/ledger-attribution.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-attr-"));
process.env.TRADER_TRADES_LOG = path.join(TMP, "trades.jsonl");
process.env.TRADER_STATE_FILE = path.join(TMP, "state.json");
process.env.TRADER_AUTO_EXECUTE = "1";
delete process.env.TRADER_MANAGE_EXITS;

const at = require("../lib/auto-trader");
const { readExits, readEvents, HOUSE_USER } = require("../lib/trader-scorecard");

const bridge = {
  getIBKRAccount: async () => ({ equity: 100000, mode: "paper" }),
  getIBKRPositions: async () => [],
  getIBKROpenOrders: async () => [],
  getIBKRDayPnl: async () => 0,
  placeIBKROrder: async () => ({ status: "placed", orderId: "x1" }),
};
const signal = (symbol) => ({ symbol, direction: "BULLISH", entry_price: 500, convergence: { decision: "ENTER", p_win: 0.8 } });
const rows = () => fs.readFileSync(process.env.TRADER_TRADES_LOG, "utf8")
  .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

let failures = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(
  () => process.stdout.write("  ok  - " + name + "\n"),
  (e) => { failures++; process.stderr.write("  FAIL- " + name + "\n      " + e.message + "\n"); }
);

(async () => {
  await check("every row written by the engine carries the account it traded for", async () => {
    await at.runAutoTrade({ signals: [signal("QQQ")] }, { bridge, userId: "alice" });
    await at.runAutoTrade({ signals: [signal("SPY")] }, { bridge, userId: "bob" });
    const all = rows();
    assert.ok(all.length >= 2, "the engine wrote rows to judge");
    const unstamped = all.filter((r) => !r.user);
    assert.deepStrictEqual(unstamped, [], `${unstamped.length} row(s) written with no account`);
  });

  await check("accounts do not bleed into each other across sequential passes", () => {
    const all = rows();
    const alice = all.filter((r) => r.user === "alice").map((r) => r.symbol).filter(Boolean);
    const bob = all.filter((r) => r.user === "bob").map((r) => r.symbol).filter(Boolean);
    assert.ok(alice.includes("QQQ") && !alice.includes("SPY"), "alice's rows are only alice's symbols");
    assert.ok(bob.includes("SPY") && !bob.includes("QQQ"), "bob's rows are only bob's symbols");
  });

  await check("the acting account is restored even when a pass throws", async () => {
    const exploding = { ...bridge, getIBKRPositions: async () => { throw new Error("broker down"); } };
    await at.runAutoTrade({ signals: [signal("IWM")] }, { bridge: exploding, userId: "charlie" }).catch(() => {});
    // A later pass must NOT inherit charlie — that is the leak this guards.
    await at.runAutoTrade({ signals: [signal("DIA")] }, { bridge, userId: "dana" });
    const leaked = rows().filter((r) => r.symbol === "DIA" && r.user !== "dana");
    assert.deepStrictEqual(leaked, [], "a throwing pass must not leave its account set for the next one");
  });

  await check("readers filter by account, and legacy un-stamped rows read as the house book", () => {
    fs.appendFileSync(process.env.TRADER_TRADES_LOG,
      JSON.stringify({ ts: "2026-01-01T15:00:00.000Z", event: "exit", symbol: "OLD", qty: 1, entry: 10, pnl: 5, reason: "stop", status: "filled" }) + "\n");
    const house = readExits(process.env.TRADER_TRADES_LOG, HOUSE_USER);
    assert.strictEqual(house.length, 1, "the pre-attribution row belongs to the house book");
    assert.strictEqual(house[0].symbol, "OLD");
    assert.strictEqual(readExits(process.env.TRADER_TRADES_LOG, "alice").length, 0, "alice owns no exits here");
    assert.ok(readEvents("skip", process.env.TRADER_TRADES_LOG, "alice").length >= 1, "…but she does own skips");
    assert.strictEqual(readEvents("skip", process.env.TRADER_TRADES_LOG, "nobody").length, 0, "an unknown account owns nothing");
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})();
