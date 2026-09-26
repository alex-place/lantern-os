"use strict";
/**
 * adaptive-depth.test.js — the washout threshold follows the trader's own trailing P&L,
 * shadow-first. Unset = no behaviour change; shadow = journal only; live = block.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adaptive-depth-"));
const ledger = path.join(dir, "autopilot-trades.jsonl");
process.env.TRADER_TRADES_LOG = ledger;
const ad = require("../lib/signal-engine/adaptive-depth");

function writeSessions(equities, startDay = 1) {
  const rows = equities.map((eq, i) => JSON.stringify({ ts: `2026-09-${String(startDay + i).padStart(2, "0")}T20:00:00.000Z`, event: "session", date: `2026-09-${String(startDay + i).padStart(2, "0")}`, equity: eq }));
  rows.push(JSON.stringify({ ts: "2026-09-01T14:00:00.000Z", event: "entry", symbol: "SPY", qty: 1 }));   // noise the reader must ignore
  fs.writeFileSync(ledger, rows.join("\n") + "\n");
}

test("parseSpec: N:X:up:dn, defaults, rejects garbage", () => {
  assert.deepStrictEqual(ad.parseSpec("10:0:0.30:0.15"), { n: 10, x: 0, up: 0.30, dn: 0.15 });
  assert.deepStrictEqual(ad.parseSpec("20:-1"), { n: 20, x: -1, up: null, dn: 0.15 });
  assert.strictEqual(ad.parseSpec(""), null);
  assert.strictEqual(ad.parseSpec(undefined), null);
  assert.strictEqual(ad.parseSpec("abc"), null);
});

test("readSessions + trailingReturnPct: last row per date, ascending, strictly before today", () => {
  writeSessions([100000, 101000, 99000, 98000, 97000], 1);
  const sessions = ad.readSessions(ledger);
  assert.strictEqual(sessions.length, 5);
  assert.strictEqual(sessions[0].date, "2026-09-01");
  // 2 sessions back from the last completed one (09-05): 97000 / 99000 - 1
  assert.ok(Math.abs(ad.trailingReturnPct(sessions, 2, "2026-09-08") - (97000 / 99000 - 1) * 100) < 1e-9);
  // today's own row must not count: as of 09-05 the last completed is 09-04
  assert.ok(Math.abs(ad.trailingReturnPct(sessions, 2, "2026-09-05") - (98000 / 101000 - 1) * 100) < 1e-9);
  // not enough history -> null
  assert.strictEqual(ad.trailingReturnPct(sessions, 10, "2026-09-08"), null);
});

test("current(): unset knob = null; deep when the trailing return is below X; morning never deep-gated", () => {
  delete process.env.TRADER_ADAPTIVE_IBS_PNL;
  assert.strictEqual(ad.current({ nowMs: Date.parse("2026-09-08T15:00:00Z") }), null);
  process.env.TRADER_ADAPTIVE_IBS_PNL = "2:0:0.30:0.15";
  ad._resetForTests();
  writeSessions([100000, 101000, 99000, 98000, 97000], 1);
  const st = ad.current({ nowMs: Date.parse("2026-09-08T15:00:00Z") });
  assert.ok(st && st.deep, "losing 2 sessions -> deep");
  assert.strictEqual(st.mode, "shadow");
  assert.strictEqual(st.thrDeep, 0.15);
  // a winning stretch -> not deep
  writeSessions([100000, 101000, 102000, 103000, 104000], 1);
  ad._resetForTests();
  const st2 = ad.current({ nowMs: Date.parse("2026-09-08T15:00:00Z") });
  assert.ok(st2 && !st2.deep);
  // too little history -> not deep (rule stays at the live threshold)
  writeSessions([100000, 99000], 1);
  ad._resetForTests();
  const st3 = ad.current({ nowMs: Date.parse("2026-09-08T15:00:00Z") });
  assert.ok(st3 && !st3.deep && st3.trailingPct === null);
});

test("decide(): only after 11:00, only when deep, only for admitted signals above the deep threshold", () => {
  const deep = { deep: true, thrDeep: 0.15, mode: "shadow" };
  assert.deepStrictEqual(ad.decide({ ibs: 0.25, thrLive: 0.30, state: deep, etMin: 700 }), { admits: true, wouldBlock: true, thrEffective: 0.15 });
  assert.deepStrictEqual(ad.decide({ ibs: 0.10, thrLive: 0.30, state: deep, etMin: 700 }), { admits: true, wouldBlock: false, thrEffective: 0.15 });
  assert.strictEqual(ad.decide({ ibs: 0.25, thrLive: 0.30, state: deep, etMin: 600 }).wouldBlock, false, "morning: untouched");
  assert.strictEqual(ad.decide({ ibs: 0.25, thrLive: 0.30, state: { deep: false, thrDeep: 0.15 }, etMin: 700 }).wouldBlock, false, "not deep: untouched");
  assert.strictEqual(ad.decide({ ibs: 0.40, thrLive: 0.30, state: deep, etMin: 700 }).admits, false, "live threshold refuses first");
  assert.strictEqual(ad.decide({ ibs: 0.25, thrLive: 0.30, state: null, etMin: 700 }).wouldBlock, false, "knob off");
});

test("shadow journal: one state row per session, one decision row per symbol per session hour, in-session only", () => {
  process.env.TRADER_ADAPTIVE_IBS_PNL = "2:0:0.30:0.15";
  ad._resetForTests();
  writeSessions([100000, 99000, 98000], 1);
  const now = Date.parse("2026-09-08T16:30:00Z");   // 12:30 ET
  const st = ad.current({ nowMs: now });
  assert.ok(st.deep);
  assert.strictEqual(ad.journalState(st, now), true);
  assert.strictEqual(ad.journalState(st, now), false, "deduped per session");
  assert.strictEqual(ad.journalDecision({ symbol: "IWM", ibs: 0.22, thrLive: 0.30, state: st, etMin: 750, price: 200, nowMs: now }), true);
  assert.strictEqual(ad.journalDecision({ symbol: "IWM", ibs: 0.24, thrLive: 0.30, state: st, etMin: 770, price: 201, nowMs: now }), false, "same symbol, same hour");
  assert.strictEqual(ad.journalDecision({ symbol: "IWM", ibs: 0.24, thrLive: 0.30, state: st, etMin: 810, price: 201, nowMs: now }), true, "next hour");
  assert.strictEqual(ad.journalDecision({ symbol: "GLD", ibs: 0.24, thrLive: 0.30, state: st, etMin: 1000, price: 300, nowMs: now }), false, "after the close: not a decision");
  const rows = fs.readFileSync(ledger, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const state = rows.filter((r) => r.event === "adaptive_depth_state");
  const shadow = rows.filter((r) => r.event === "adaptive_depth_shadow");
  assert.strictEqual(state.length, 1);
  assert.strictEqual(shadow.length, 2);
  assert.strictEqual(shadow[0].symbol, "IWM");
  assert.strictEqual(shadow[0].mode, "shadow");
  assert.strictEqual(shadow[0].would_block, true);
  assert.strictEqual(rows.filter((r) => r.event === "adaptive_depth_block").length, 0, "shadow never writes block rows");
});

test("scan integration: IBS-only direction is unchanged in shadow mode and refused in live mode", () => {
  process.env.TRADER_IBS_MODE = "only";
  process.env.TRADER_IBS_MAX = "0.30";
  process.env.TRADER_ADAPTIVE_IBS_PNL = "2:0:0.30:0.15";
  process.env.TRADER_ADAPTIVE_IBS_MODE = "shadow";
  ad._resetForTests();
  writeSessions([100000, 99000, 98000], 1);
  const scan = require("../lib/signal-engine/scan");
  assert.strictEqual(typeof scan.deriveDirection, "function", "deriveDirection is exported for tests");
  const now = Date.parse("2026-09-08T16:30:00Z");
  const opts = { ibs: 0.25, etMin: 750, symbol: "IWM", price: 200, nowMs: now };
  assert.strictEqual(scan.deriveDirection({ in_zone: false }, 50, {}, opts), "BULLISH", "shadow: the live threshold still decides");
  process.env.TRADER_ADAPTIVE_IBS_MODE = "live";
  ad._resetForTests();
  assert.strictEqual(scan.deriveDirection({ in_zone: false }, 50, {}, opts), "NEUTRAL", "live: a 0.25 washout is refused while deep");
  assert.strictEqual(scan.deriveDirection({ in_zone: false }, 50, {}, { ...opts, ibs: 0.10 }), "BULLISH", "live: a 0.10 washout still enters");
  assert.strictEqual(scan.deriveDirection({ in_zone: false }, 50, {}, { ...opts, etMin: 600 }), "BULLISH", "live: the morning is never deep-gated");
  const rows = fs.readFileSync(ledger, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(rows.some((r) => r.event === "adaptive_depth_block" && r.symbol === "IWM"), "live mode journals the block");
  delete process.env.TRADER_ADAPTIVE_IBS_PNL;
  ad._resetForTests();
  assert.strictEqual(scan.deriveDirection({ in_zone: false }, 50, {}, opts), "BULLISH", "knob unset: no behaviour change");
});
