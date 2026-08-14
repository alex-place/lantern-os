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

// The operator IS the house account (routes and tools resolve an id-less owner box
// to 'local-owner'), so the operator's journal is the pre-attribution book.
const OPERATOR = { operator: true, userId: "local-owner" };
const NEW_TOOLS = ["trader_config", "trader_journal", "trader_skips", "trader_alerts", "trader_alert_create", "trader_alert_delete", "trader_pause", "trader_start"];

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
  await check("all eight tools are registered, reads as read and capabilities as actions", () => {
    const tools = reg.capabilityManifest().tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const n of NEW_TOOLS) assert.ok(byName[n], `${n} missing from the manifest`);
    for (const n of ["trader_config", "trader_journal", "trader_skips", "trader_alerts"]) {
      assert.strictEqual(byName[n].policy, "read", `${n} must be a read tool`);
    }
    for (const n of ["trader_alert_create", "trader_alert_delete", "trader_pause", "trader_start"]) {
      assert.strictEqual(byName[n].policy, "action", `${n} must be an action tool`);
    }
  });

  await check("THE MONEY BOUNDARY: no chat tool can place, size, or arm an order", () => {
    const names = reg.capabilityManifest().tools.map((t) => t.name);
    const offenders = names.filter((n) => /(place|submit|buy|sell|execute_trade|order|arm|go_live)/i.test(n));
    assert.deepStrictEqual(offenders, [], `chat must expose no order/arming tool, found: ${offenders.join(", ")}`);
  });

  await check("starting is Pilot-gated while stopping never is (the safety asymmetry)", async () => {
    const proNoPilot = { operator: false, userId: "sa-pro", role: "deep_dreamer" };
    const started = await run("trader_start", { book: "intraday" }, proNoPilot);
    assert.ok(/Pilot plan/.test(started.result), "a Pro user cannot arm the autonomous trader");
    assert.ok(/do NOT claim the trader was started/.test(started.result));
    assert.strictEqual(traderMode.get("sa-pro"), "off", "the refused start must not have changed the book");
    const paused = await run("trader_pause", {}, proNoPilot);
    assert.strictEqual(paused.status, "executed", "stopping is never gated");
  });

  await check("trader_start arms the named book and never touches server-side arming", async () => {
    const pilot = { operator: false, userId: "sa-pilot", role: "pilot" };
    const r = await run("trader_start", { book: "intraday" }, pilot);
    assert.ok(/ARMED/.test(r.result));
    assert.strictEqual(traderMode.get("sa-pilot"), "stock", "'intraday' maps to the store's historical name");
    assert.ok(/real-money orders are OFF/.test(r.result), "must state that real orders are not armed server-side");
    assert.ok(!/TRADER_LIVE=1/.test(String(process.env.TRADER_LIVE)), "the tool must never set the server arming flag");
    const champ = await run("trader_start", { book: "champion" }, pilot);
    assert.ok(/Champion/.test(champ.result));
    assert.strictEqual(traderMode.get("sa-pilot"), "champion", "switching books works");
    const junk = await run("trader_start", { book: "yolo" }, pilot);
    assert.ok(/must be 'intraday' or 'champion'/.test(junk.result), "an unknown book is refused, not guessed");
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
    assert.ok(/does NOT flatten/.test(r.result), "must be explicit that pausing is not closing");
    assert.strictEqual(traderMode.get(OPERATOR.userId), "off", "the mode really changed");
    const again = await run("trader_pause");
    assert.ok(/already OFF/.test(again.result), "pausing twice is safe and says so");
  });

  await check("signed-OUT callers are denied every one of these tools", async () => {
    for (const n of NEW_TOOLS) {
      const r = await run(n, {}, { operator: false });   // no userId → not signed in
      assert.strictEqual(r.status, "denied", `${n} must be denied to a signed-out caller`);
    }
  });

  // ── The signed-in tier (hosted users) ──────────────────────────────────────
  const PRO = { operator: false, userId: "hosted-pro", role: "deep_dreamer" };
  const FREE = { operator: false, userId: "hosted-free", role: "supporter" };

  await check("TIER: a signed-in Pro user reaches their own per-user tools", async () => {
    for (const n of ["trader_config", "trader_alerts", "trader_pause"]) {
      const r = await run(n, {}, PRO);
      assert.strictEqual(r.status, "executed", `${n} must run for a signed-in Pro user`);
    }
  });

  await check("PER-USER LEDGER: one account's journal never answers with another's", async () => {
    // Two accounts trade the same window; each must see only its own book.
    fs.appendFileSync(process.env.TRADER_TRADES_LOG, [
      { ts: "2026-08-11T16:00:00.000Z", user: "alice", event: "exit", symbol: "TQQQ", qty: 5, entry: 90, pnl: 500, reason: "zone_r1", status: "filled" },
      { ts: "2026-08-11T16:05:00.000Z", user: "alice", event: "skip", symbol: "SOXL", reason: "cooldown active" },
      { ts: "2026-08-11T16:10:00.000Z", user: "bob", event: "exit", symbol: "TZA", qty: 5, entry: 20, pnl: -70, reason: "stop", status: "filled" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    require("../lib/track-record")._resetCache();

    const alice = await run("trader_journal", {}, { operator: false, userId: "alice", role: "deep_dreamer" });
    assert.ok(/\$500\.00/.test(alice.result), "alice sees her own winner");
    assert.ok(!/\$85\.00/.test(alice.result), "alice must NOT see the house book's total");
    assert.ok(!/-\$70/.test(alice.result), "alice must NOT see bob's loss");

    const bob = await run("trader_journal", {}, { operator: false, userId: "bob", role: "deep_dreamer" });
    assert.ok(/-\$70\.00/.test(bob.result), "bob sees his own loss");
    assert.ok(!/\$500/.test(bob.result), "bob must NOT see alice's winner");

    const aliceSkips = await run("trader_skips", {}, { operator: false, userId: "alice", role: "deep_dreamer" });
    assert.ok(/cooldown/.test(aliceSkips.result), "alice sees her own decline");
    const bobSkips = await run("trader_skips", {}, { operator: false, userId: "bob", role: "deep_dreamer" });
    assert.ok(/nothing declined/i.test(bobSkips.result), "bob declined nothing and is told so, not handed alice's");

    // A user with no rows at all gets an honest empty, never a substitute.
    const stranger = await run("trader_journal", {}, { operator: false, userId: "stranger", role: "deep_dreamer" });
    assert.ok(/no broker-confirmed round-trips/.test(stranger.result));
    assert.ok(/Do not substitute anyone else's results/.test(stranger.result));
  });

  await check("PER-USER LEDGER: legacy un-stamped rows read as the house book, not as anyone's", async () => {
    const { readExits, HOUSE_USER } = require("../lib/trader-scorecard");
    const house = readExits(process.env.TRADER_TRADES_LOG, HOUSE_USER);
    assert.ok(house.length >= 3, "the pre-attribution rows belong to the house book");
    assert.ok(house.every((r) => !r.user), "…and they are exactly the rows with no stamped account");
    const everything = readExits(process.env.TRADER_TRADES_LOG);
    assert.ok(everything.length > house.length, "an unfiltered read still returns the whole book for operator-side callers");
  });

  await check("TIER: a signed-out caller gets 'sign in', not a misleading 'operator' reason", async () => {
    const r = await run("trader_alerts", {}, { operator: false });
    assert.strictEqual(r.reason_code, "sign_in_required");
    assert.ok(/signed in/.test(r.error));
  });

  await check("PLAN BYPASS: chat cannot hand a Free user a Pro feature", async () => {
    const listed = await run("trader_alerts", {}, FREE);
    assert.strictEqual(listed.status, "executed", "the tool runs...");
    assert.ok(/Pro plan/.test(listed.result), "...but refuses the feature and names the plan");
    const made = await run("trader_alert_create", { symbol: "SPY", type: "signal" }, FREE);
    assert.ok(/refused: price alerts are part of the Pro plan/.test(made.result));
    assert.ok(/do NOT pretend the alert was created/.test(made.result), "the model is told not to fake success");
    // and nothing was actually written
    const asPro = await run("trader_alerts", {}, { operator: false, userId: "hosted-free", role: "deep_dreamer" });
    assert.ok(/\(none set\)/.test(asPro.result), "the refused create must not have persisted a rule");
  });

  await check("PLAN BYPASS: capability check fails CLOSED on an unknown role", async () => {
    const r = await run("trader_alert_create", { symbol: "SPY", type: "signal" }, { operator: false, userId: "u", role: "nonsense-role" });
    assert.ok(/Pro plan/.test(r.result), "an unrecognized role must be refused, not allowed");
  });

  await check("PAUSE is never withheld: a Free user can still stop their own trader", async () => {
    const r = await run("trader_pause", {}, FREE);
    assert.strictEqual(r.status, "executed", "stopping is risk-reducing — it must not be plan-gated");
  });

  await check("the advertised set matches the gate on every provider builder", () => {
    const anth = (o) => reg.anthropicTools(o).map((t) => t.name);
    const oai = (o) => reg.openaiTools(o).map((t) => t.function.name);
    const gem = (o) => reg.geminiTools(o)[0].functionDeclarations.map((d) => d.name);
    for (const o of [{}, { signedIn: true }, { operator: true }]) {
      assert.deepStrictEqual(anth(o), oai(o), "anthropic and openai sets must match");
      assert.deepStrictEqual(anth(o), gem(o), "anthropic and gemini sets must match");
    }
    const guest = anth({});
    const signed = anth({ signedIn: true });
    assert.ok(!guest.includes("trader_alerts"), "a signed-out model must not even SEE the per-user tools");
    assert.ok(signed.includes("trader_alerts") && signed.includes("trader_pause"), "a signed-in model sees its per-user tools");
    assert.ok(signed.includes("trader_journal") && signed.includes("trader_start"), "per-user journal and arming are in the signed-in set");
    assert.ok(!signed.includes("trader_positions"), "tools that read the live broker account stay operator-only");
    assert.ok(!signed.includes("workspace_read"), "the signed-in tier must not leak filesystem tools");
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})();
