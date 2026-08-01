// Route-layer robustness fixes from the 2026-07-16 profiles/login audit:
//   #2650 auth.js readJsonBody must SETTLE when the 1MB cap trips (destroy() kills
//         'data'/'end', so the old reader's promise hung the async handler forever)
//   #2649 profiles.js readBody — same hang, same fix
//   #2651 GET /api/profiles/me must answer 401 (not 200 + null body) when a live
//         session names a profile id that no longer resolves (index reset/migration)
//
// Run: node apps/lantern-garage/test/route-body-robustness.test.js  (isolates cwd)
const assert = require("assert");
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");

const _tmpDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-routebody-"));
process.chdir(_tmpDataRoot);
// The data root is module-anchored, not cwd-derived (#3088) — isolate the store
// explicitly so this test never writes into the real repo data/ tree.
process.env.LANTERN_DATA_DIR = path.join(_tmpDataRoot, "data");

const authRoutes = require("../routes/auth");
const profileRoutes = require("../routes/profiles");

let failures = 0;
// process.stdout.write (not console.log) so the repo's debug-statement CI gate,
// which only exempts tests/ and test_* paths, doesn't flag this *.test.js reporter.
function check(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => process.stdout.write(`  ok  - ${name}\n`))
    .catch((e) => { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); });
}

// A reader must settle within this budget; if it doesn't, the "never settles"
// regression is back. Real settlement is synchronous on the cap, so this is slack.
function settlesWithin(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: promise never settled (hang regression)`)), ms)),
  ]);
}

// Mock request stream: emits one >1MB chunk, then 'close' — exactly what Node does
// after req.destroy() trips the cap (NO 'end' event follows a destroy).
function oversizeReq() {
  const req = new EventEmitter();
  req.destroy = () => req.emit("close"); // real IncomingMessage.destroy() → 'close', never 'end'
  queueMicrotask(() => {
    req.emit("data", "x".repeat(1e6 + 1));
  });
  return req;
}

// A well-formed small body must still parse.
function jsonReq(obj) {
  const req = new EventEmitter();
  queueMicrotask(() => {
    req.emit("data", JSON.stringify(obj));
    req.emit("end");
  });
  return req;
}

async function run() {
  // ── #2650 / #2649 readers settle on the size cap ──────────────────────────
  check("#2650 auth.readJsonBody settles (→ null) on oversize body", async () => {
    const v = await settlesWithin(authRoutes.readJsonBody(oversizeReq()), 1000, "auth.readJsonBody");
    assert.strictEqual(v, null, "oversize body must resolve null, not hang");
  });
  check("#2649 profiles.readBody settles (→ null) on oversize body", async () => {
    const v = await settlesWithin(profileRoutes.readBody(oversizeReq()), 1000, "profiles.readBody");
    assert.strictEqual(v, null, "oversize body must resolve null, not hang");
  });

  // ── happy path still works (fix didn't break normal parsing) ──────────────
  check("auth.readJsonBody still parses a normal JSON body", async () => {
    const v = await settlesWithin(authRoutes.readJsonBody(jsonReq({ a: 1 })), 1000, "auth happy");
    assert.deepStrictEqual(v, { a: 1 });
  });
  check("profiles.readBody still parses a normal JSON body", async () => {
    const v = await settlesWithin(profileRoutes.readBody(jsonReq({ b: 2 })), 1000, "profiles happy");
    assert.deepStrictEqual(v, { b: 2 });
  });

  // ── #2651 /api/profiles/me answers 401 for a ghost session ────────────────
  function captureRes() {
    const out = { status: 0, body: "" };
    return {
      out,
      writeHead(s) { out.status = s; },
      end(b) { out.body = b || ""; return out; },
    };
  }
  // A session that names a profile id which was never created (dev store is empty
  // here) — getSessionUser returns it (a merely-missing id is NOT a tombstone),
  // getProfile(id) → null. Pre-fix: 200 + "null". Post-fix: 401 unknown_account.
  check("#2651 GET /me with an unresolvable session → 401 unknown_account", async () => {
    const req = new EventEmitter();
    req.method = "GET";
    req.session = { user: { id: "ghost-no-profile" } };
    const { out, ...res } = captureRes();
    const handled = await profileRoutes(req, res, new URL("http://x/api/profiles/me"), {});
    assert.ok(handled, "route must claim /api/profiles/me (terminal branch returns res)");
    assert.strictEqual(out.status, 401, `expected 401, got ${out.status} (body=${out.body})`);
    const parsed = JSON.parse(out.body);
    assert.strictEqual(parsed.error, "unknown_account");
    assert.strictEqual(parsed.signedOut, true);
  });

  // guard: a truly-unauthenticated request is still a plain 401 (regression fence
  // — the ghost-session branch must not swallow the no-session branch).
  check("GET /me with no session is still 401 Not authenticated", async () => {
    const req = new EventEmitter();
    req.method = "GET";
    const { out, ...res } = captureRes();
    await profileRoutes(req, res, new URL("http://x/api/profiles/me"), {});
    assert.strictEqual(out.status, 401);
    assert.strictEqual(JSON.parse(out.body).error, "Not authenticated");
  });
}

run().then(() => {
  // let the queued microtask-chained checks flush before verdict
  setTimeout(() => {
    if (failures) { process.stderr.write(`\n${failures} check(s) failed\n`); process.exit(1); }
    process.stdout.write("\nall route-body-robustness checks passed\n");
  }, 1500);
});
