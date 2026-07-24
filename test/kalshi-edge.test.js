"use strict";
const { test } = require("node:test");
const assert = require("node:assert");

const grounding = require("../lib/kalshi-grounding");
const edge = require("../lib/kalshi-edge");

// Deterministic calibrator (identity) so the test asserts the fee/EV math, not calibration.
const CAL = { calibrate: (p) => p, brier: 0.18, n: 42 };

function withPeek(map, fn) {
  const orig = grounding.peek;
  grounding.peek = (t) => (t in map ? map[t] : null);
  try { return fn(); } finally { grounding.peek = orig; }
}

test("grounded market: YES underpriced → +EV BUY YES with Brier", () => {
  withPeek({ "M-YES": { p_yes: 0.62, web_grounded: true, confidence: 0.7, sources: ["reuters.com"] } }, () => {
    const e = edge.edgeForMarket({ ticker: "M-YES", yes_ask: 55, no_ask: 47 }, CAL);
    assert.equal(e.grounded, true);
    assert.equal(e.side, "YES");
    assert.equal(e.positive, true);
    assert.ok(e.edgeCents > 0, "edge should be positive cents");
    assert.equal(e.marketP, 0.55);
    assert.equal(e.brier, 0.18);
    assert.equal(e.n, 42);
  });
});

test("grounded market: low P(YES) → BUY NO side chosen", () => {
  withPeek({ "M-NO": { p_yes: 0.40, web_grounded: true, confidence: 0.6, sources: [] } }, () => {
    const e = edge.edgeForMarket({ ticker: "M-NO", yes_ask: 55, no_ask: 47 }, CAL);
    assert.equal(e.side, "NO");
    assert.equal(e.positive, true);
  });
});

test("ungrounded market → no edge claimed", () => {
  withPeek({}, () => {
    const e = edge.edgeForMarket({ ticker: "NONE", yes_ask: 55, no_ask: 47 }, CAL);
    assert.equal(e.grounded, false);
    assert.equal(e.marketP, 0.55);
  });
});

test("knowledge-only (not web_grounded) → no edge claimed", () => {
  withPeek({ "KO": { p_yes: 0.7, web_grounded: false } }, () => {
    const e = edge.edgeForMarket({ ticker: "KO", yes_ask: 55, no_ask: 47 }, CAL);
    assert.equal(e.grounded, false);
  });
});

test("attachEdges tags a list of cards carrying .market", () => {
  withPeek({ "A": { p_yes: 0.8, web_grounded: true, sources: [] } }, () => {
    const cards = [{ ticker: "A", market: { ticker: "A", yes_ask: 60, no_ask: 42 } }, { ticker: "B" }];
    edge.attachEdges(cards);
    assert.equal(cards[0].edge.grounded, true);
    assert.equal(cards[1].edge, undefined); // no .market → untouched
  });
});
