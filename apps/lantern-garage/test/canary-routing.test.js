"use strict";
// ADR-0012 step 4 (#1937) — the JS canaries emit a serving-path routing hint so a
// collapsing / ungrounded local reply can escalate to a stronger tier. Pure functions,
// so this runs on any box (no model / torch) — Node only.
const assert = require("assert");
const { collapseRoutingHint } = require("../lib/collapse-canary");
const { groundednessRoutingHint } = require("../lib/groundedness-canary");

let pass = 0;
function ok(desc, cond) {
  assert.ok(cond, desc);
  console.log("  ok  - " + desc);
  pass++;
}

// ── collapseRoutingHint ──────────────────────────────────────────────────────
ok("collapse: a flagged reply escalates to cloud with reason=collapse", (() => {
  const h = collapseRoutingHint({ proximity: 0.9, collapsed: true });
  return h.escalate === true && h.tier === "cloud" && h.reason === "collapse" && h.proximity === 0.9;
})());

ok("collapse: a healthy reply stays local, reason=none", (() => {
  const h = collapseRoutingHint({ proximity: 0.2, collapsed: false });
  return h.escalate === false && h.tier === "local" && h.reason === "none";
})());

ok("collapse: routeThreshold escalates a borderline reply before full collapse", (() => {
  const h = collapseRoutingHint({ proximity: 0.7, collapsed: false }, { routeThreshold: 0.6 });
  return h.escalate === true && h.reason === "collapse";
})());

ok("collapse: an explicit routeThreshold is the single gate (overrides the flag)", (() => {
  const h = collapseRoutingHint({ proximity: 0.5, collapsed: true }, { routeThreshold: 0.8 });
  return h.escalate === false && h.tier === "local";
})());

ok("collapse: a custom escalateTier is honored", (() => {
  return collapseRoutingHint({ proximity: 0.95, collapsed: true }, { escalateTier: "deep" }).tier === "deep";
})());

ok("collapse: a missing score is a safe no-escalate (proximity 0)", (() => {
  const h = collapseRoutingHint(undefined);
  return h.escalate === false && h.proximity === 0 && h.reason === "none";
})());

// ── groundednessRoutingHint ──────────────────────────────────────────────────
ok("grounded: an ungrounded reply escalates to cloud with reason=ungrounded", (() => {
  const h = groundednessRoutingHint({ risk: 0.8, ungrounded: true });
  return h.escalate === true && h.tier === "cloud" && h.reason === "ungrounded" && h.risk === 0.8;
})());

ok("grounded: an anchored reply stays local, reason=none", (() => {
  const h = groundednessRoutingHint({ risk: 0.1, ungrounded: false });
  return h.escalate === false && h.tier === "local" && h.reason === "none";
})());

ok("grounded: routeThreshold escalates a borderline-risky reply proactively", (() => {
  const h = groundednessRoutingHint({ risk: 0.6, ungrounded: false }, { routeThreshold: 0.5 });
  return h.escalate === true && h.reason === "ungrounded";
})());

ok("grounded: an explicit routeThreshold overrides the flag", (() => {
  const h = groundednessRoutingHint({ risk: 0.4, ungrounded: true }, { routeThreshold: 0.7 });
  return h.escalate === false && h.tier === "local";
})());

ok("grounded: a missing score is a safe no-escalate (risk 0)", (() => {
  const h = groundednessRoutingHint(null);
  return h.escalate === false && h.risk === 0;
})());

// ── contract parity ──────────────────────────────────────────────────────────
ok("both canaries emit the same {escalate,tier,reason} routing contract", (() => {
  const c = collapseRoutingHint({ proximity: 0.9, collapsed: true });
  const g = groundednessRoutingHint({ risk: 0.9, ungrounded: true });
  const keys = (o) => "escalate" in o && "tier" in o && "reason" in o;
  return keys(c) && keys(g);
})());

console.log("\nall canary-routing checks passed (" + pass + ")");
