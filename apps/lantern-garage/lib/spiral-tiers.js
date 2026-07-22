"use strict";

/**
 * Spiral tiers + verifier adapter (ADR-0030).
 *
 * The bridge between the pure spiral loop (lib/spiral-harness.js) and the real world:
 *   - makeVerifier: the M4 Fix-Rate verifier backed by the REAL bounded exec sandbox
 *     (lib/exec-verify.js verifyExecAsync — non-blocking so it never freezes the
 *     server event loop). Runs each provided test; a list of named tests yields a
 *     per-test Fix Rate, a single test yields a coarse pass/fail. This is the honest
 *     Verify stage — a real test decides, not the model's opinion.
 *   - makeTiers: the cheap + escalate tiers. Each calls an injected `complete(provider,
 *     prompt)` and extracts the code. The default `complete` routes through the SAME
 *     implemented provider legs as the Verify-pass caller (lib/verify-llm.js
 *     buildLegs) — no re-entry into the chat tool loop (no recursion), and swappable
 *     for tests. Cheap defaults to the local/owned standin ('ollama'); escalate to a
 *     rented frontier ('anthropic').
 *
 * Everything crossing the model/exec boundary is injectable, so this whole path is
 * unit-testable with a stub transport + real (tiny) JS exec, no server or GPU.
 */

const { verifyExecAsync } = require("./exec-verify");
const verifyLLM = require("./verify-llm");

/**
 * Extract the implementation from a model reply: prefer a fenced code block, else
 * take the whole text (the model may have answered with bare code).
 */
function extractCode(text, language = "js") {
  const s = String(text || "");
  const langs = language === "python" ? "python|py" : "javascript|js|jsx";
  const fenced = s.match(new RegExp("```(?:" + langs + ")?\\s*([\\s\\S]*?)```", "i"));
  if (fenced) return fenced[1].trim();
  const anyFence = s.match(/```\s*([\s\S]*?)```/);
  return (anyFence ? anyFence[1] : s).trim();
}

/**
 * Build the Fix-Rate verifier from a problem's tests. Each test is a snippet that
 * THROWS / exits non-zero on failure (the HumanEval `check(candidate)` contract).
 *
 * @param {object} opts
 *   language  "js" | "python"
 *   tests     Array<{name?, test}> | string  (a bare string → a single "check" test)
 *   timeoutMs per-test bound (default 10000)
 * @returns {function(code):Promise<Array<{name,passed,ran,output}>>}
 *   a results array the harness scores with fixRate(before, results).
 */
function makeVerifier({ language = "js", tests, timeoutMs = 10000 } = {}) {
  const list = Array.isArray(tests) ? tests : tests ? [{ name: "check", test: tests }] : [];
  return async function verify(code) {
    // Run tests concurrently (each is its own isolated subprocess) — bounded by the
    // small suite size; keeps a multi-test turn from serializing 10s timeouts.
    return Promise.all(
      list.map(async (t, i) => {
        const r = await verifyExecAsync({ language, code, test: t.test, timeoutMs });
        return { name: t.name || `t${i}`, passed: !!(r.ran && r.passed), ran: !!r.ran, output: r.passed ? "" : String(r.output || "") };
      }),
    );
  };
}

/** A single provider leg (by name) from verify-llm's implemented set, or null. */
function _legFor(provider) {
  const leg = verifyLLM.buildLegs().find((l) => l.provider === provider) || null;
  return leg ? (prompt, maxTokens) => leg.call(prompt, maxTokens) : null;
}

/**
 * Default completion: use the requested provider's leg; if that provider isn't
 * configured, fall back to the first reachable leg (callVerifyModel) so a missing
 * cheap/frontier key DEGRADES (still answers) rather than breaks.
 */
async function _defaultComplete(provider, prompt, maxTokens = 700) {
  const leg = _legFor(provider);
  if (leg) {
    try {
      const t = await leg(prompt, maxTokens);
      if (t && t.trim()) return t.trim();
    } catch { /* provider down → fall through to any reachable one */ }
  }
  const r = await verifyLLM.callVerifyModel(prompt, { maxTokens });
  return r ? r.text : "";
}

/** The still-failing signal from the last committed step, fed back to the next turn. */
function _failingHint(ctx) {
  const last = ctx.memory && ctx.memory.length ? ctx.memory[ctx.memory.length - 1] : null;
  if (!last || !Array.isArray(last.results)) return "";
  return last.results
    .filter((r) => !r.passed)
    .slice(0, 4)
    .map((r) => `- ${r.name}: ${String(r.output || "").split("\n")[0]}`)
    .join("\n");
}

function _prompt(ctx, tier, language) {
  const failing = _failingHint(ctx);
  return [
    `You are the ${tier} tier of a verified spiral solving ONE problem. Reply with ONLY the implementation as a single ${language} code block — no prose.`,
    ctx.problem.prompt,
    ctx.y ? `\nCurrent best attempt (improve it; KEEP whatever already passes):\n${ctx.y}` : "",
    failing ? `\nFocus "${ctx.focus}". Still-failing tests:\n${failing}` : `\nFocus: ${ctx.focus}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Build { cheap, escalate } tiers for runSpiral.
 *
 * @param {object} opts
 *   complete(provider, prompt, maxTokens)  injected; default routes via verify-llm legs
 *   cheapProvider     default "ollama" (owned/local standin)
 *   frontierProvider  default "anthropic" (rented frontier)
 *   language          "js" | "python"
 *   maxTokens         per-call cap (default 700)
 */
function makeTiers({ complete = _defaultComplete, cheapProvider = "ollama", frontierProvider = "anthropic", language = "js", maxTokens = 700 } = {}) {
  return {
    async cheap(ctx) {
      const text = await complete(cheapProvider, _prompt(ctx, "cheap", language), maxTokens);
      return { text: extractCode(text, language), model: `cheap:${cheapProvider}`, cost: 0 };
    },
    async escalate(ctx) {
      const text = await complete(frontierProvider, _prompt(ctx, "frontier", language), maxTokens);
      return { text: extractCode(text, language), model: `frontier:${frontierProvider}`, cost: 0 };
    },
  };
}

module.exports = { extractCode, makeVerifier, makeTiers, _legFor, _defaultComplete };
