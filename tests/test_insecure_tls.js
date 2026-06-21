/**
 * Regression: TLS verification must NOT be disabled unconditionally (#869).
 * The shared gate (lib/insecure-tls.js) is insecure only on Windows or with an
 * explicit LANTERN_INSECURE_TLS=1; on every other platform verification stays ON.
 *
 * Run: node tests/test_insecure_tls.js
 */
const assert = require("assert");
const path = require("path");

const MOD = require.resolve(path.resolve(__dirname, "../apps/lantern-garage/lib/insecure-tls.js"));

function load(env, platform) {
  delete require.cache[MOD];
  const origPlat = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  const old = process.env.LANTERN_INSECURE_TLS;
  if (env === null) delete process.env.LANTERN_INSECURE_TLS; else process.env.LANTERN_INSECURE_TLS = env;
  let m;
  try { m = require(MOD); }
  finally {
    Object.defineProperty(process, "platform", origPlat);
    if (old === undefined) delete process.env.LANTERN_INSECURE_TLS; else process.env.LANTERN_INSECURE_TLS = old;
    delete require.cache[MOD];
  }
  return m;
}

let passed = 0; const ok = (n) => { passed++; console.log("  ✓ " + n); };

assert.strictEqual(load(null, "linux").llmAgent, undefined);
ok("linux, no override → TLS verification ON (agent undefined)");

assert.strictEqual(load("0", "linux").llmAgent, undefined);
ok("linux + LANTERN_INSECURE_TLS=0 → secure");

const li = load("1", "linux");
assert.ok(li.llmAgent && li.llmAgent.options.rejectUnauthorized === false);
ok("linux + LANTERN_INSECURE_TLS=1 → insecure agent (explicit opt-in)");

assert.ok(load(null, "win32").llmAgent, "win32 default insecure agent");
ok("win32 default → insecure agent (the documented #740 Windows workaround)");

assert.strictEqual(load("0", "win32").llmAgent, undefined);
ok("win32 + LANTERN_INSECURE_TLS=0 → secure (force-off honored)");

console.log(`\nAll ${passed} insecure-tls gate assertions passed.`);
