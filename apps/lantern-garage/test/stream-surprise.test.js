// Σ₀ stream-surprise valve (#1678): per-provider logprob capture → tokenSurprise.
// Run: node apps/lantern-garage/test/stream-surprise.test.js
const assert = require("assert");
const ss = require("../lib/stream-surprise");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}
const approx = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const withFlag = (on, fn) => {
  const prev = process.env.SURPRISE_CANARY;
  process.env.SURPRISE_CANARY = on ? "1" : "0";
  try { fn(); } finally { if (prev === undefined) delete process.env.SURPRISE_CANARY; else process.env.SURPRISE_CANARY = prev; }
};

// Sample provider chunks (shapes per OpenAI / Gemini streaming docs).
const openaiEvt = (tok, p) => ({ choices: [{ delta: { content: tok }, logprobs: { content: [{ token: tok, logprob: Math.log(p) }] } }] });
const geminiEvt = (tok, p) => ({ candidates: [{ logprobsResult: { chosenCandidates: [{ token: tok, logProbability: Math.log(p) }] } }] });

check("flag OFF: pushes are no-ops, value()/field() stay null", () => {
  withFlag(false, () => {
    const acc = ss.createSurpriseAccumulator();
    acc.pushOpenAIEvent(openaiEvt("x", 0.5));
    acc.pushGeminiEvent(geminiEvt("y", 0.25));
    assert.strictEqual(acc.count(), 0);
    assert.strictEqual(acc.value(), null);
    assert.strictEqual(acc.field(), null);
  });
});

check("flag OFF: request augmenters return input UNCHANGED (byte-identical default)", () => {
  withFlag(false, () => {
    const body = { model: "m", stream: true };
    assert.strictEqual(ss.withOpenAILogprobs(body), body); // same ref, untouched
    const gc = { maxOutputTokens: 1024 };
    assert.strictEqual(ss.withGeminiLogprobs(gc), gc);
  });
});

check("flag ON: OpenAI logprobs → bits (-log2 p)", () => {
  withFlag(true, () => {
    const acc = ss.createSurpriseAccumulator();
    acc.pushOpenAIEvent(openaiEvt("a", 0.5));   // 1 bit
    acc.pushOpenAIEvent(openaiEvt("b", 0.125)); // 3 bits
    const v = acc.value();
    assert.strictEqual(v.length, 2);
    assert.ok(approx(v[0].bits, 1), `got ${v[0].bits}`);
    assert.ok(approx(v[1].bits, 3), `got ${v[1].bits}`);
    assert.ok(acc.field() && acc.field().nTokens === 2);
  });
});

check("flag ON: Gemini logProbability → bits (-log2 p)", () => {
  withFlag(true, () => {
    const acc = ss.createSurpriseAccumulator();
    acc.pushGeminiEvent(geminiEvt("a", 0.25)); // 2 bits
    const v = acc.value();
    assert.strictEqual(v.length, 1);
    assert.ok(approx(v[0].bits, 2), `got ${v[0].bits}`);
  });
});

check("flag ON: malformed / logprob-less chunks are skipped, not thrown", () => {
  withFlag(true, () => {
    const acc = ss.createSurpriseAccumulator();
    acc.pushOpenAIEvent({ choices: [{ delta: { content: "t" } }] }); // text but no logprobs
    acc.pushOpenAIEvent({}); acc.pushOpenAIEvent(null);
    acc.pushGeminiEvent({ candidates: [{ content: { parts: [{ text: "t" }] } }] });
    acc.pushGeminiEvent(undefined);
    assert.strictEqual(acc.count(), 0);
    assert.strictEqual(acc.value(), null);
  });
});

check("flag ON: augmenters add native logprob requests without dropping fields", () => {
  withFlag(true, () => {
    const out = ss.withOpenAILogprobs({ model: "m", stream: true });
    assert.strictEqual(out.logprobs, true);
    assert.strictEqual(out.model, "m"); assert.strictEqual(out.stream, true);
    const gc = ss.withGeminiLogprobs({ maxOutputTokens: 1024, temperature: 0.7 });
    assert.strictEqual(gc.responseLogprobs, true);
    assert.strictEqual(gc.logprobs, 1);
    assert.strictEqual(gc.maxOutputTokens, 1024);
  });
});

check("reset() clears the accumulator (per-provider-attempt isolation)", () => {
  withFlag(true, () => {
    const acc = ss.createSurpriseAccumulator();
    acc.pushOpenAIEvent(openaiEvt("a", 0.5));
    assert.strictEqual(acc.count(), 1);
    acc.reset();
    assert.strictEqual(acc.count(), 0);
    assert.strictEqual(acc.value(), null);
  });
});

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall stream-surprise checks passed");
