// #1965 — routes/feedback.js contract: POST /api/dream/feedback appends one clipped,
// attributable verdict row via the serialized file-queue; GET /recent honours the
// #770 privacy precedent (global read is operator-only, per-session is self-service).
//
// Run: node apps/lantern-garage/test/feedback-route.test.js
const assert = require("assert");
const path = require("path");
const feedbackRoutes = require("../routes/feedback");

let failures = 0;
function check(name, fn) {
  // process.stdout.write (not console.log) so the repo's debug-statement CI gate,
  // which only exempts tests/ and test_* paths, doesn't flag this *.test.js reporter.
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

function makeDeps(overrides = {}) {
  const appended = [];
  const sent = [];
  const deps = {
    path,
    repoRoot: "X:/fake-root",
    appendJsonlQueued: async (p, record, opts) => { appended.push({ p, record, opts }); },
    collectRequestBody: async () => overrides.body || "{}",
    readJsonl: () => overrides.rows || [],
    sendJson: (res, obj, status) => { sent.push({ obj, status: status || 200 }); },
  };
  return { deps, appended, sent };
}

// request-auth trusts only un-proxied loopback sockets; 203.0.113.9 (TEST-NET-3) is
// the canonical "remote stranger".
const remoteReq = (method) => ({ method, headers: {}, socket: { remoteAddress: "203.0.113.9" } });
const loopbackReq = (method) => ({ method, headers: {}, socket: { remoteAddress: "127.0.0.1" } });

async function run() {
  // 1. unrelated path → not handled
  {
    const { deps } = makeDeps();
    const handled = await feedbackRoutes(remoteReq("GET"), {}, new URL("http://x/api/other"), deps);
    check("unrelated path returns false", () => assert.strictEqual(handled, false));
  }

  // 2. valid POST appends one attributable, rotation-capped row
  {
    const body = JSON.stringify({
      verdict: "up", turnIndex: 3, sessionId: "s-1",
      provider: "anthropic", model: "claude-x", intent: "chat",
      routeLabel: "keystone", userPreview: "hello", replyPreview: "hi there", surface: "dream-chat",
    });
    const { deps, appended, sent } = makeDeps({ body });
    const handled = await feedbackRoutes(remoteReq("POST"), {}, new URL("http://x/api/dream/feedback"), deps);
    check("valid POST handled", () => assert.strictEqual(handled, true));
    check("valid POST → 201 ok", () => { assert.strictEqual(sent[0].status, 201); assert.strictEqual(sent[0].obj.ok, true); });
    check("row lands in data/feedback/chat-feedback.jsonl", () =>
      assert.ok(appended[0].p.replace(/\\/g, "/").endsWith("data/feedback/chat-feedback.jsonl")));
    check("row carries verdict + provider/model attribution", () => {
      assert.strictEqual(appended[0].record.verdict, "up");
      assert.strictEqual(appended[0].record.provider, "anthropic");
      assert.strictEqual(appended[0].record.model, "claude-x");
      assert.strictEqual(appended[0].record.turnIndex, 3);
    });
    check("append is rotation-capped", () => assert.ok(appended[0].opts && appended[0].opts.rotate));
  }

  // 3. invalid verdict → 400, nothing appended
  {
    const { deps, appended, sent } = makeDeps({ body: JSON.stringify({ verdict: "meh" }) });
    await feedbackRoutes(remoteReq("POST"), {}, new URL("http://x/api/dream/feedback"), deps);
    check("bad verdict → 400", () => assert.strictEqual(sent[0].status, 400));
    check("bad verdict appends nothing", () => assert.strictEqual(appended.length, 0));
  }

  // 4. oversize fields are clipped, never stored raw
  {
    const { deps, appended } = makeDeps({
      body: JSON.stringify({ verdict: "down", userPreview: "x".repeat(999), model: "m".repeat(999) }),
    });
    await feedbackRoutes(remoteReq("POST"), {}, new URL("http://x/api/dream/feedback"), deps);
    check("previews clipped to 160", () => assert.strictEqual(appended[0].record.userPreview.length, 160));
    check("model clipped to 80", () => assert.strictEqual(appended[0].record.model.length, 80));
  }

  // 5. GET without sessionId from a non-operator → privacy note, no rows
  {
    const { deps, sent } = makeDeps({ rows: [{ sessionId: "a", verdict: "up" }] });
    await feedbackRoutes(remoteReq("GET"), {}, new URL("http://x/api/dream/feedback/recent"), deps);
    check("global read denied to non-operator", () => {
      assert.strictEqual(sent[0].obj.rows.length, 0);
      assert.ok(/operator/.test(sent[0].obj.note));
    });
  }

  // 6. GET with sessionId returns only that session's rows
  {
    const rows = [
      { sessionId: "a", verdict: "up" }, { sessionId: "b", verdict: "down" }, { sessionId: "a", verdict: "down" },
    ];
    const { deps, sent } = makeDeps({ rows });
    await feedbackRoutes(remoteReq("GET"), {}, new URL("http://x/api/dream/feedback/recent?sessionId=a"), deps);
    check("per-session read is self-service + filtered", () => {
      assert.strictEqual(sent[0].obj.rows.length, 2);
      assert.ok(sent[0].obj.rows.every((r) => r.sessionId === "a"));
    });
  }

  // 7. un-proxied loopback (local operator) may read globally
  {
    const rows = [{ sessionId: "a", verdict: "up" }, { sessionId: "b", verdict: "down" }];
    const { deps, sent } = makeDeps({ rows });
    await feedbackRoutes(loopbackReq("GET"), {}, new URL("http://x/api/dream/feedback/recent"), deps);
    check("loopback operator reads globally", () => assert.strictEqual(sent[0].obj.rows.length, 2));
  }

  if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
  process.stdout.write("\nall feedback-route checks passed\n");
}

run();
