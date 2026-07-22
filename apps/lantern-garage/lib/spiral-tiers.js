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

const http = require("http");
const { verifyExecAsync } = require("./exec-verify");
const verifyLLM = require("./verify-llm");

// Direct Ollama /api/generate for a SPECIFIC model. The spiral's local tier resolves its
// model from the constraint-aware registry (selectCheapStandin), NOT the raw OLLAMA_MODEL
// env — which on this box pins `ouro:latest`, a model served only by the separate
// ouro_serve.py shim, so a plain-daemon call to it 404s. This is the "fix the local
// Ollama" seam: "ollama" means the registry's real local coder, whatever is pulled.
function ollamaComplete(model, { baseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434", timeoutMs = 120000 } = {}) {
  return (prompt, maxTokens = 700) =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify({ model, prompt, stream: false, options: { temperature: 0, num_predict: maxTokens } });
      let u;
      try { u = new URL(baseUrl); } catch { return reject(new Error("bad OLLAMA_BASE_URL")); }
      const req = http.request(
        { hostname: u.hostname, port: u.port || 11434, path: "/api/generate", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: timeoutMs },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => {
            try {
              const j = JSON.parse(d);
              if (j.error) return reject(new Error(`ollama: ${j.error}`));
              resolve(String(j.response || ""));
            } catch { reject(new Error("ollama parse: " + d.slice(0, 120))); }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("ollama timeout")));
      req.write(body);
      req.end();
    });
}

// The local coder the spiral cheap tier should use, resolved by our hardware constraints
// via the registry — never the ouro:latest OLLAMA_MODEL pin. Env override SPIRAL_LOCAL_MODEL.
function resolveLocalModel(opts = {}) {
  if (process.env.SPIRAL_LOCAL_MODEL) return process.env.SPIRAL_LOCAL_MODEL;
  try {
    const stand = require("./local-model-registry").selectCheapStandin({ taskType: "coding", ...opts });
    if (stand && stand.id && !/^ouro/i.test(stand.id)) return stand.id;
  } catch { /* registry unavailable → sane default below */ }
  return "qwen2.5-coder:latest"; // the verified on-box coder (#2173), always pulled
}

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
function makeVerifier({ language = "js", tests, entryPoint = null, timeoutMs = 10000 } = {}) {
  const list = Array.isArray(tests) ? tests : tests ? [{ name: "check", test: tests }] : [];
  // Name-tolerance shim: models frequently rename a snake_case entry point to camelCase
  // (e.g. `word_break` → `wordBreak`), which makes an exact-name test throw ReferenceError
  // even when the algorithm is correct — a real defect `spiral_solve` hits too, not just eval
  // noise. If an entryPoint is given, alias a camelCase variant back to it so the test resolves.
  const alias = _aliasShim(language, entryPoint);
  return async function verify(code) {
    // Run tests concurrently (each is its own isolated subprocess) — bounded by the
    // small suite size; keeps a multi-test turn from serializing 10s timeouts.
    return Promise.all(
      list.map(async (t, i) => {
        const r = await verifyExecAsync({ language, code: code + alias, test: t.test, timeoutMs });
        return { name: t.name || `t${i}`, passed: !!(r.ran && r.passed), ran: !!r.ran, output: r.passed ? "" : String(r.output || "") };
      }),
    );
  };
}

// Bind a camelCase variant of a snake_case entry point back to the exact name so an
// exact-name test resolves even when the model renamed the function. JS only (the observed
// case); Python convention already matches snake_case so no shim is needed there.
function _aliasShim(language, entryPoint) {
  if (!entryPoint) return "";
  if (language === "python") {
    // If the exact name isn't defined but exactly one top-level function is, alias it — a
    // correct solution named slightly differently still counts (MBPP names are arbitrary).
    return `\ntry:\n    ${entryPoint}\nexcept NameError:\n    import types as _t\n    _fns=[v for k,v in list(globals().items()) if isinstance(v,_t.FunctionType) and not k.startswith('_')]\n    if len(_fns)==1:\n        globals()['${entryPoint}']=_fns[0]\n`;
  }
  if (language !== "js" || !/_/.test(entryPoint)) return "";
  const camel = entryPoint.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
  if (camel === entryPoint) return "";
  return `\n;try{ if (typeof ${entryPoint} === 'undefined' && typeof ${camel} !== 'undefined') globalThis.${entryPoint} = ${camel}; }catch(e){}\n`;
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
async function _defaultComplete(provider, prompt, maxTokens = 700, model = null) {
  if (provider === "ollama") {
    // The local cheap tier — a real pulled coder via the registry, NOT the ouro:latest pin.
    const m = model || resolveLocalModel();
    try {
      const t = await ollamaComplete(m)(prompt, maxTokens);
      if (t && t.trim()) return t.trim();
    } catch { /* daemon down / model missing → fall through to a cloud leg */ }
  }
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
    `You are the ${tier} tier of a verified spiral solving ONE problem. Reply with ONLY the implementation as a single ${language} code block — no prose. Define the function with EXACTLY the name and signature given in the problem; do NOT rename it (keep snake_case as written — do not camelCase it).`,
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
function makeTiers({ complete = _defaultComplete, cheapProvider = "ollama", frontierProvider = "anthropic", cheapModel = null, frontierModel = null, language = "js", maxTokens = 700 } = {}) {
  const label = (p, m) => `${p}${m ? ":" + m : ""}`;
  return {
    async cheap(ctx) {
      const text = await complete(cheapProvider, _prompt(ctx, "cheap", language), maxTokens, cheapModel);
      return { text: extractCode(text, language), model: `cheap:${label(cheapProvider, cheapModel)}`, cost: 0 };
    },
    async escalate(ctx) {
      const text = await complete(frontierProvider, _prompt(ctx, "frontier", language), maxTokens, frontierModel);
      return { text: extractCode(text, language), model: `frontier:${label(frontierProvider, frontierModel)}`, cost: 0 };
    },
  };
}

module.exports = { extractCode, makeVerifier, makeTiers, ollamaComplete, resolveLocalModel, _legFor, _defaultComplete };
