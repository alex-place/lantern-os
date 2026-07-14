// Offline test of the live-order hardening in kalshi-api.placeOrder:
//  - `source` (a client label) is validated against the actual ticker, so a
//    mislabeled order can't borrow the weather-edge live allowance;
//  - a live fill requires an explicit confirmLive:true.
// KALSHI_TRADING_ENABLED is unset here, so every path resolves to dry-run and no
// live request is ever made. Run: node apps/lantern-garage/test/kalshi-order-hardening.test.js
"use strict";
const assert = require("assert");
delete process.env.KALSHI_TRADING_ENABLED;   // force dry-run
const kalshi = require("../lib/kalshi-api");

let failures = 0;
function check(n, fn) { try { fn(); console.log("  ok  -", n); } catch (e) { failures++; console.error("  FAIL-", n, "\n      ", e.message); } }

(async () => {
  const wx = await kalshi.placeOrder({ ticker: "KXHIGHNY-26JUL03-B100.5", side: "no", action: "buy", count: 1, limitCents: 80, source: "kalshi-weather-edge", confirmLive: true });
  check("legit weather order → dry-run, no mismatch/confirm blocker", () => {
    assert.strictEqual(wx.mode, "dry_run");   // trading disabled in test env
    assert.ok(!wx.wouldBlock.some(b => b.startsWith("source_ticker_mismatch")));
    assert.ok(!wx.wouldBlock.some(b => b.startsWith("live_confirm_required")));
  });

  const spoof = await kalshi.placeOrder({ ticker: "KXETHD-CRYPTO", side: "yes", action: "buy", count: 1, limitCents: 50, source: "kalshi-weather-edge", confirmLive: true });
  check("mislabeled ticker (crypto claiming weather-edge) → source_ticker_mismatch", () => {
    assert.strictEqual(spoof.mode, "dry_run");
    assert.ok(spoof.wouldBlock.some(b => b.startsWith("source_ticker_mismatch")), JSON.stringify(spoof.wouldBlock));
  });

  const noConfirm = await kalshi.placeOrder({ ticker: "KXHIGHNY-26JUL03-B100.5", side: "no", action: "buy", count: 1, limitCents: 80, source: "kalshi-weather-edge" });
  check("no confirmLive → live_confirm_required blocker", () => {
    assert.strictEqual(noConfirm.mode, "dry_run");
    assert.ok(noConfirm.wouldBlock.some(b => b.startsWith("live_confirm_required")), JSON.stringify(noConfirm.wouldBlock));
  });

  // P0-1 prove-or-pause: KALSHI_LIVE_EDGE_PROVEN is unset in this test env, so EVERY order —
  // even a legit weather order — carries the edge_unproven blocker (fail-closed default).
  check("edge_unproven blocker present on a legit weather order (fail-closed default)", () => {
    assert.ok(wx.wouldBlock.some(b => b.startsWith("edge_unproven")), JSON.stringify(wx.wouldBlock));
  });

  console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ order-hardening passed");
  process.exit(failures ? 1 : 0);
})();
