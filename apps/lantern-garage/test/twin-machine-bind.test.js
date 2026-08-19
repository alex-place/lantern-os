"use strict";
// The real-model binding for the twin machine — with the transport STUBBED, so this pins the
// parser and the fail-closed behaviour without a network. Live behaviour is exercised by
// experiments/twin_machine_live.js, which needs a provider and records what it saw.
//
// Run: node apps/lantern-garage/test/twin-machine-bind.test.js
const assert = require("assert");
const bind = require("../lib/twin-machine-bind");

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

(async () => {
  await check("B's reply parses into a number, a resolvability, a reason and a probe", () => {
    const p = bind._parseB(`WAYS_WRONG: the date could be off; the source may be stale
RESOLVABLE: YES
PROBE: check the primary source
P_WRONG: 0.35`);
    assert.strictEqual(p.pWrong, 0.35);
    assert.strictEqual(p.canResolve, true);
    assert.match(p.reason, /date could be off/);
    assert.strictEqual(p.probe.question, "check the primary source");
  });

  await check("UNREACHABLE parses to canResolve=false (the pin path)", () => {
    const p = bind._parseB("WAYS_WRONG: unknowable\nRESOLVABLE: UNREACHABLE\nPROBE: NONE\nP_WRONG: 0.6");
    assert.strictEqual(p.canResolve, false);
    assert.strictEqual(p.probe, null);
  });

  await check("no P_WRONG -> no parse -> B FAILS CLOSED in the machine (nothing passes)", async () => {
    bind._setTransport(async (prompt) => ({
      text: prompt.startsWith("Answer the question") ? "Paris." : "I think it's fine, honestly.",   // B rambles, no number
      provider: "stub",
    }));
    const m = bind.bind({ freshnessEvery: 0 });
    const r = await m.run({ id: 0, text: "capital of France?" });
    assert.strictEqual(r.kind, "halt", "an auditor that gives no number must not let the answer through");
    assert.strictEqual(r.answer, null);
    assert.match(r.b.reason, /no parseable P_WRONG/);
  });

  await check("A's confident tone does NOT reach B as a weight — B's prompt never asks for A's confidence", () => {
    const bp = bind.B_PROMPT("q", "I am ABSOLUTELY CERTAIN it is X.");
    assert.ok(/tone is not evidence/i.test(bp), "the gloss-trap guard must be in the prompt");
    assert.ok(!/how confident/i.test(bp.replace(/Ignore how confident/i, "")), "B is never asked how confident A is");
  });

  await check("end-to-end with a stubbed transport: pass when B says low, halt when B says high", async () => {
    let bSays = 0.1;
    bind._setTransport(async (prompt) => ({
      text: prompt.startsWith("Answer the question") ? "42" :
        `WAYS_WRONG: none material\nRESOLVABLE: YES\nPROBE: NONE\nP_WRONG: ${bSays}`,
      provider: "stub",
    }));
    const m = bind.bind({ freshnessEvery: 0 });
    const r1 = await m.run({ id: 0, text: "q" });
    assert.strictEqual(r1.kind, "pass"); assert.strictEqual(r1.answer.text, "42");
    bSays = 0.9;
    const r2 = await m.run({ id: 1, text: "q" });
    assert.strictEqual(r2.kind, "halt"); assert.strictEqual(r2.answer, null);
  });

  console.log(failures ? `\n${failures} FAILED` : "\nall twin-machine-bind tests passed");
  process.exit(failures ? 1 : 0);
})();
