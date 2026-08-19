"use strict";
/**
 * ibkr-benign-warning.test.js — only the account-level advisory notice is
 * auto-confirmed; every risk-bearing warning still stops the order.
 *
 * On 2026-07-31 the autopilot placed 409 orders and filled ONE. IBKR's own preview
 * (/orders/whatif) named the cause with error:null and a single warning:
 *
 *   "20/You are trying to submit an order without having market data for this
 *    instrument. IB strongly recommends against this kind of blind trading..."
 *
 * That notice is about the ACCOUNT's market-data subscription, not the order's risk,
 * so it fires on every order forever and parks each one as "Order Not Submitted".
 * P0-8 exists to stop us clicking through margin / size / price warnings — so the
 * fix confirms ONLY id 20 and leaves the rest exactly as they were.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const { isBenignWarning, BENIGN_WARNING_IDS } = require("../lib/ibkr-cpapi");

const NO_MARKET_DATA =
  "20/You are trying to submit an order without having market data for this instrument. \n" +
  "IB strongly recommends against this kind of blind trading which may result in \n" +
  "erroneous or unexpected trades.";

test("the exact IBKR text that blocked 408 orders is recognized as benign", () => {
  assert.strictEqual(isBenignWarning([NO_MARKET_DATA]), true);
  assert.strictEqual(isBenignWarning(NO_MARKET_DATA), true, "bare string form too");
});

test("risk-bearing warnings are NOT auto-confirmed", () => {
  // The four P0-8 named: margin, size-vs-ADV, price-cap, outside-RTH.
  for (const m of [
    "o163/The following order size exceeds the Size Limit of 500",
    "o354/You are trying to submit an order without market data. Margin required...",
    "10082/The following value exceeds the price percentage limit",
    "o451/This order will be placed outside of regular trading hours",
    "2109/Called order price is outside of the daily price range",
  ]) {
    assert.strictEqual(isBenignWarning([m]), false, `must NOT auto-confirm: ${m.slice(0, 40)}`);
  }
});

test("a batch is benign only if EVERY message is benign", () => {
  assert.strictEqual(
    isBenignWarning([NO_MARKET_DATA, "o163/The following order size exceeds the Size Limit"]),
    false,
    "one risky warning in the batch must block the whole order",
  );
  assert.strictEqual(isBenignWarning([NO_MARKET_DATA, NO_MARKET_DATA]), true);
});

test("unparseable or empty messages are never treated as benign", () => {
  assert.strictEqual(isBenignWarning([]), false);
  assert.strictEqual(isBenignWarning([""]), false);
  assert.strictEqual(isBenignWarning(["no leading id here"]), false);
  assert.strictEqual(isBenignWarning([null]), false);
  assert.strictEqual(isBenignWarning(["201/looks similar but is not id 20"]), false);
});

test("the benign set stays deliberately tiny", () => {
  assert.deepStrictEqual([...BENIGN_WARNING_IDS], ["20"],
    "adding an id here lets the autopilot click through that warning unattended — keep it justified");
});
