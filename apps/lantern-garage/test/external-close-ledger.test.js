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

// Seed the pre-restart snapshot: we last saw 100 NVDA, entered 180, marked 170,
// alongside an ANCHOR position the broker still reports.
//
// The anchor is required, not decorative. Since #3277 the sweep DEFERS when the
// position snapshot looks unreadable — an empty book while we believe we hold
// something is a feed dropout, not a simultaneous close of everything. That
// guard exists because on 2026-08-13 a single empty snapshot invented four
// exits and inflated the day's ledger to +$7,305 against equity that had FALLEN
// $4,634. With a broker returning [] these tests were asserting on a path that
// can no longer run, and had been failing since that fix landed.
fs.writeFileSync(STATE, JSON.stringify({
  lastPos: {
    NVDA: { qty: 100, entry: 180, mark: 170, ts: Date.now() },
    ANCH: { qty: 10, entry: 50, mark: 50, ts: Date.now() },
  },
}));

process.env.TRADER_TRADES_LOG = LOG;
process.env.TRADER_STATE_FILE = STATE;
process.env.TRADER_MANAGE_EXITS = "1";   // exits-only; no entries needed
delete process.env.TRADER_AUTO_EXECUTE;

const { runAutoTrade } = require("../lib/auto-trader");

// Broker truth: the account is alive, the rest of the book is READABLE, and
// NVDA is GONE (its stop filled). A visible remainder is what makes NVDA's
// absence evidence of a close rather than of a dropout.
const ANCHOR = { symbol: "ANCH", qty: 10, avg_entry_price: 50, current_price: 50, market_value: 500, unrealized_pl: 0 };
const bridge = {
  getIBKRAccount: async () => ({ equity: 100000, mode: "paper" }),
  getIBKRPositions: async () => [{ ...ANCHOR }],
  getIBKROpenOrders: async () => [],
};

/** Read the JSONL rows a run appended (empty when nothing was written). */
function readRows(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

test("a position that vanished from the book is logged as a loss", async () => {
  // TWO scans since #3378: one absence is a data point, not a close — a single
  // flapped read booked three still-held positions as exits on 2026-08-19. The
  // first scan records the absence and defers; the second consecutive absence
  // books the reconstructed exit.
  await runAutoTrade({ signals: [] }, { bridge, userId: "t" });
  assert.strictEqual(readRows(LOG).filter((r) => r.event === "exit").length, 0,
    "one absent read must not book anything (#3378)");
  await runAutoTrade({ signals: [] }, { bridge, userId: "t" });

  const exits = readRows(LOG).filter((r) => r.event === "exit");
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
  const exits = readRows(LOG).filter((r) => r.event === "exit");
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

test("an unconfirmed exit of our own is NOT reconstructed on top of", async () => {
  // A signal_exit logged as needs_confirmation is already a ledger row. Guarding only
  // on CONFIRMED statuses reconstructed a SECOND row for the same SHOP position —
  // one close, two rows, both counted. Seen live on 2026-07-31.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "ext-close-dup-"));
  const LOG2 = path.join(dir2, "trades.jsonl");
  const STATE2 = path.join(dir2, "state.json");
  fs.writeFileSync(STATE2, JSON.stringify({
    lastPos: {
      SHOP: { qty: 100, entry: 125, mark: 124, ts: Date.now() },
      ANCH: { qty: 10, entry: 50, mark: 50, ts: Date.now() },
    },
    exitStatus: { SHOP: "needs_confirmation" },
  }));
  process.env.TRADER_TRADES_LOG = LOG2;
  process.env.TRADER_STATE_FILE = STATE2;
  delete require.cache[require.resolve("../lib/auto-trader")];
  const { runAutoTrade: run2 } = require("../lib/auto-trader");

  await run2({ signals: [] }, { bridge, userId: "t" });
  await run2({ signals: [] }, { bridge, userId: "t" });   // #3378: a second absent scan must not convert it either
  const recon = readRows(LOG2).filter((r) => r.status === "reconstructed");
  assert.strictEqual(recon.length, 0, "we already logged this exit — do not add a second row");
});
