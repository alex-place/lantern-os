"use strict";
/**
 * entry-blocked-narration.test.js — a blocked entry must say why, and must back off.
 *
 * Entries deliberately don't pass acceptWarnings (P0-8), so an IBKR warning returns
 * `needs_confirmation` with the order already parked at the broker as `inactive`.
 * On 2026-07-31 that produced 408 parked orders across 7 symbols and ONE fill, with
 * nothing in the ledger or the console saying which warning fired — because the
 * reason was only logged when the order placed, and the re-entry cooldown was only
 * armed when the order placed, so every symbol re-fired every 60-second scan.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entry-blocked-"));
const LOG = path.join(dir, "trades.jsonl");
process.env.TRADER_TRADES_LOG = LOG;
process.env.TRADER_STATE_FILE = path.join(dir, "state.json");
process.env.TRADER_AUTO_EXECUTE = "1";
process.env.TRADER_REQUIRE_PERSIST = "0";     // don't require consecutive scans
process.env.TRADER_ENTRY_KNIFE_FILTER = "0";  // no yahoo bars needed
delete process.env.TRADER_MANAGE_EXITS;

const at = require("../lib/auto-trader");

const WARNING = "IBKR: order size exceeds 3% of average daily volume";
const placed = [];
const bridge = {
  getIBKRAccount: async () => ({ equity: 100000, mode: "paper" }),
  getIBKRPositions: async () => [],
  getIBKROpenOrders: async () => [],
  getIBKRDayPnl: async () => 0,
  placeIBKROrder: async (_uid, o) => {
    placed.push(o);
    // Exactly what the bridge returns for a warned BUY: parked, not filled.
    return { status: "needs_confirmation", reason: WARNING };
  },
};

const signal = {
  symbol: "QQQ", direction: "BULLISH", entry_price: 500,
  convergence: { decision: "ENTER", p_win: 0.8 },
};

function rows() {
  if (!fs.existsSync(LOG)) return [];
  return fs.readFileSync(LOG, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

test("a blocked entry logs WHY, with IBKR's own warning text", async () => {
  at._resetCooldowns();
  await at.runAutoTrade({ signals: [signal] }, { bridge, userId: "u", now: 1_700_000_000_000 });

  const blocked = rows().filter((r) => r.event === "entry_blocked");
  assert.strictEqual(blocked.length, 1, "the blocked entry must be narrated");
  assert.strictEqual(blocked[0].symbol, "QQQ");
  assert.strictEqual(blocked[0].status, "needs_confirmation");
  assert.match(blocked[0].reason, /average daily volume/, "IBKR's warning text must survive to the ledger");
});

test("a blocked entry arms the cooldown — it does not re-fire every scan", async () => {
  const before = placed.length;
  // Next scan, one minute later — the 45-min cooldown must suppress the retry.
  await at.runAutoTrade({ signals: [signal] }, { bridge, userId: "u", now: 1_700_000_060_000 });
  assert.strictEqual(placed.length, before, "same symbol must not re-submit while cooling down");

  // 408 orders from 7 symbols in one session is what the missing cooldown produced.
  let n = 0;
  for (let i = 2; i < 20; i++) {
    await at.runAutoTrade({ signals: [signal] }, { bridge, userId: "u", now: 1_700_000_000_000 + i * 60_000 });
    n += 1;
  }
  assert.strictEqual(placed.length, before, `${n} further scans must not stack ${n} more parked orders`);
});

test("entry_blocked rows never pollute the scorecard", () => {
  // They are not exits and realized nothing — readExits takes only event === 'exit'.
  const { scorecard } = require("../lib/trader-scorecard");
  const s = scorecard(LOG);
  assert.strictEqual(s.all.trades, 0, "a blocked entry is not a trade");
  assert.strictEqual(s.all.totalRealized, 0);
});
