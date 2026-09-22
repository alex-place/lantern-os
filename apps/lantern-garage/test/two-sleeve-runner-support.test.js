"use strict";
/**
 * two-sleeve-runner-support.test.js — what a dry session must prove (2026-09-21).
 *
 * The first dry session of the two-sleeve runner ticked 400 times and journaled nothing from
 * either brain: --dry had exported TRADER_AUTO_EXECUTE=0 and both brains return "nothing to do"
 * on that switch before the dry facade could see an order; and the one shared scan ran under the
 * wrong sleeve's thresholds. These tests pin the repaired contracts: the brains are armed
 * in-process in every mode (the real brain is loaded to prove the gate), the dry facade is a
 * complete wall, each sleeve scans in its own process under its own env file, and a tick's
 * summary carries the brain's own reason so a hollow tick can never look like a quiet market.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IGNORE, envFromFile, envForMode, dryFacade, tickSummary, ScanWorker, READS } = require("../lib/two-sleeve/runner-support");

const tmpdir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("envForMode: the brains are armed in-process in every mode; dry-ness never reaches their switches", () => {
  assert.deepEqual(envForMode({ dry: true }), { TRADER_AUTO_EXECUTE: "1", TRADER_MANAGE_EXITS: "1", TRADER_SESSION_REVIEW: "0" });
  assert.deepEqual(envForMode({ dry: false, sessionReview: "1" }), { TRADER_AUTO_EXECUTE: "1", TRADER_MANAGE_EXITS: "1", TRADER_SESSION_REVIEW: "1" });
  assert.equal(envForMode({ dry: false }).TRADER_SESSION_REVIEW, "0");
  assert.equal(envForMode({ dry: true, sessionReview: "1" }).TRADER_SESSION_REVIEW, "0", "no LLM session review from a dry run");
});

test("the real brain: 'nothing to do' on the switches the old dry mode exported, past the gate under envForMode", async () => {
  const dir = tmpdir("two-sleeve-brain-");
  process.env.TRADER_TRADES_LOG = path.join(dir, "trades.jsonl");
  process.env.TRADER_STATE_FILE = path.join(dir, "state.json");
  const brain = require("../lib/auto-trader");
  const bridge = {
    getIBKRAccount: async () => ({ equity: 100000, cash: 100000 }),
    getIBKRPositions: async () => [],
    getIBKROpenOrders: async () => [],
    getIBKRDayPnl: async () => 0,
    placeIBKROrder: async () => ({ status: "error", reason: "test" }),
    cancelIBKROrder: async () => ({ status: "error", reason: "test" }),
  };
  process.env.TRADER_AUTO_EXECUTE = "0"; process.env.TRADER_MANAGE_EXITS = "0";
  const off = await brain.runAutoTrade({ signals: [] }, { bridge, userId: "u" });
  assert.match(String(off.reason), /nothing to do/, "the Monday hollow: the brain never reached the account or a journal row");
  Object.assign(process.env, envForMode({ dry: true }));
  const on = await brain.runAutoTrade({ signals: [] }, { bridge, userId: "u" });
  assert.equal(on.enabled, true);
  assert.ok(!/nothing to do/.test(String(on.reason || "")), `the brain proceeds past the gate: ${on.reason || "(no reason)"}`);
});

test("dryFacade: five reads forwarded, two writes refused and journaled with an intent count, nothing else exposed", async () => {
  const real = {
    getIBKRAccount: async () => ({ equity: 1 }),
    getIBKRPositions: async () => [{ symbol: "SPY", qty: 1 }],
    getIBKROpenOrders: async () => [],
    getIBKRDayPnl: async () => 0,
    getIBKROrderStatus: async (u, id) => ({ id, status: "Filled" }),
    placeIBKROrder: async () => { throw new Error("a dry run must never reach the real placer"); },
    cancelIBKROrder: async () => { throw new Error("a dry run must never reach the real canceller"); },
    closeAllPositions: async () => { throw new Error("must not be exposed"); },
  };
  const rows = [];
  const f = dryFacade(real, (r) => rows.push(r));
  assert.deepEqual(Object.keys(f).filter((k) => typeof f[k] === "function").sort(), [...READS, "cancelIBKROrder", "placeIBKROrder"].sort());
  assert.equal(f.closeAllPositions, undefined, "an unknown facade method is not forwarded");
  assert.deepEqual(await f.getIBKRAccount("u"), { equity: 1 });
  assert.equal((await f.getIBKROrderStatus("u", "o1")).status, "Filled");
  const r1 = await f.placeIBKROrder("u", { ticker: "TLT", side: "buy", qty: 717, type: "MKT", _owner: "S", equity: 999999, secret: "x" });
  const r2 = await f.placeIBKROrder("u", { ticker: "TLT", side: "buy", qty: 717, type: "MKT", _owner: "S" });
  assert.equal(r1.status, "error"); assert.equal(r1.dry, true);
  assert.equal(await f.cancelIBKROrder("u", "o9").then((r) => r.status), "error");
  assert.deepEqual(rows.map((r) => r.event), ["dry_order", "dry_order", "dry_cancel"]);
  assert.deepEqual(rows[0].order, { ticker: "TLT", side: "buy", qty: 717, type: "MKT" }, "only order fields are journaled");
  assert.equal(rows[0].owner, "S"); assert.equal(rows[1].nth, 2);
  assert.deepEqual(f.intents, { "S buy TLT": 2 });
  assert.match(r2.reason, /dry run/);
});

test("tickSummary: a brain's early-return reason, its counts, and a sleeve's scan error are all visible", () => {
  const scans = { S: { signals: [{ symbol: "TLT", convergence: { decision: "ENTER" } }, { symbol: "SPY", convergence: { decision: "SKIP" } }] }, R: { signals: [], error: "yahoo 429" } };
  const res = { S: { executed: [{}], skipped: [{}, {}], reason: undefined }, R: { reason: "TRADER_AUTO_EXECUTE!=1 and TRADER_MANAGE_EXITS!=1 — nothing to do" }, M: { error: "boom" } };
  const s = tickSummary(res, scans);
  assert.deepEqual(s.S, { signals: 2, enters: 1, executed: 1, skipped: 2 });
  assert.equal(s.R.signals, 0); assert.match(s.R.reason, /nothing to do/); assert.equal(s.R.scan_error, "yahoo 429");
  assert.equal(s.M.error, "boom");
});

test("envFromFile: arm, journal, lock and cadence keys never enter a sleeve map; thresholds do; the judge is off", () => {
  const dir = tmpdir("two-sleeve-env-");
  const f = path.join(dir, ".env.local");
  fs.writeFileSync(f, ["# box env", "TRADER_IBS_MAX=0.30", "TRADER_P_MIN=\"0.50\"", "TRADER_AUTO_EXECUTE=1", "TRADER_TRADES_LOG=C:/x.jsonl", "TRADER_LOCK_DIR=C:/locks", "TRADER_SESSION_REVIEW=1", "TRADER_EXTENDED_EXITS=1", "ANTHROPIC_API_KEY=sk-not-a-knob", ""].join("\r\n"));
  assert.deepEqual(envFromFile(f), { TRADER_IBS_MAX: "0.30", TRADER_P_MIN: "0.50", TRADER_ENTRY_JUDGE: "0" });
  for (const k of ["TRADER_AUTO_EXECUTE", "TRADER_MANAGE_EXITS", "TRADER_TRADES_LOG", "TRADER_STATE_FILE", "TRADER_LOCK_DIR", "TRADER_SESSION_REVIEW", "TRADER_EXTENDED_EXITS"]) assert.ok(IGNORE.test(k), k);
  assert.ok(!IGNORE.test("TRADER_IBS_MAX"));
});

test("ScanWorker: each sleeve scans in its own process under its own env file and universe, nothing leaks from the parent, a hung scan times out and the worker respawns", async () => {
  const app = tmpdir("two-sleeve-app-");
  fs.mkdirSync(path.join(app, "lib", "signal-engine"), { recursive: true });
  fs.writeFileSync(path.join(app, "lib", "trader-agent.js"), [
    "'use strict';",
    "class TraderAgent {",
    "  constructor() { this.cache = {}; }",
    "  get watchlist() { return ['DEFAULT']; }",
    "  async scanMarket() {",
    "    if (process.env.STUB_HANG === '1') return new Promise(() => {});",
    "    return { signals: this.watchlist.map((s) => ({ symbol: s })), ibs: process.env.TRADER_IBS_MAX || null, leak: process.env.TRADER_LEAK || null,",
    "      key: process.env.DATA_KEY || null, arm: process.env.TRADER_AUTO_EXECUTE || null, over: process.env.TRADER_MAX_CONCURRENT || null, veto: process.env.TRADER_TRADES_LOG || null };",
    "  }",
    "}",
    "module.exports = TraderAgent;",
  ].join("\n"));
  fs.writeFileSync(path.join(app, "lib", "signal-engine", "convergence-ev.js"), "module.exports = { P_MIN: Number(process.env.TRADER_P_MIN) || 0.45 };\n");
  const envS = path.join(app, "stable.env"); fs.writeFileSync(envS, "TRADER_IBS_MAX=0.30\nTRADER_P_MIN=0.50\nDATA_KEY=s-key\nTRADER_AUTO_EXECUTE=1\n");
  const envR = path.join(app, "race.env"); fs.writeFileSync(envR, "TRADER_IBS_MAX=0.15\nDATA_KEY=r-key\n");
  process.env.TRADER_LEAK = "parent";   // the parent's box env must not reach a sleeve's scan
  const dir = tmpdir("two-sleeve-dir-");
  const log = [];
  const S = new ScanWorker({ id: "S", app, envFile: envS, env: { TRADER_MAX_CONCURRENT: "2" }, universe: ["QQQ", "TLT"], dir, timeoutMs: 8000, log: (r) => log.push(r) });
  const R = new ScanWorker({ id: "R", app, envFile: envR, env: {}, universe: ["TZA"], dir, timeoutMs: 8000, log: (r) => log.push(r) });
  const H = new ScanWorker({ id: "H", app, envFile: envR, env: { STUB_HANG: "1" }, universe: [], dir, timeoutMs: 1200, log: (r) => log.push(r) });
  try {
    const [s, r] = await Promise.all([S.scan(), R.scan()]);
    assert.equal(s.ibs, "0.30"); assert.equal(r.ibs, "0.15");
    assert.equal(s.key, "s-key"); assert.equal(r.key, "r-key");
    assert.equal(s.leak, null); assert.equal(r.leak, null);
    assert.equal(s.arm, null, "an arm key in the box file never reaches the scanner");
    assert.equal(s.over, "2", "the sleeve's override map applies");
    assert.equal(path.basename(s.veto), "S.scan.jsonl", "the scanner's veto log is the sleeve's own");
    assert.deepEqual(s.signals.map((x) => x.symbol), ["SPY", "QQQ", "TLT"]);
    assert.deepEqual(r.signals.map((x) => x.symbol), ["SPY", "TZA"]);
    const ready = log.filter((x) => x.event === "scan_worker_ready");
    assert.equal(ready.find((x) => x.sleeve === "S").pMin, 0.5, "module-load constants are the sleeve's own");
    assert.equal(ready.find((x) => x.sleeve === "R").pMin, 0.45);
    assert.equal(ready.find((x) => x.sleeve === "S").ibsMax, "0.30");
    assert.equal(S.status().scans, 1);
    // a second scan reuses the process (no respawn) ...
    await S.scan(); assert.equal(S.status().spawns, 1); assert.equal(S.status().scans, 2);
    // ... a hung scan times out, the child is killed, and the next scan respawns it
    await assert.rejects(H.scan(), /timed out/);
    assert.ok(log.some((x) => x.event === "scan_worker_timeout" && x.sleeve === "H"));
    H.env = {};
    const h2 = await H.scan();
    assert.equal(h2.ibs, "0.15"); assert.equal(H.status().spawns, 2); assert.equal(H.status().failures, 1);
  } finally { S.stop(); R.stop(); H.stop(); delete process.env.TRADER_LEAK; }
});
