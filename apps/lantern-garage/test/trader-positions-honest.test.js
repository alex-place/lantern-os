// #2725 — trader_positions must report an HONEST "not connected / unavailable"
// message instead of a raw "endpoint returned an error", across every shape the
// /api/trading/positions route actually produces when no broker is linked.
//
// Run: node apps/lantern-garage/test/trader-positions-honest.test.js
const assert = require("assert");
const http = require("http");

let failures = 0;
async function check(name, fn) {
  try { await fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

// Serve one canned JSON body (at a given status) on loopback, point the tool's
// loopback hop at it, run trader_positions, and return the tool result string.
async function runWith(body, status = 200) {
  const srv = http.createServer((_req, res) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const prevPort = process.env.LANTERN_GARAGE_PORT;
  process.env.LANTERN_GARAGE_PORT = String(srv.address().port);
  try {
    const { runTool } = require("../lib/tool-runner");
    const r = await runTool("trader_positions", {}, { operator: true });
    return r;
  } finally {
    if (prevPort === undefined) delete process.env.LANTERN_GARAGE_PORT;
    else process.env.LANTERN_GARAGE_PORT = prevPort;
    srv.close();
  }
}

(async () => {
  // Explicit not-connected signal from the route (#2725 route change).
  await check("available:false → honest 'not connected'", async () => {
    const r = await runWith({ available: false, reason: "no trading backend configured", positions: [], account: {} }, 503);
    assert.ok(r.ok, "tool should not hard-fail");
    assert.match(r.result, /not connected/i);
    assert.match(r.result, /no trading backend configured/);
    assert.doesNotMatch(r.result, /\$0/); // never a fake $0 account
  });

  // Legacy/edge shape: empty account, no available flag, at a 500 — must NOT be
  // read as a real $0 account, and must NOT surface a raw "endpoint error".
  await check("empty {account:{}} → honest 'not connected' (not $0)", async () => {
    const r = await runWith({ positions: [], account: {} }, 500);
    assert.ok(r.ok);
    assert.match(r.result, /not connected/i);
    assert.doesNotMatch(r.result, /equity \$0/);
    assert.doesNotMatch(r.result, /endpoint returned an error/i);
  });

  // Connected with real account + holdings → normal positions report.
  await check("connected account+positions → normal report", async () => {
    const r = await runWith({
      account: { equity: 10000, cash: 5000, buying_power: 5000, pnl_today: 12.5 },
      positions: [{ symbol: "AAPL", qty: 3, avg_entry_price: 190, unrealized_pl: 15 }],
    }, 200);
    assert.ok(r.ok);
    assert.match(r.result, /equity \$10000/);
    assert.match(r.result, /AAPL/);
    assert.doesNotMatch(r.result, /not connected/i);
  });

  // Connected, real account, but flat (no holdings) → "none", still connected.
  await check("connected but no positions → 'none' (still connected)", async () => {
    const r = await runWith({ account: { equity: 8000, cash: 8000, buying_power: 8000 }, positions: [] }, 200);
    assert.ok(r.ok);
    assert.match(r.result, /Open positions: none/i);
    assert.doesNotMatch(r.result, /not connected/i);
  });

  // Transient reach failure (bad JSON body) → honest 'unavailable', not a bare error.
  await check("bad JSON body → honest 'unavailable'", async () => {
    const r = await runWith("<html>502 Bad Gateway</html>", 502);
    assert.ok(r.ok);
    assert.match(r.result, /unavailable/i);
    assert.doesNotMatch(r.result, /\btrader_positions error\b/);
  });

  process.stdout.write(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})();
