"use strict";
/**
 * external-close-ledger.test.js — a position closed at the BROKER must land in the
 * ledger, because that is how losses leave the book.
 *
 * The autopilot appended an exit row only when it DECIDED to exit. Profit-taking
 * exits are decisions, so wins were logged. A stop-out is not a decision — the
 * resting protective stop fills at the broker and the position simply vanishes — so
 * losses were dropped on the floor. The scorecard then honestly summarized a
 * wins-only ledger as a 100% win rate.
 *
 * This drives the real runAutoTrade against a stub broker: state says we held NVDA,
 * broker truth says we no longer do, and no exit of ours was confirmed.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-close-"));
const LOG = path.join(dir, "trades.jsonl");
const STATE = path.join(dir, "state.json");

// Seed the pre-restart snapshot: we last saw 100 NVDA, entered 180, marked 170.
fs.writeFileSync(STATE, JSON.stringify({
  lastPos: { NVDA: { qty: 100, entry: 180, mark: 170, ts: Date.now() } },
}));

process.env.TRADER_TRADES_LOG = LOG;
process.env.TRADER_STATE_FILE = STATE;
process.env.TRADER_MANAGE_EXITS = "1";   // exits-only; no entries needed
delete process.env.TRADER_AUTO_EXECUTE;

const { runAutoTrade } = require("../lib/auto-trader");

// Broker truth: the account is alive, and NVDA is GONE (its stop filled).
const bridge = {
  getIBKRAccount: async () => ({ equity: 100000, mode: "paper" }),
  getIBKRPositions: async () => [],
  getIBKROpenOrders: async () => [],
};

function rows() {
  if (!fs.existsSync(LOG)) return [];
  return fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("a position that vanished from the book is logged as a loss", async () => {
  await runAutoTrade({ signals: [] }, { bridge, userId: "t" });

  const exits = rows().filter((r) => r.event === "exit");
  assert.strictEqual(exits.length, 1, "the vanished position must produce exactly one exit row");
  const e = exits[0];
  assert.strictEqual(e.symbol, "NVDA");
  assert.strictEqual(e.pnl, -1000, "(170 - 180) * 100 — a real loss, landed");
  assert.match(e.reason, /closed_externally/);
  assert.strictEqual(e.status, "reconstructed");
  assert.strictEqual(e.estimated, true, "priced off the last mark, not a fill — say so");
});

test("it does not re-log on the next scan", async () => {
  await runAutoTrade({ signals: [] }, { bridge, userId: "t" });
  const exits = rows().filter((r) => r.event === "exit");
  assert.strictEqual(exits.length, 1, "44 duplicate rows for one position is the bug we just fixed");
});

test("the scorecard now shows the loss instead of a perfect record", () => {
  const { scorecard } = require("../lib/trader-scorecard");
  const s = scorecard(LOG);
  assert.strictEqual(s.all.losses, 1);
  assert.strictEqual(s.all.winRate, 0);
  assert.strictEqual(s.all.totalRealized, -1000);
  // Reconstructed rows are NOT broker-confirmed fills, so they stay out of `confirmed`.
  assert.strictEqual(s.confirmed.trades, 0, "an estimate must never be passed off as booked cash");
});
