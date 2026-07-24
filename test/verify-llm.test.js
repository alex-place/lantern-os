// Σ₀ verify-pass provider fallback — dream-chat.verifyResponse must survive any
// single provider being down, and must SAY SO (skipped:"no_provider") when none
// is reachable rather than faking a clean zero-claims pass.
//
// Regression for the 2026-07-03 eval: with a credit-depleted Anthropic key every
// reply came back sigma0={claims:0} — including replies that fabricated a
// nonexistent file summary and invented five nonexistent exports — because the
// verify pass no-op'd the instant ANTHROPIC_API_KEY was absent and only ever
// called api.anthropic.com.
//
// Hermetic: the single HTTP transport in lib/verify-llm.js is swapped for a fake
// (_setVerifyTransport), and web-search-client is stubbed via require.cache so the
// grounding legs never hit the network. No real provider keys are used.
//
// Run: node test/verify-llm.test.js
"use strict";
const assert = require("assert");

const verifyLlm = require("../lib/verify-llm");
const dreamChat = require("../lib/dream-chat");

// ── web-search-client stub (for the in-function require inside verifyResponse) ──
const wscPath = require.resolve("../lib/web-search-client");
const realWsc = require.cache[wscPath]; // populated by the dream-chat require above
function stubWebSearch() {
  require.cache[wscPath] = {
    id: wscPath, filename: wscPath, loaded: true, children: [],
    exports: { webSearchMcp: async () => ({ success: false, results: [] }) },
  };
}
function restoreWebSearch() {
  if (realWsc) require.cache[wscPath] = realWsc; else delete require.cache[wscPath];
}

// ── env isolation ──────────────────────────────────────────────────────────
const ENV_KEYS = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
  "XAI_API_KEY", "VERIFY_USE_OLLAMA", "SIGMA0_VERIFY", "OLLAMA_BASE_URL",
];
const savedEnv = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
function setEnv(obj) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, obj);
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", (e && e.stack) || e); }
}

// Build a fake transport that maps hostname → response (or a thrown error).
function fakeTransport(routes, spy) {
  return async (opts) => {
    if (spy) spy.push(opts.hostname);
    const r = routes[opts.hostname];
    if (r === undefined) throw new Error("unexpected host " + opts.hostname);
    if (r instanceof Error) throw r;
    return r;
  };
}
function okJson(obj) { return { status: 200, body: JSON.stringify(obj) }; }
const openaiSays = (text) => okJson({ choices: [{ message: { content: text } }] });
const anthropicDepleted = { status: 402, body: '{"type":"error","error":{"type":"invalid_request_error"}}' };

async function main() {
  try {
    // ── buildLegs gating (pure) ──────────────────────────────────────────────
    await check("buildLegs: includes only providers with a key; ollama is the default backstop", () => {
      assert.deepStrictEqual(
        verifyLlm.buildLegs({ OPENAI_API_KEY: "x", VERIFY_USE_OLLAMA: "0" }).map((l) => l.provider),
        ["openai"]);
      assert.deepStrictEqual(
        verifyLlm.buildLegs({ ANTHROPIC_API_KEY: "a", XAI_API_KEY: "x", VERIFY_USE_OLLAMA: "0" }).map((l) => l.provider),
        ["anthropic", "xai"], "cloud legs keep chain order");
      assert.deepStrictEqual(
        verifyLlm.buildLegs({ GEMINI_API_KEY: "g" }).map((l) => l.provider),
        ["gemini", "ollama"], "ollama trails as the offline backstop");
      assert.deepStrictEqual(
        verifyLlm.buildLegs({}).map((l) => l.provider),
        ["ollama"], "no cloud keys → ollama-only candidate");
      assert.deepStrictEqual(
        verifyLlm.buildLegs({ VERIFY_USE_OLLAMA: "off" }).map((l) => l.provider),
        [], "kill-switch removes the ollama backstop too");
    });

    // ── callVerifyModel fallback (the core fix) ──────────────────────────────
    await check("callVerifyModel: Anthropic dead (402) → falls back to OpenAI", async () => {
      setEnv({ ANTHROPIC_API_KEY: "dead", OPENAI_API_KEY: "live", VERIFY_USE_OLLAMA: "0" });
      const calls = [];
      verifyLlm._setVerifyTransport(fakeTransport({
        "api.anthropic.com": anthropicDepleted,
        "api.openai.com": openaiSays("hello from openai"),
      }, calls));
      const r = await verifyLlm.callVerifyModel("extract claims");
      assert.ok(r, "expected a non-null result");
      assert.strictEqual(r.provider, "openai", "the live provider produced the answer");
      assert.strictEqual(r.text, "hello from openai");
      assert.deepStrictEqual(calls, ["api.anthropic.com", "api.openai.com"], "tried anthropic first, then fell back");
    });

    await check("callVerifyModel: every provider down → null (no silent success)", async () => {
      setEnv({ ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y", VERIFY_USE_OLLAMA: "0" });
      verifyLlm._setVerifyTransport(async () => { throw new Error("ECONNREFUSED"); });
      const r = await verifyLlm.callVerifyModel("extract claims");
      assert.strictEqual(r, null, "null is the 'no provider reachable' signal");
    });

    // ── verifyResponse end-to-end: extraction survives Anthropic being down ──
    await check("verifyResponse: extracts claims with Anthropic mocked dead, OpenAI alive", async () => {
      setEnv({ ANTHROPIC_API_KEY: "dead", OPENAI_API_KEY: "live", VERIFY_USE_OLLAMA: "0", SIGMA0_VERIFY: "true" });
      stubWebSearch();
      const calls = [];
      // A claim whose words are all ≤4 chars → the codebase-grep term filter yields
      // nothing → no git subprocess; web (stubbed) + gemini (no key) give no signal.
      const claimsJson = JSON.stringify([{ claim: "abcd efg hij", type: "fact", needsWeb: false }]);
      verifyLlm._setVerifyTransport(fakeTransport({
        "api.anthropic.com": anthropicDepleted,
        "api.openai.com": openaiSays(claimsJson),
      }, calls));
      try {
        const res = await dreamChat.verifyResponse("A drafted reply making one claim.", "a user question", "keystone");
        assert.ok(!res.skipped, "must NOT be skipped — a provider answered");
        assert.strictEqual(res.records.length, 1, "one claim extracted + grounded despite Anthropic being down");
        assert.ok(
          calls.includes("api.anthropic.com") && calls.includes("api.openai.com"),
          "extraction fell back from anthropic to openai");
      } finally {
        restoreWebSearch();
      }
    });

    // ── verifyResponse end-to-end: visible skip when nothing is reachable ────
    await check("verifyResponse: skipped='no_provider' when every provider is down", async () => {
      setEnv({ ANTHROPIC_API_KEY: "dead", OPENAI_API_KEY: "dead", VERIFY_USE_OLLAMA: "0", SIGMA0_VERIFY: "true" });
      verifyLlm._setVerifyTransport(async () => { throw new Error("ECONNREFUSED"); });
      const res = await dreamChat.verifyResponse("A reply that fabricates a nonexistent file summary.", "a user question", "keystone");
      assert.strictEqual(res.skipped, "no_provider", "verification never ran → visible flag, not a silent pass");
      assert.strictEqual(res.records.length, 0, "no claims — because nothing could extract them");
      assert.strictEqual(res.corrected, false);
    });
  } finally {
    verifyLlm._resetVerifyTransport();
    restoreWebSearch();
    restoreEnv();
  }

  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nall verify-llm + verifyResponse provider-fallback checks passed");
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
