"use strict";
/**
 * IBKR /pa/performance NAV parsing.
 *
 * IBKR does not publish this endpoint's response schema -- their own Web API reference
 * lists it in the pacing table (POST, 1 req/15 min) and says not all endpoints are
 * documented yet. The parser therefore DISCOVERS the series rather than asserting a
 * field path, and these cases pin the shapes it must survive. When a live response is
 * finally captured (scripts/probe-ibkr-performance.js), add it here as one more case.
 */
const test = require("node:test");
const assert = require("node:assert");
const IbkrCpapi = require("../lib/ibkr-cpapi");

const find = IbkrCpapi._findNavSeries;
const secs = IbkrCpapi._toEpochSeconds;

test("date parsing accepts the formats IBKR is known to emit", () => {
  const may7 = Date.UTC(2026, 4, 7) / 1000;
  assert.equal(secs("20260507"), may7, "compact YYYYMMDD");
  assert.equal(secs("2026-05-07"), may7, "ISO date");
  assert.equal(secs(may7), may7, "epoch seconds pass through");
  assert.equal(secs(may7 * 1000), may7, "epoch millis are scaled down");
  assert.equal(secs(null), null);
  assert.equal(secs("not a date"), null);
});

test("finds a flat { dates, navs } pair", () => {
  const got = find({ nav: { dates: ["20260507", "20260508"], navs: [100000, 100034.84] } });
  assert.ok(got, "series found");
  assert.deepEqual(got.values, [100000, 100034.84]);
});

test("finds values nested one level down in data[]", () => {
  // { dates, data: [ { navs: [...] } ] } -- the shape most third-party clients report.
  const got = find({ nav: { dates: ["20260507", "20260508", "20260511"], data: [{ id: "U1", navs: [1, 2, 3] }] } });
  assert.ok(got);
  assert.deepEqual(got.values, [1, 2, 3]);
});

test("falls back to any same-length numeric array beside the dates", () => {
  const got = find({ perf: { labels: ["2026-05-07", "2026-05-08"], somethingElse: [5, 6] } });
  assert.ok(got, "unnamed value array is still found");
  assert.deepEqual(got.values, [5, 6]);
});

test("ignores a numeric array whose length does not match the dates", () => {
  // A mismatched array is NOT the series -- pairing them would silently misalign the
  // curve, which is worse than showing no curve.
  const got = find({ nav: { dates: ["20260507", "20260508"], navs: [1, 2, 3, 4] } });
  assert.equal(got, null);
});

test("returns null for responses with no series at all", () => {
  assert.equal(find({}), null);
  assert.equal(find({ error: "no data" }), null);
  assert.equal(find(null), null);
  assert.equal(find({ nav: { dates: ["20260507"], navs: [1] } }), null, "a single point is not a series");
});

test("survives a deeply nested / unexpected envelope", () => {
  const got = find({ a: { b: { c: [{ d: { dates: ["20260507", "20260508"], navs: [7, 8] } }] } } });
  assert.ok(got);
  assert.deepEqual(got.values, [7, 8]);
});

test("does not loop forever on a self-referencing object", () => {
  const node = { dates: ["20260507", "20260508"], navs: [1, 2] };
  node.self = node;                       // the walker must not recurse into itself
  const got = find({ root: node });
  assert.ok(got);
  assert.deepEqual(got.values, [1, 2]);
});
