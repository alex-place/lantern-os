// Σ₀ ADR-0017 surprise-gated decoding: intervention controller unit tests.
// Run: node apps/lantern-garage/test/surprise-intervene.test.js
const assert = require("assert");
const si = require("../lib/surprise-intervene");

let failures = 0;
function check(name, fn) {
  const p = Promise.resolve()
    .then(fn)
    .then(() => console.log("  ok  -", name))
    .catch((e) => { failures++; console.error("  FAIL-", name, "\n      ", e.message); });
  chain = chain.then(() => p);
}
let chain = Promise.resolve();

const withFlag = async (on, fn) => {
  const prev = process.env.SURPRISE_INTERVENE;
  process.env.SURPRISE_INTERVENE = on ? "1" : "0";
  try { await fn(); } finally { if (prev === undefined) delete process.env.SURPRISE_INTERVENE; else process.env.SURPRISE_INTERVENE = prev; }
};

const tok = (t, bits) => ({ token: t, bits });
const flat = (n, bits, t = "x ") => Array.from({ length: n }, () => tok(t, bits));

// ── flag gating ──────────────────────────────────────────────────────────────
check("disabled by default → maybeIntervene is a no-op", async () => {
  await withFlag(false, async () => {
    const r = await si.maybeIntervene({ perToken: flat(64, 9), fullReply: "text", callLLM: async () => "revised" });
    assert.strictEqual(r.intervened, false);
    assert.strictEqual(r.revisedReply, null);
  });
});

// ── trigger scan ─────────────────────────────────────────────────────────────
check("no trigger below threshold", () => {
  assert.deepStrictEqual(si.findTriggerSpans(flat(64, 2), { thresholdBits: 5, window: 16, maxRounds: 2 }), []);
});
check("trigger on a high-surprise window; non-overlapping; capped at maxRounds", () => {
  const toks = [...flat(20, 1), ...flat(16, 8, "A"), ...flat(20, 1), ...flat(16, 7, "B"), ...flat(16, 9, "C")];
  const spans = si.findTriggerSpans(toks, { thresholdBits: 5, window: 16, maxRounds: 2 });
  assert.strictEqual(spans.length, 2);
  assert.ok(spans[0].meanBits >= spans[1].meanBits, "sorted by mean desc");
  for (const s of spans) assert.ok(s.meanBits >= 5);
});
check("short replies (< window) never trigger", () => {
  assert.deepStrictEqual(si.findTriggerSpans(flat(8, 99), { window: 16 }), []);
});

// ── classifier + arm order ───────────────────────────────────────────────────
check("classifier: arithmetic → computable; entities/years → factual; prose → none", () => {
  assert.strictEqual(si.classifySpan("the total is 17 * 23 dollars"), "computable");
  assert.strictEqual(si.classifySpan("Marie Curie won in 1903"), "factual");
  assert.strictEqual(si.classifySpan("it felt like a warm dream"), "none");
});
check("arm order per class", () => {
  assert.deepStrictEqual(si.armOrder("computable"), ["memory", "tool", "web"]);
  assert.deepStrictEqual(si.armOrder("factual"), ["memory", "web"]);
  assert.deepStrictEqual(si.armOrder("none"), ["memory"]);
});

// ── safe arithmetic tool arm ─────────────────────────────────────────────────
check("safe arith evaluates binary expressions, rejects division by zero", () => {
  assert.strictEqual(si._safeArith("17 * 23"), 391);
  assert.strictEqual(si._safeArith("10 / 4"), 2.5);
  assert.strictEqual(si._safeArith("5 / 0"), null);
  assert.strictEqual(si._safeArith("2 ^ 10"), 1024);
});

// ── grounding arbitration with injected arms ─────────────────────────────────
check("memory hit wins before web", async () => {
  const g = await si.groundSpan({ text: "Marie Curie won in 1903" }, {
    arms: {
      memory: async () => ({ arm: "memory", ok: true, evidence: "KC says 1903", confidence: 0.9, source: "kc:x" }),
      web: async () => { throw new Error("should not be called"); },
    },
  });
  assert.strictEqual(g.arm, "memory");
});
check("memory miss falls through to web for factual spans", async () => {
  const g = await si.groundSpan({ text: "Marie Curie won in 1903" }, {
    arms: {
      memory: async () => null,
      web: async () => ({ arm: "web", ok: true, evidence: "web says 1903", confidence: 0.7, source: "web-search" }),
    },
  });
  assert.strictEqual(g.arm, "web");
});
check("arm deadline → falls through instead of hanging", async () => {
  process.env.SURPRISE_INTERVENE_ARM_MS = "50";
  try {
    const g = await si.groundSpan({ text: "Marie Curie won in 1903" }, {
      arms: {
        memory: () => new Promise(() => {}), // hangs — deadline must cut it
        web: async () => ({ arm: "web", ok: true, evidence: "e", confidence: 0.7, source: "web-search" }),
      },
    });
    assert.strictEqual(g.arm, "web");
  } finally { delete process.env.SURPRISE_INTERVENE_ARM_MS; }
});
check("computable span uses built-in tool arm (verified, confidence 1.0)", async () => {
  const g = await si.groundSpan({ text: "so 17 * 23 = 400 obviously" }, {
    arms: { memory: async () => null, web: async () => { throw new Error("no web"); } },
  });
  assert.strictEqual(g.arm, "tool");
  assert.strictEqual(g.confidence, 1.0);
  assert.ok(g.evidence.includes("391"));
});

// ── end-to-end post-hoc intervention (stubbed LLM) ───────────────────────────
check("intervene: trigger + grounding + revise replaces reply", async () => {
  await withFlag(true, async () => {
    const toks = [...flat(20, 1), tok("17", 9), tok(" *", 9), tok(" 23", 9), tok(" =", 9), tok(" 400", 9), ...flat(11, 9)];
    const draft = "The product of 17 * 23 = 400, a well-known fact.";
    const r = await si.maybeIntervene({
      perToken: toks, fullReply: draft,
      arms: { memory: async () => null, web: async () => null },
      callLLM: async (prompt) => {
        assert.ok(prompt.includes("EVIDENCE"), "revise prompt carries evidence");
        assert.ok(prompt.includes("391"), "tool result present");
        return "The product of 17 * 23 = 391 [E1], a well-known fact.";
      },
    });
    assert.strictEqual(r.intervened, true);
    assert.ok(r.revisedReply.includes("391"));
    assert.ok(r.rounds.length >= 1 && r.rounds[0].grounded);
  });
});
check("intervene: revise failure or shrunken output → original kept (revisedReply null)", async () => {
  await withFlag(true, async () => {
    const toks = [tok("17", 9), tok("*", 9), tok("23", 9), ...flat(13, 9)];
    const r = await si.maybeIntervene({
      perToken: toks, fullReply: "x".repeat(200) + " 17*23 ",
      arms: { memory: async () => null, web: async () => null },
      callLLM: async () => "tiny",
    });
    assert.strictEqual(r.intervened, true);
    assert.strictEqual(r.revisedReply, null);
  });
});
check("intervene: no grounding found → no revise call, original kept", async () => {
  await withFlag(true, async () => {
    process.env.SURPRISE_INTERVENE_ARM_MS = "100";
    try {
      const toks = flat(24, 9, "dream ");
      let called = false;
      const r = await si.maybeIntervene({
        perToken: toks, fullReply: "a dreamy passage with no facts at all",
        arms: { memory: async () => null, web: async () => null },
        callLLM: async () => { called = true; return "nope"; },
      });
      assert.strictEqual(called, false, "revise must not fire without evidence");
      assert.strictEqual(r.revisedReply, null);
    } finally { delete process.env.SURPRISE_INTERVENE_ARM_MS; }
  });
});

chain.then(() => {
  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
  console.log("\nall surprise-intervene tests passed");
});
