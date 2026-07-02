// Autowork is chat-only (lib/auto-dispatch.js). The headless background daemon that
// self-dispatched the backlog into draft PRs is permanently disabled per the founder
// rule "autowork must never be headless." These checks pin the guarantee so a future
// change can't silently re-arm the loop: neither the AUTO_DISPATCH env, the runtime
// toggle, nor a persisted per-worktree enabledOverride can enable it, and start() must
// never arm a timer.
//
// Run: node apps/lantern-garage/test/auto-dispatch-chat-only.test.js
const assert = require("assert");
const ad = require("../lib/auto-dispatch");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

async function main() {
  check("enabled(): false even when AUTO_DISPATCH=1", () => {
    const prev = process.env.AUTO_DISPATCH;
    try {
      process.env.AUTO_DISPATCH = "1";
      assert.strictEqual(ad.enabled(), false);
    } finally {
      if (prev === undefined) delete process.env.AUTO_DISPATCH;
      else process.env.AUTO_DISPATCH = prev;
    }
  });

  check("setEnabled(true): refused — stays disabled", () => {
    assert.strictEqual(ad.setEnabled(true), false);
    assert.strictEqual(ad.enabled(), false);
    assert.strictEqual(ad.getStatus().enabled, false);
  });

  check("start(): never arms a timer (returns null)", () => {
    assert.strictEqual(ad.start({ port: 0, repoRoot: "." }), null);
  });

  // tick() must be a no-op while disabled: it sets the disabled pause reason and
  // never probes cloud or picks an issue (port 0 would fail loudly if it tried).
  try {
    await ad.tick({ port: 0, repoRoot: "." });
    const st = ad.getStatus();
    assert.strictEqual(st.enabled, false);
    assert.ok(/disabled/i.test(st.pauseReason || ""), `pauseReason=${st.pauseReason}`);
    console.log("  ok  - tick(): no-op — never dispatches while disabled");
  } catch (e) {
    failures++;
    console.error("  FAIL- tick(): no-op — never dispatches while disabled\n      ", e.message);
  }

  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nall autowork chat-only checks passed");
}

main();
