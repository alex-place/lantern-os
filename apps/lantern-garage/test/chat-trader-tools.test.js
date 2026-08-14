// Chat's view of its own trading desk (#3273) — config, record, skips, alerts,
// plus the three non-financial capabilities.
//
// The contract this locks:
//   1. the MONEY BOUNDARY — no chat tool places, sizes, or ARMS an order;
//   2. `trader_pause` is ONE-WAY — chat can stop the autopilot, never start it;
//   3. the read tools carry their honesty furniture (risk-exit win rate, the
//      structural-exit flag, the disclosures line, counts-only on skips);
//   4. rule validation refuses junk, and guests are denied outright.
//
// Every store is redirected to a temp dir BEFORE require, so the real operator
// data is never touched.
//
// Run: node apps/lantern-garage/test/chat-trader-tools.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "chat-trader-tools-"));
process.env.ALERTS_DIR = path.join(TMP, "alerts");
process.env.TRADER_MODE_DIR = path.join(TMP, "mode");
process.env.TRADER_TRADES_LOG = path.join(TMP, "trades.jsonl");

// A tiny confirmed-fill ledger: +100 then -40, one structural profit-taking exit,
// one broker-rejected attempt (must be excluded AND disclosed), plus two skips
// whose digits differ so they must normalize into ONE reason family.
fs.writeFileSync(process.env.TRADER_TRADES_LOG, [
  { ts: "2026-08-10T14:30:00.000Z", event: "exit", symbol: "SPY", qty: 5, entry: 100, pnl: 100, reason: "zone_r1", status: "filled" },
  { ts: "2026-08-11T14:30:00.000Z", event: "exit", symbol: "QQQ", qty: 5, entry: 200, pnl: -40, reason: "stop", status: "placed" },
  { ts: "2026-08-11T15:30:00.000Z", event: "exit", symbol: "IWM", qty: 5, entry: 50, pnl: 25, reason: "take_profit_R", status: "filled" },
  { ts: "2026-08-11T15:40:00.000Z", event: "exit", symbol: "SPY", qty: 2, entry: 99, pnl: 999, reason: "signal_exit", status: "rejected" },
  { ts: "2026-08-11T13:05:00.000Z", event: "skip", symbol: "SPY", reason: "gross 81% > cap 80% — cash reserve" },
  { ts: "2026-08-11T13:06:00.000Z", event: "skip", symbol: "QQQ", reason: "gross 83% > cap 80% — cash reserve" },
].map((r) => JSON.stringify(r)).join("\n") + "\n");

const reg = require("../lib/tool-runner");
const traderMode = require("../lib/trader-mode");

const OPERATOR = { operator: true, userId: "chat-tools-test" };
const NEW_TOOLS = ["trader_config", "trader_journal", "trader_skips", "trader_alerts", "trader_alert_create", "trader_alert_delete", "trader_pause"];

let failures = 0;
const check = (name, fn) => {
  const done = (e) => {
    if (e) { failures++; process.stderr.write("  FAIL- " + name + "\n      " + e.message + "\n"); }
    else process.stdout.write("  ok  - " + name + "\n");
  };
  return Promise.resolve().then(fn).then(() => done(), done);
};
const run = (name, args = {}, ctx = OPERATOR) => reg.runTool(name, args, ctx);

(async () => {
  await check("all seven tools are registered, reads as read and capabilities as actions", () => {
    const tools = reg.capabilityManifest().tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const n of NEW_TOOLS) assert.ok(byName[n], `${n} missing from the manifest`);
    for (const n of ["trader_config", "trader_journal", "trader_skips", "trader_alerts"]) {
      assert.strictEqual(byName[n].policy, "read", `${n} must be a read tool`);
    }
    for (const n of ["trader_alert_create", "trader_alert_delete", "trader_pause"]) {
      assert.strictEqual(byName[n].policy, "action", `${n} must be an action tool`);
    }
  });

  await check("THE MONEY BOUNDARY: no chat tool can place, size, or arm an order", () => {
    const names = reg.capabilityManifest().tools.map((t) => t.name);
    const offenders = names.filter((n) => /(place|submit|buy|sell|execute_trade|order|arm|go_live)/i.test(n));
    assert.deepStrictEqual(offenders, [], `chat must expose no order/arming tool, found: ${offenders.join(", ")}`);
  });

  await check("trader_pause is ONE-WAY: nothing in chat can start or arm the trader", () => {
    const names = reg.capabilityManifest().tools.map((t) => t.name);
    const starters = names.filter((n) => /(start|resume|enable|unpause|trader_mode_set)/i.test(n));
    assert.deepStrictEqual(starters, [], `found a tool that could start the trader: ${starters.join(", ")}`);
  });

  await check("trader_config reports the active book, arming state, caps and brakes", async () => {
    const r = await run("trader_config");
    assert.strictEqual(r.status, "executed");
    assert.ok(/ACTIVE BOOK:/.test(r.result));
    assert.ok(/ARMING:/.test(r.result));
    assert.ok(/DRY RUN|ARMED \(TRADER_LIVE=1\)/.test(r.result), "must state whether real-money orders are armed");
    assert.ok(/SIZING:.*per position/s.test(r.result), "must state the position caps");
    assert.ok(/BRAKES:.*day P&L/s.test(r.result), "must state the daily-loss breaker");
  });

  await check("trader_journal keeps its honesty furniture (risk-exit rate, structural flag, disclosures)", async () => {
    const r = await run("trader_journal");
    assert.strictEqual(r.status, "executed");
    assert.ok(/3 confirmed round-trips/.test(r.result), "the rejected attempt must not be counted");
    assert.ok(/\$85\.00/.test(r.result), "realized should be 100 - 40 + 25 = $85");
    assert.ok(/Max drawdown/.test(r.result));
    assert.ok(/exits that COULD have lost/.test(r.result), "must surface the risk-exit-only win rate");
    assert.ok(/STRUCTURAL/.test(r.result), "profit-taking exits must be flagged as structural");
    assert.ok(/1 broker-rejected attempts excluded/.test(r.result), "exclusions must be disclosed, not silent");
  });

  await check("trader_skips is counts-only and reads as English (digits normalized to N)", async () => {
    const r = await run("trader_skips");
    assert.strictEqual(r.status, "executed");
    assert.ok(/declined 2 opportunities/.test(r.result), "both skips counted");
    assert.ok(/2x - gross N% > cap N%/.test(r.result), "differing digits collapse into one family, rendered as N");
    assert.ok(/no P&L can be claimed/.test(r.result), "must refuse to imply a skipped trade's P&L");
  });

  await check("alert capability: create validates, lists, and deletes", async () => {
    const made = await run("trader_alert_create", { symbol: "spy", type: "signal", direction: "BULLISH", cooldownMin: 30 });
    assert.ok(/Alert created: SPY/.test(made.result), "symbol is normalized to upper case");
    assert.ok(/nothing is traded by it/.test(made.result), "must say it moves no money");
    const id = (made.result.match(/id ([a-z0-9]+)\)/) || [])[1];
    assert.ok(id, "the new rule's id must be reported so it can be deleted");

    const junk = await run("trader_alert_create", { symbol: "<script>alert(1)</script>", type: "signal" });
    assert.ok(/refused: invalid_symbol/.test(junk.result), "a junk symbol is refused, not saved");

    const listed = await run("trader_alerts");
    assert.ok(/SPY: bullish signal/.test(listed.result));
    assert.ok(/nothing has fired yet/.test(listed.result), "an empty feed says so rather than inventing fires");

    const del = await run("trader_alert_delete", { id });
    assert.ok(/deleted/.test(del.result));
    const after = await run("trader_alerts");
    assert.ok(/\(none set\)/.test(after.result), "the rule is really gone");

    const ghost = await run("trader_alert_delete", { id: "nosuchrule" });
    assert.ok(/no rule with id/.test(ghost.result), "deleting a missing rule reports honestly");
  });

  await check("trader_pause stops a running book, is idempotent, and keeps the stops in place", async () => {
    traderMode.set(OPERATOR.userId, "stock");
    const r = await run("trader_pause");
    assert.ok(/PAUSED \(was: stock\)/.test(r.result));
    assert.ok(/protective stops stay in place/.test(r.result), "must tell the user their stops remain");
    assert.ok(/cannot start it/.test(r.result), "must state the one-way property");
    assert.strictEqual(traderMode.get(OPERATOR.userId), "off", "the mode really changed");
    const again = await run("trader_pause");
    assert.ok(/already OFF/.test(again.result), "pausing twice is safe and says so");
  });

  await check("guests are denied every one of these tools", async () => {
    for (const n of NEW_TOOLS) {
      const r = await run(n, {}, { operator: false, userId: "guest" });
      assert.strictEqual(r.status, "denied", `${n} must be denied to non-operators`);
    }
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})();
