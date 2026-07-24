// Ollama reports failures as {"error":"..."}, not message.content. The chat path used to
// swallow that into a generic no_provider_configured, hiding that the configured
// OLLAMA_MODEL simply isn't installed. classifyOllamaError turns the envelope into an
// honest, actionable lastProviderError.
//
// Run: node test/ollama-error.test.js
const assert = require("assert");
const { classifyOllamaError } = require("../lib/ollama-error");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

check("normal content response → null (not an error)", () => {
  assert.strictEqual(classifyOllamaError({ message: { content: "hi" } }, "llama3.1:8b"), null);
  assert.strictEqual(classifyOllamaError({}, "m"), null);
  assert.strictEqual(classifyOllamaError(null, "m"), null);
});

check("model-not-found (the real Ollama string) → actionable, model-named error", () => {
  const e = classifyOllamaError({ error: "model 'lantern-sigma0-coder-loop' not found" }, "lantern-sigma0-coder-loop");
  assert.strictEqual(e.code, "ollama_model_not_installed");
  assert.strictEqual(e.type, "model_not_installed");
  assert.strictEqual(e.provider, "ollama");
  assert.match(e.message, /lantern-sigma0-coder-loop/);          // names the actual model
  assert.match(e.message, /ollama pull lantern-sigma0-coder-loop/); // gives the exact fix
  assert.match(e.message, /OLLAMA_MODEL/);                        // and the alternative
});

check("other 'no such model' / 'try pulling' phrasings also classify as not-installed", () => {
  for (const raw of ["no such model", "model not found, try pulling it first", "model is not installed"]) {
    const e = classifyOllamaError({ error: raw }, "m");
    assert.strictEqual(e.code, "ollama_model_not_installed", raw);
  }
});

check("a non-missing Ollama error surfaces as a generic ollama_error (still honest)", () => {
  const e = classifyOllamaError({ error: "llama runner process has terminated: exit status 1" }, "m");
  assert.strictEqual(e.code, "ollama_error");
  assert.match(e.message, /Ollama error:/);
  assert.match(e.message, /runner process/);
});

check("shape matches the lastProviderError contract the final error block consumes", () => {
  const e = classifyOllamaError({ error: "model 'x' not found" }, "x");
  for (const k of ["provider", "status", "code", "type", "message"]) assert.ok(k in e, `missing ${k}`);
  assert.strictEqual(e.status, 0); // network-class, not an HTTP status
});

process.stdout.write(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
