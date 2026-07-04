"use strict";
const { test } = require("node:test");
const assert = require("node:assert");

const grounding = require("../lib/kalshi-grounding");
const screener = require("../lib/kalshi-screener");

const CAL = { calibrate: (p) => p, brier: 0.2, n: 10 };
const MKTS = [
  { ticker: "A", title: "Big YES edge", yes_ask: 55, no_ask: 47, volume: 100 },
  { ticker: "B", title: "Big NO edge", yes_ask: 60, no_ask: 42, volume: 500 },
  { ticker: "C", title: "Ungrounded high vol", yes_ask: 50, no_ask: 52, volume: 9999 },
];
function withPeek(map, fn) {
  const orig = grounding.peek;
  grounding.peek = (t) => (t in map ? map[t] : null);
  try { return fn(); } finally { grounding.peek = orig; }
}
const PEEK = {
  A: { p_yes: 0.70, web_grounded: true, sources: [] },
  B: { p_yes: 0.30, web_grounded: true, sources: [] },
};

test("edge sort ranks grounded/mispriced first, ungrounded last", () => {
  withPeek(PEEK, () => {
    const rows = screener.buildRows(MKTS, { calibrator: CAL, sort: "edge" });
    assert.deepEqual(rows.map((r) => r.ticker), ["B", "A", "C"]); // B (+26.3¢) > A (+13.3¢) > C (—)
    assert.equal(rows[2].edge.grounded, false);
  });
});

test("volume sort ignores edge", () => {
  withPeek(PEEK, () => {
    const rows = screener.buildRows(MKTS, { calibrator: CAL, sort: "volume" });
    assert.equal(rows[0].ticker, "C"); // 9999
  });
});

test("groundedOnly filters out ungrounded", () => {
  withPeek(PEEK, () => {
    const rows = screener.buildRows(MKTS, { calibrator: CAL, groundedOnly: true });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.edge.grounded));
  });
});

test("minEdge keeps only rows at/above the threshold", () => {
  withPeek(PEEK, () => {
    const rows = screener.buildRows(MKTS, { calibrator: CAL, minEdge: 20 });
    assert.deepEqual(rows.map((r) => r.ticker), ["B"]); // only B ≥ 20¢
  });
});

test("q filters by title/ticker substring", () => {
  withPeek(PEEK, () => {
    const rows = screener.buildRows(MKTS, { calibrator: CAL, q: "ungrounded" });
    assert.deepEqual(rows.map((r) => r.ticker), ["C"]);
  });
});

test("limit caps the row count", () => {
  withPeek(PEEK, () => {
    assert.equal(screener.buildRows(MKTS, { calibrator: CAL, limit: 2 }).length, 2);
  });
});
