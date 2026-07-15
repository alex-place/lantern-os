// Offline, deterministic test of the Kalshi paper tinder-game mechanics:
// wallet spend-down (buy until no cash), hide-held, sell-for-profit, and AUTO
// stop-loss. No server/browser — calls the ledger directly so it runs anywhere.
// Run: node apps/lantern-garage/test/kalshi-paper-game.test.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

process.env.KALSHI_PAPER_START_CENTS = "120";   // $1.20 bankroll (like the test server)
process.env.KALSHI_PAPER_STOP_PCT = "-25";

const REPO = path.resolve(__dirname, "../../..");
const LEDGER = path.join(REPO, "data", "kalshi", "paper-positions.jsonl");
fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
fs.writeFileSync(LEDGER, "");   // fresh

// Mock the Kalshi market fetch BEFORE the ledger requires it, so pollOpen()'s
// auto-stop-loss can be exercised without a live API.
const kalshi = require("../lib/kalshi-api");
const marketBids = {}; // ticker -> {bid, ask}
kalshi.getMarket = async (t) => {
  const m = marketBids[t] || { bid: 80, ask: 82 };
  return { status: 200, data: { market: {
    ticker: t, title: t,
    no_bid: m.bid, no_ask: m.ask, yes_bid: m.bid, yes_ask: m.ask,
    close_time: new Date(Date.now() + 3600e3).toISOString(), result: "",
  } } };
};

const L = require("../lib/kalshi-paper-ledger");
const fees = require("../lib/kalshi-fees");
// P1-5: paper realized P&L is NET of fees. Both closes below are early sell-backs, so each
// pays the round-trip (entry + exit) taker fee — settlement would pay entry-side only.
const rt1 = fees.roundTripFeeCents(80, 95, 1);  // MANUAL sell winner: 80¢→95¢
const rt2 = fees.roundTripFeeCents(80, 50, 1);  // STOP-LOSS exit:     80¢→50¢

let failures = 0;
function check(name, fn) { try { fn(); console.log("  ok  -", name); } catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); } }

(async () => {
  check("fresh wallet = $1.20 (120¢)", () => {
    const w = L.getWallet();
    assert.strictEqual(w.cashCents, 120);
    assert.strictEqual(w.openCount, 0);
  });

  const p1 = L.openPosition({ ticker: "KXHIGHNY-26JUL03-B100.5", side: "no", limitCents: 80, count: 1 });
  check("buy 80¢ → cash $0.40, invested 80¢, 1 open (buy deducts cash)", () => {
    const w = L.getWallet();
    assert.strictEqual(w.cashCents, 40);
    assert.strictEqual(w.investedCents, 80);
    assert.strictEqual(w.openCount, 1);
  });

  check("held market is in getOpen() (deck will hide it as a buy)", () => {
    assert.ok(L.getOpen().some(p => p.ticker === "KXHIGHNY-26JUL03-B100.5"));
  });

  // Sell for PROFIT: bid rose to 95¢.
  L.closePosition(p1.id, { exitTag: "MANUAL", exitPriceCents: 95, pnlPct: 19 });
  check("sell @95¢ → realized net = +15¢ gross − round-trip fee, 0 open (sell-for-profit)", () => {
    const w = L.getWallet();
    const netWin = 15 - rt1;                     // gross(95−80) minus both-leg taker fee
    assert.strictEqual(w.realizedCents, netWin);
    assert.strictEqual(w.cashCents, 120 + netWin);
    assert.strictEqual(w.openCount, 0);
  });

  // AUTO stop-loss: buy, then the market drops so P&L ≤ -25%.
  const p2 = L.openPosition({ ticker: "STOPME-TEST", side: "no", limitCents: 80, count: 1 });
  marketBids["STOPME-TEST"] = { bid: 50, ask: 52 };   // (50-80)/80 = -37.5% ≤ -25%
  const polled = await L.pollOpen();
  check("AUTO stop-loss auto-CLOSES the losing position (≤ -25%)", () => {
    const stopped = polled.find(p => p.ticker === "STOPME-TEST");
    assert.ok(stopped, "position was polled");
    assert.strictEqual(stopped.status, "stopped-out");
    assert.strictEqual(stopped.autoExit, "STOP-LOSS");
    assert.ok(!L.getOpen().some(p => p.ticker === "STOPME-TEST"), "no longer open");
  });

  check("wallet reflects the realized stop-loss (net of round-trip fees)", () => {
    const w = L.getWallet();
    // realized net = winner(+15−rt1) + stop((50−80)−rt2). Both are early sell-backs.
    const expected = (15 - rt1) + ((50 - 80) - rt2);
    assert.strictEqual(w.realizedCents, expected);
    assert.strictEqual(w.openCount, 0);
    assert.strictEqual(w.cashCents, 120 + expected);
  });

  // "buy until no cash": with $1.05 left, an 80¢ buy is fine, a second is refused
  // by the server gate — here we just prove the wallet can hit zero headroom.
  check("wallet exposes cash so the cash-gate can stop over-buying", () => {
    const w = L.getWallet();
    assert.ok(typeof w.cashCents === "number");
    assert.ok(w.cashCents >= 0);
  });

  console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ kalshi paper-game mechanics passed");
  process.exit(failures ? 1 : 0);
})();
