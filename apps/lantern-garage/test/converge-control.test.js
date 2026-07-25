"use strict";
// #2857 — the unified control law. Pins the priority order (anti-runaway → halt → ground →
// continue) and the core thesis: without external evidence the loop saturates, so it must route
// to grounding (the only unbounded improvement term) rather than keep introspecting.
//
// Run: node apps/lantern-garage/test/converge-control.test.js
const assert = require("assert");
const { convergeControl } = require("../lib/converge-control");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

check("M6 lasing + unanchored → KILL (anti-runaway wins over everything)", () => {
  const r = convergeControl({ gainOverLeak: 1.5, evidenceInflux: false, fixedPoint: true, stable: true, groundingDue: true });
  assert.strictEqual(r.action, "kill");
});

check("a lasing mode that IS externally anchored is not killed", () => {
  const r = convergeControl({ gainOverLeak: 1.5, evidenceInflux: true, confidenceRising: true });
  assert.notStrictEqual(r.action, "kill");
});

check("stable fixed point with nothing pending → HALT converged", () => {
  const r = convergeControl({ gainOverLeak: 0.5, fixedPoint: true, stable: true, groundingDue: false });
  assert.strictEqual(r.action, "halt_converged");
});

check("fixed point but re-grounding due → does NOT halt (ground first)", () => {
  const r = convergeControl({ fixedPoint: true, stable: true, groundingDue: true, budgetRemaining: 5 });
  assert.strictEqual(r.action, "ground");
});

check("fixed point but NOT stable → don't halt", () => {
  const r = convergeControl({ fixedPoint: true, stable: false, evidenceInflux: true, confidenceRising: true });
  assert.notStrictEqual(r.action, "halt_converged");
});

check("M2 re-grounding cadence elapsed → GROUND (when affordable)", () => {
  const r = convergeControl({ groundingDue: true, budgetRemaining: 3, evidenceInflux: true, confidenceRising: true });
  assert.strictEqual(r.action, "ground");
  assert.ok(/M2/.test(r.reason));
});

check("SATURATED (no evidence influx, not converged) → GROUND: only evidence can improve (M1)", () => {
  const r = convergeControl({ evidenceInflux: false, confidenceRising: true, fixedPoint: false, budgetRemaining: 2 });
  assert.strictEqual(r.action, "ground");
  assert.strictEqual(r.saturated, true);
  assert.ok(/introspection|evidence/.test(r.reason));
});

check("saturated AND out of budget → HALT saturated (bounded cost, can't buy evidence)", () => {
  const r = convergeControl({ evidenceInflux: false, fixedPoint: false, budgetRemaining: 0 });
  assert.strictEqual(r.action, "halt_saturated");
});

check("improving on external evidence, not due, not converged → CONTINUE", () => {
  const r = convergeControl({ evidenceInflux: true, confidenceRising: true, gainOverLeak: 0.4, budgetRemaining: 5 });
  assert.strictEqual(r.action, "continue");
  assert.strictEqual(r.improving, true);
});

check("unknown budget is treated as affordable (grounds rather than false-halt)", () => {
  const r = convergeControl({ evidenceInflux: false, fixedPoint: false }); // no budgetRemaining given
  assert.strictEqual(r.action, "ground");
});

// --- M7: attribution loss (docs/research/2026-07-24-owned-math-m7-attribution.md) ---

check("M7: laundered gain — global influx but zero mode-attributed evidence → KILL", () => {
  // World L: an unrelated feed item arrives every step (evidenceInflux true) while the lasing
  // mode itself has zero external-innovation coupling. M6's side condition holds → kill.
  const r = convergeControl({ gainOverLeak: 1.4, evidenceInflux: true, confidenceRising: true, evidenceForMode: false });
  assert.strictEqual(r.action, "kill");
  assert.ok(/laundering/.test(r.reason));
});

check("M7: mode-attributed evidence keeps the anchored laser alive", () => {
  const r = convergeControl({ gainOverLeak: 1.4, evidenceInflux: true, confidenceRising: true, evidenceForMode: true });
  assert.notStrictEqual(r.action, "kill");
});

check("M7: keyed anchor overrides the global bit in BOTH directions (mode-anchored, globally quiet)", () => {
  // Evidence arrived for this mode but the global bit is off (e.g. aggregator lag): no kill.
  const r = convergeControl({ gainOverLeak: 1.4, evidenceInflux: false, evidenceForMode: true });
  assert.notStrictEqual(r.action, "kill");
});

check("M7: legacy calls (no evidenceForMode) keep the global-fallback reading exactly", () => {
  const r = convergeControl({ gainOverLeak: 1.5, evidenceInflux: true, confidenceRising: true });
  assert.notStrictEqual(r.action, "kill");
  const r2 = convergeControl({ gainOverLeak: 1.5, evidenceInflux: false });
  assert.strictEqual(r2.action, "kill");
});

check("M7/F2: converged-but-stale-and-broke halt no longer claims saturation in its reason", () => {
  const r = convergeControl({ fixedPoint: true, stable: true, groundingDue: true, budgetRemaining: 0 });
  assert.strictEqual(r.action, "halt_saturated"); // conservative action retained
  assert.strictEqual(r.saturated, false);
  assert.ok(!/saturated and grounding/.test(r.reason), "reason must not claim saturation");
  assert.ok(/stale, not saturated/.test(r.reason));
});

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
