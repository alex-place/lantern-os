"use strict";
// Unit checks for the gated auto-dispatch worker (no live server needed).
const assert = require("assert");
const ad = require("../apps/lantern-garage/lib/auto-dispatch");

let pass = 0;
function ok(name, cond) { assert.ok(cond, name); console.log("  ✓ " + name); pass++; }

(async () => {
  // 1. OFF by default (so dev/preview never auto-run).
  delete process.env.AUTO_DISPATCH;
  ok("enabled() false without AUTO_DISPATCH=1", ad.enabled() === false);
  ok("start() returns null (no timer) when disabled", ad.start({ port: 0, repoRoot: "." }) === null);

  // 2. Enabled only with the explicit flag.
  process.env.AUTO_DISPATCH = "1";
  ok("enabled() true with AUTO_DISPATCH=1", ad.enabled() === true);
  delete process.env.AUTO_DISPATCH;

  // 3. Interval default + clamp (never busier than 30s).
  delete process.env.AUTO_DISPATCH_INTERVAL_MS;
  ok("intervalMs() defaults to 5 min", ad.intervalMs() === 300000);
  process.env.AUTO_DISPATCH_INTERVAL_MS = "1000";
  ok("intervalMs() clamps sub-30s values to the 5-min default", ad.intervalMs() === 300000);
  process.env.AUTO_DISPATCH_INTERVAL_MS = "60000";
  ok("intervalMs() honors >=30s values", ad.intervalMs() === 60000);
  delete process.env.AUTO_DISPATCH_INTERVAL_MS;

  // 4. Serialized — nothing in flight at rest.
  ok("_inFlight() false initially", ad._inFlight() === false);

  // 5. Cloud gate is conservative: unreachable chat → not healthy → would PAUSE.
  const healthy = await ad.cloudHealthy(1); // nothing listening on port 1
  ok("cloudHealthy() false when chat is unreachable (conservative pause)", healthy === false);

  // 6. pickTopIssue never throws (degrades to null on any failure).
  let top;
  assert.doesNotThrow(() => { top = ad.pickTopIssue(process.cwd()); });
  ok("pickTopIssue() returns null or a work-item, never throws", top === null || typeof top === "object");

  // 7. tick() is a no-op when disabled and leaves no in-flight state.
  delete process.env.AUTO_DISPATCH;
  await ad.tick({ port: 1, repoRoot: process.cwd() });
  ok("tick() is a no-op when disabled (in-flight stays false)", ad._inFlight() === false);

  console.log(`\nauto-dispatch: ${pass} checks passed.`);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
