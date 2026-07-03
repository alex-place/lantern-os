"use strict";
const { test } = require("node:test");
const assert = require("node:assert");

const TraderAgent = require("../lib/trader-agent");

// Build an agent with a mocked IBKR client so we test the account P&L assembly only.
function agentWith(ibkr) {
  const a = new TraderAgent();
  a.ibkr = Object.assign(
    {
      getStatus: async () => ({ connected: true, mode: "paper", evidence: [] }),
      getAccountSummary: async () => ({ equity: 100000, cash: 90000, buyingPower: 180000, unrealizedPnl: 0 }),
      getPositions: async () => [],
      getPnl: async () => null,
    },
    ibkr,
  );
  return a;
}

test("Day P&L comes from IBKR dpl and the panel reconciles (R + U = Day)", async () => {
  const a = agentWith({
    getAccountSummary: async () => ({ equity: 99800, cash: 90000, buyingPower: 180000, unrealizedPnl: -30 }),
    getPnl: async () => ({ dailyPnl: -200, unrealizedPnl: -30, realizedPnl: null }),
  });
  const { account } = await a.getPositions();
  assert.equal(account.pnl_today, -200);        // broker dpl
  assert.equal(account.unrealized, -30);        // broker upl
  assert.equal(account.realized_today, -170);   // dpl - upl
  assert.equal(account.realized_today + account.unrealized, account.pnl_today); // reconciles
  assert.equal(account.day_pnl_pct, -0.2);      // -200/99800*100 rounded
});

test("falls back to summary unrealized when the pnl endpoint is unavailable", async () => {
  const a = agentWith({
    getAccountSummary: async () => ({ equity: 100000, cash: 90000, buyingPower: 180000, unrealizedPnl: 42 }),
    getPnl: async () => null,
  });
  const { account } = await a.getPositions();
  assert.equal(account.unrealized, 42);         // from summary
  assert.equal(account.pnl_today, null);        // no day P&L without the endpoint (honest)
  assert.equal(account.realized_today, null);
});

test("not-connected returns an honest unavailable account (no fake zeros as P&L)", async () => {
  const a = agentWith({ getStatus: async () => ({ connected: false, evidence: ["gateway down"] }) });
  const res = await a.getPositions();
  assert.equal(res.available, false);
  assert.equal(res.account.equity, 0);
});
