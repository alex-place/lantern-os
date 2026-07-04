/**
 * test/chat-provider-error-surfacing.test.js
 *
 * Verify stage — honest failure surfacing. The non-stream chat dispatch used to
 * JSON.parse a provider's HTTP-400 error envelope, find no content, resolve("")
 * and fall through with ZERO logging — so a depleted Anthropic key surfaced to the
 * client as a blanket 503 "no_provider_configured" and /api/providers/status still
 * read "ok". These tests pin that shut:
 *   1. parseUpstreamProviderError() extracts { status, code, type, message } from
 *      each provider's envelope shape (+ non-JSON bodies).
 *   2. A pinned Anthropic call whose upstream returns 400 now returns reply:null with
 *      error="anthropic_status_400" + errorDetail (the real "credit balance" message),
 *      records the failure to the provider-router, and logs the status.
 *   3. _computeDispatchHealth() reads a present-but-failing key as "failing", not "ok".
 *
 * Run: node apps/lantern-garage/test/chat-provider-error-surfacing.test.js
 */
const assert = require("assert");
const { EventEmitter } = require("events");
const https = require("https");

// Hard stop so a wiring regression can never hang CI.
const _hardTimer = setTimeout(() => { console.error("TIMEOUT — test hung"); process.exit(1); }, 15000);

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n       ", e && e.message); }
}

// ── 1. Pure envelope parser ──────────────────────────────────────────────────
const { parseUpstreamProviderError } = require("../lib/dream-chat");

(async () => {
  await check("anthropic credit-depleted 400 → typed record with the real message", () => {
    const body = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } });
    const r = parseUpstreamProviderError("anthropic", 400, body);
    assert.strictEqual(r.provider, "anthropic");
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.code, "anthropic_status_400");
    assert.strictEqual(r.type, "invalid_request_error");
    assert.ok(/credit balance is too low/.test(r.message), `message: ${r.message}`);
  });

  await check("openai 401 envelope → message + type", () => {
    const r = parseUpstreamProviderError("openai", 401, JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }));
    assert.strictEqual(r.code, "openai_status_401");
    assert.strictEqual(r.type, "invalid_request_error");
    assert.ok(/Incorrect API key/.test(r.message));
  });

  await check("gemini 400 envelope → type falls back to .status", () => {
    const r = parseUpstreamProviderError("gemini", 400, JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }));
    assert.strictEqual(r.type, "INVALID_ARGUMENT");
    assert.ok(/API key not valid/.test(r.message));
  });

  await check("xai {error:'...'} string form → message", () => {
    const r = parseUpstreamProviderError("xai", 403, JSON.stringify({ error: "The team has been blocked." }));
    assert.strictEqual(r.code, "xai_status_403");
    assert.ok(/team has been blocked/.test(r.message));
  });

  await check("non-JSON body → falls back to raw text + http_<code> type", () => {
    const r = parseUpstreamProviderError("anthropic", 502, "<html>502 Bad Gateway</html>");
    assert.strictEqual(r.type, "http_502");
    assert.ok(/Bad Gateway/.test(r.message));
  });

  // ── 2. Integration: pinned Anthropic upstream 400 no longer silently swallowed ──
  await check("pinned anthropic 400 → reply:null + real error surfaced + failure recorded", async () => {
    // Isolate to anthropic: only its key present, others removed so nothing else runs.
    const saved = {};
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY", "GEMINI_USE_VERTEX", "VERTEX_PROJECT", "OLLAMA_MODEL"]) {
      saved[k] = process.env[k]; delete process.env[k];
    }
    process.env.ANTHROPIC_API_KEY = "sk-test"; // fake, deliberately short (secrets gate)

    const creditBody = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } });
    const origRequest = https.request;
    https.request = function (opts, cb) {
      const req = new EventEmitter();
      req.setTimeout = () => req; req.write = () => {}; req.destroy = () => {};
      req.end = () => {
        const res = new EventEmitter();
        const host = (opts && opts.hostname) || "";
        res.statusCode = host === "api.anthropic.com" ? 400 : 200;
        const payload = host === "api.anthropic.com" ? creditBody : "{}";
        cb(res); // attach handlers first, then deliver
        setImmediate(() => { res.emit("data", Buffer.from(payload)); res.emit("end"); });
      };
      return req;
    };

    const errs = [];
    const origErr = console.error;
    console.error = (...a) => { errs.push(a.map(String).join(" ")); };

    let result;
    try {
      const { dreamChatReply } = require("../lib/dream-chat");
      result = await dreamChatReply("hello", [], "", "anthropic");
    } finally {
      https.request = origRequest;
      console.error = origErr;
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }

    // The whole point: NOT a bare no_provider_configured, and reply is null.
    assert.strictEqual(result.reply, null, "reply should be null on a failed provider");
    assert.strictEqual(result.error, "anthropic_status_400", `error was: ${result.error}`);
    assert.ok(result.errorDetail, "errorDetail should be threaded through");
    assert.strictEqual(result.errorDetail.provider, "anthropic");
    assert.strictEqual(result.errorDetail.status, 400);
    assert.ok(/credit balance is too low/.test(result.errorDetail.message), `errorDetail.message: ${result.errorDetail.message}`);
    // (a) it logged the status+type instead of staying silent
    assert.ok(errs.some((l) => /status=400/.test(l)), `expected a console.error with status=400; got:\n${errs.join("\n")}`);
    // (b) it recorded the failure to the provider-router (so status can surface it)
    const { getProviderStatus } = require("../lib/provider-router");
    assert.strictEqual(getProviderStatus().anthropic.lastError, "anthropic_status_400");
  });

  // ── 3. Provider-status health verdict: presence is not validity ───────────────
  const { _computeDispatchHealth } = require("../routes/providers");
  const NOW = 1_000_000;

  await check("present key whose last dispatch FAILED reads as 'failing' (+ lastError)", () => {
    const d = _computeDispatchHealth({ lastFailure: NOW, lastSuccess: 0, lastError: "anthropic_status_400", consecutiveFailures: 1 }, true, NOW + 10);
    assert.strictEqual(d.health, "failing");
    assert.strictEqual(d.healthy, false);
    assert.strictEqual(d.lastError, "anthropic_status_400");
  });

  await check("a later success flips it back to 'ok'", () => {
    const d = _computeDispatchHealth({ lastFailure: NOW, lastSuccess: NOW + 5 }, true, NOW + 10);
    assert.strictEqual(d.health, "ok");
    assert.strictEqual(d.healthy, true);
  });

  await check("key present but never dispatched → 'untested' (optimistically usable)", () => {
    const d = _computeDispatchHealth(undefined, true, NOW);
    assert.strictEqual(d.health, "untested");
    assert.strictEqual(d.healthy, true);
  });

  await check("no key in process env → 'no_key'", () => {
    const d = _computeDispatchHealth({ lastSuccess: NOW }, false, NOW + 10);
    assert.strictEqual(d.health, "no_key");
  });

  await check("blocked-until in the future (rate limit) → 'blocked'", () => {
    const d = _computeDispatchHealth({ lastSuccess: NOW, blockedUntil: NOW + 60000 }, true, NOW + 10);
    assert.strictEqual(d.health, "blocked");
    assert.strictEqual(d.healthy, false);
  });

  clearTimeout(_hardTimer);
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
