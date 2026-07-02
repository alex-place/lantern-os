/**
 * Tests for apps/lantern-garage/routes/doors.js (Three Doors web API, 1.8.18)
 * Run: node tests/test_doors_routes.js
 *
 * Exercises the exported pure helpers (sanitizePlayer, cleanImagePath,
 * reduceJourney) plus the route handler with stubbed deps + a stubbed
 * convergence-records emitter (so this never touches the real
 * data/convergence/records.jsonl file-queue).
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-doors-test-"));

let passed = 0, failed = 0;
function assert(label, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`); failed++; }
}
function section(n) { console.log(`\n── ${n}`); }

// ── Stub convergence-records (avoid real file-queue writes) ──────────────────
const crCalls = [];
const crTmp = path.join(TMP, "convergence-records.js");
fs.writeFileSync(crTmp, `
"use strict";
module.exports = {
  emitConvergenceRecord: async (o) => {
    global.__CR_CALLS__.push(o);
    return { id: "cr-test-1", ...o };
  },
};
`);
global.__CR_CALLS__ = crCalls;

const REPO_ROOT = path.resolve(__dirname, "..");
const routeSrc = fs.readFileSync(path.join(REPO_ROOT, "apps/lantern-garage/routes/doors.js"), "utf8")
  .replace('require("../lib/convergence-records")', `require(${JSON.stringify(crTmp)})`);
const routeTmp = path.join(TMP, "doors-route.js");
fs.writeFileSync(routeTmp, routeSrc);

const doorsRoute = require(routeTmp);
const { reduceJourney, sanitizePlayer, cleanImagePath } = doorsRoute;

// ── req/res + deps helpers ────────────────────────────────────────────────────
function sendJson(res, data, status = 200) {
  res.statusCode = status;
  res._body = JSON.stringify(data);
}

function makeDeps({ canon = null, journeyRows = [] } = {}) {
  const appended = [];
  return {
    deps: {
      sendJson,
      collectRequestBody: async (req) => req._rawBody || "{}",
      appendJsonlQueued: async (_file, entry) => { appended.push(entry); },
      readJsonl: (_rel, _limit) => journeyRows,
      readJson: (_rel, fallback) => (canon == null ? fallback : canon),
      repoRoot: REPO_ROOT,
    },
    appended,
  };
}

function makeReqRes(method, pathname, body) {
  const res = { statusCode: 200, _body: null, get body() { return JSON.parse(this._body || "{}"); } };
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, _rawBody: body === undefined ? undefined : JSON.stringify(body) };
  return { req, res, url };
}

const FAKE_CANON = { evidenceIds: ["three-doors:cast-canon"], cast: {} };

(async () => {
  section("sanitizePlayer");
  assert("lowercases + strips", sanitizePlayer("  Alex_99!! ") === "alex99", sanitizePlayer("  Alex_99!! "));
  assert("defaults to doorwalker", sanitizePlayer("") === "doorwalker");
  assert("defaults on null", sanitizePlayer(null) === "doorwalker");
  assert("truncates to 32", sanitizePlayer("a".repeat(50)).length === 32);

  section("cleanImagePath");
  assert("accepts /images/ path", cleanImagePath("/images/foo.png") === "/images/foo.png");
  assert("accepts pollinations url", cleanImagePath("https://image.pollinations.ai/prompt/x") === "https://image.pollinations.ai/prompt/x");
  assert("rejects traversal", cleanImagePath("/images/../secret.png") === null);
  assert("rejects other domain", cleanImagePath("https://evil.example.com/x.png") === null);
  assert("rejects non-string", cleanImagePath(42) === null);
  assert("rejects null", cleanImagePath(null) === null);

  section("reduceJourney");
  const rows = [
    { kind: "turn", player: "alex", ts: "2026-07-01T00:00:00Z", sceneKey: "garden-1", title: "Garden", beat: "b1", choice: { label: "A", name: "Wishing Rail" }, imagePath: null, loop: 0, gate: "garden", crId: "cr-1", source: "seed" },
    { kind: "pref", player: "alex", ts: "2026-07-01T00:01:00Z", key: "theme", value: "dark" },
    { kind: "turn", player: "alex", ts: "2026-07-01T00:02:00Z", sceneKey: "garden-2", title: "Garden 2", beat: "b2", choice: { label: "B", name: "Spyglass" }, imagePath: "/images/g2.png", loop: 0, gate: "garden", crId: "cr-2", source: "prompt" },
  ];
  const state = reduceJourney(rows);
  assert("counts turns", state.turns === 2);
  assert("resume is the last turn", state.resume && state.resume.sceneKey === "garden-2");
  assert("lastCrId is last turn's crId", state.lastCrId === "cr-2");
  assert("prefs folded", state.prefs.theme === "dark");
  assert("path window has both turns", state.path.length === 2);

  const rowsWithNewerReset = rows.concat([{ kind: "pref", ts: "2026-07-01T00:03:00Z", key: "reset", value: true }]);
  const resetState = reduceJourney(rowsWithNewerReset);
  assert("reset newer than last turn clears resume", resetState.resume === null);

  section("GET /api/doors/canon");
  // NB: loadCanon() has a 60s in-module cache, so the canon_missing case must
  // run BEFORE any call that primes the cache with FAKE_CANON.
  {
    const { deps } = makeDeps({ canon: null });
    const { req, res, url } = makeReqRes("GET", "/api/doors/canon");
    await doorsRoute(req, res, url, deps);
    assert("canon_missing -> 500", res.statusCode === 500 && res.body.error === "canon_missing");
  }
  {
    const { deps } = makeDeps({ canon: FAKE_CANON });
    const { req, res, url } = makeReqRes("GET", "/api/doors/canon");
    const handled = await doorsRoute(req, res, url, deps);
    assert("handled", handled === true);
    assert("status 200", res.statusCode === 200);
    assert("returns canon", res.body.ok === true && res.body.canon.cast !== undefined);
  }
  {
    const { deps } = makeDeps({ canon: FAKE_CANON });
    const { req, res, url } = makeReqRes("POST", "/api/doors/canon");
    await doorsRoute(req, res, url, deps);
    assert("POST canon -> 405", res.statusCode === 405);
  }

  section("GET /api/doors/state");
  {
    const { deps } = makeDeps({ journeyRows: rows });
    const { req, res, url } = makeReqRes("GET", "/api/doors/state?player=Alex");
    await doorsRoute(req, res, url, deps);
    assert("status 200", res.statusCode === 200);
    assert("player sanitized", res.body.player === "alex");
    assert("turns from journey", res.body.turns === 2);
    assert("resume present", res.body.resume && res.body.resume.sceneKey === "garden-2");
  }

  section("POST /api/doors/turn");
  const validTurn = {
    player: "alex", sceneKey: "garden-3", title: "Garden 3", beat: "A short beat happens here.",
    choice: { label: "A", name: "Wishing Rail" }, imagePath: "/images/g3.png", loop: 0, gate: "garden", source: "prompt",
  };
  {
    crCalls.length = 0;
    const { deps, appended } = makeDeps();
    const { req, res, url } = makeReqRes("POST", "/api/doors/turn", validTurn);
    await doorsRoute(req, res, url, deps);
    assert("status 200", res.statusCode === 200, JSON.stringify(res.body));
    assert("crId from emitted record", res.body.crId === "cr-test-1");
    assert("confidence matches source", res.body.confidence === 0.75);
    assert("one journey row appended", appended.length === 1);
    assert("appended entry carries choice + gate", appended[0].choice.label === "A" && appended[0].gate === "garden");
    assert("convergence record emitted once", crCalls.length === 1);
  }
  {
    const { deps } = makeDeps();
    const { req, res, url } = makeReqRes("POST", "/api/doors/turn", { ...validTurn, sceneKey: "Not Valid!" });
    await doorsRoute(req, res, url, deps);
    assert("invalid sceneKey -> 400", res.statusCode === 400 && res.body.error === "invalid_sceneKey");
  }
  {
    const { deps } = makeDeps();
    const { req, res, url } = makeReqRes("POST", "/api/doors/turn", { ...validTurn, choice: { label: "Z", name: "x" } });
    await doorsRoute(req, res, url, deps);
    assert("invalid choice label -> 400", res.statusCode === 400 && res.body.error === "invalid_choice");
  }
  {
    const { deps } = makeDeps();
    const { req, res, url } = makeReqRes("POST", "/api/doors/turn", { ...validTurn, gate: "not-a-gate" });
    await doorsRoute(req, res, url, deps);
    assert("invalid gate -> 400", res.statusCode === 400 && res.body.error === "invalid_gate");
  }
  {
    const { deps } = makeDeps();
    const { req, res, url } = makeReqRes("POST", "/api/doors/turn", { ...validTurn, source: "made-up" });
    await doorsRoute(req, res, url, deps);
    assert("invalid source -> 400", res.statusCode === 400 && res.body.error === "invalid_source");
  }

  section("POST /api/doors/pref");
  {
    const { deps, appended } = makeDeps();
    const { req, res, url } = makeReqRes("POST", "/api/doors/pref", { player: "alex", key: "theme", value: "dark" });
    await doorsRoute(req, res, url, deps);
    assert("status 200", res.statusCode === 200);
    assert("pref appended", appended.length === 1 && appended[0].kind === "pref" && appended[0].key === "theme");
  }
  {
    const { deps } = makeDeps();
    const { req, res, url } = makeReqRes("POST", "/api/doors/pref", { player: "alex", key: "not_allowlisted_but_ok", value: "x" });
    await doorsRoute(req, res, url, deps);
    assert("underscore key rejected by PREF_KEY_RE", res.statusCode === 400 && res.body.error === "invalid_key");
  }

  section("routing edges");
  {
    const { deps } = makeDeps();
    const { req, res, url } = makeReqRes("GET", "/api/dream/status");
    const handled = await doorsRoute(req, res, url, deps);
    assert("non /api/doors/ path returns false", handled === false);
  }
  {
    const { deps } = makeDeps();
    const { req, res, url } = makeReqRes("GET", "/api/doors/nope");
    await doorsRoute(req, res, url, deps);
    assert("unknown doors path -> 404 not_found", res.statusCode === 404 && res.body.error === "not_found");
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  fs.rmSync(TMP, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
