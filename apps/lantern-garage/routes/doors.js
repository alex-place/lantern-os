"use strict";
// Three Doors — canon + journey + Σ₀ turns (1.8.18).
//
// One append-only journey log (data/three-doors/journey.jsonl) shared by web
// play (this route) and skill play (~/.claude/skills/three-doors/scripts/
// journey_append.js). Nothing is ever deleted or rewritten — confidence and
// state shift only by appending. NO rotation on the journey by design: entries
// are clamped small (≤~1.5KB) so growth is bounded by real play; if abuse ever
// appears, the escape hatch is rotation-with-archives via file-queue's rotate
// option — documented here, never built preemptively.
//
// Endpoints (all GUEST-OPEN, matching /api/dream/chat + /api/image/ai-generate;
// CF-proxied prod traffic is never operator, so operator-gating would break
// the public site):
//   GET  /api/doors/canon           → machine-readable locked canon
//   GET  /api/doors/state?player=   → derived resume state from the journey tail
//   POST /api/doors/turn            → validate + emit ConvergenceRecord + append turn
//   POST /api/doors/pref            → append a standing preference (memory, not claims)

const path = require("path");
const { emitConvergenceRecord } = require("../lib/convergence-records");

const CANON_REL = "data/three-doors/canon.json";
const JOURNEY_REL = "data/three-doors/journey.jsonl";

const GATE_KEYS = ["garden", "ancient", "cloverfield", "tomorrow", "xp", "xenon", "sigil", "fog-return"];

// Server-authoritative source → confidence map; any client-sent confidence is IGNORED.
const SOURCE_CONF = { vision: 0.85, prompt: 0.75, canon: 0.6, seed: 0.9, offline: 0.85 };

// Fallback canon evidence ids — ids/order MUST match the skill's record_convergence.js.
const CANON_EVIDENCE_FALLBACK = [
  "three-doors:cast-canon",
  "three-doors:creed",
  "three-doors:art-direction",
  "three-doors:ref:lantern",
  "three-doors:ref:eclipse",
  "three-doors:ref:keystone",
  "three-doors:ref:blinkbug",
];

const PREF_KEY_ALLOWLIST = ["theme", "reducedMotion", "steer", "narrator", "reset"];
const PREF_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;

// ── helpers (exported for tests) ─────────────────────────────────────────────

function sanitizePlayer(v) {
  const s = String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32);
  return s || "doorwalker";
}

function cleanStr(v, max) {
  if (typeof v !== "string") return null;
  // Strip control chars, clamp length.
  // eslint-disable-next-line no-control-regex
  return v.replace(new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]", "g"), "").slice(0, max);
}

function slug(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
}

// imagePath: null, or string ≤300 starting with /images/ or the pollinations
// host and containing no ".." — anything else coerces to null (never rejects).
function cleanImagePath(v) {
  if (typeof v !== "string") return null;
  if (v.length > 300) return null;
  if (v.includes("..")) return null;
  if (!v.startsWith("/images/") && !v.startsWith("https://image.pollinations.ai/")) return null;
  return v;
}

// Fold a player's journey rows (oldest→newest) into resume state.
// prefs = last-wins fold of pref rows (≤20 keys); a "reset" pref NEWER than the
// last turn means resume:null (nothing deleted — resets are appended prefs).
function reduceJourney(rows) {
  const prefs = {};
  let lastTurn = null;
  let lastReset = null;
  const turns = [];
  for (const r of rows || []) {
    if (!r || typeof r !== "object") continue;
    if (r.kind === "turn") {
      lastTurn = r;
      turns.push(r);
    } else if (r.kind === "pref" && typeof r.key === "string") {
      prefs[r.key] = r.value;
      if (r.key === "reset") lastReset = r;
    }
  }
  // Clamp prefs to ≤20 keys (keep the most recently-set by insertion order).
  const prefKeys = Object.keys(prefs);
  if (prefKeys.length > 20) {
    for (const k of prefKeys.slice(0, prefKeys.length - 20)) delete prefs[k];
  }
  let resume = null;
  if (lastTurn) {
    const resetNewer = lastReset && String(lastReset.ts || "") > String(lastTurn.ts || "");
    if (!resetNewer) {
      resume = {
        sceneKey: lastTurn.sceneKey,
        title: lastTurn.title,
        beat: lastTurn.beat,
        imagePath: lastTurn.imagePath == null ? null : lastTurn.imagePath,
        loop: lastTurn.loop,
        gate: lastTurn.gate,
        crId: lastTurn.crId == null ? null : lastTurn.crId,
        source: lastTurn.source,
        ts: lastTurn.ts,
      };
    }
  }
  const pathWindow = turns.slice(-12).map((t) => ({
    sceneKey: t.sceneKey,
    choiceName: t.choice && t.choice.name ? t.choice.name : null,
    ts: t.ts,
  }));
  return {
    turns: turns.length,
    resume,
    path: pathWindow,
    prefs,
    lastCrId: lastTurn && lastTurn.crId != null ? lastTurn.crId : null,
  };
}

// ── 60s in-module caches ─────────────────────────────────────────────────────

let _canonCache = { at: 0, canon: null };

function loadCanon(readJson) {
  const now = Date.now();
  if (_canonCache.canon && now - _canonCache.at < 60_000) return _canonCache.canon;
  const canon = readJson(CANON_REL, null);
  if (canon && typeof canon === "object") {
    _canonCache = { at: now, canon };
    return canon;
  }
  return null;
}

function canonEvidence(readJson) {
  const canon = loadCanon(readJson);
  if (canon && Array.isArray(canon.evidenceIds) && canon.evidenceIds.length) {
    return canon.evidenceIds.map(String);
  }
  return CANON_EVIDENCE_FALLBACK;
}

// ── handler ──────────────────────────────────────────────────────────────────

module.exports = async function doorsRoutes(req, res, url, deps) {
  if (!url.pathname.startsWith("/api/doors/")) return false;

  const { sendJson, collectRequestBody, appendJsonlQueued, readJsonl, readJson, repoRoot } = deps;
  // Writer path is ABSOLUTE (file-queue append takes an absolute path); readers
  // use the repo-RELATIVE path (readJsonl resolves against repo root). Do not mix.
  const JOURNEY = path.join(repoRoot, "data", "three-doors", "journey.jsonl");

  // ── GET /api/doors/canon ──
  if (url.pathname === "/api/doors/canon") {
    if (req.method !== "GET") { sendJson(res, { ok: false, error: "method_not_allowed" }, 405); return true; }
    const canon = loadCanon(readJson);
    if (!canon) { sendJson(res, { ok: false, error: "canon_missing" }, 500); return true; }
    sendJson(res, { ok: true, canon }, 200);
    return true;
  }

  // ── GET /api/doors/state?player= ──
  if (url.pathname === "/api/doors/state") {
    if (req.method !== "GET") { sendJson(res, { ok: false, error: "method_not_allowed" }, 405); return true; }
    try {
      const player = sanitizePlayer(url.searchParams.get("player"));
      const rows = readJsonl(JOURNEY_REL, 1000).filter((r) => r && !r.parseError && r.player === player);
      const state = reduceJourney(rows);
      sendJson(res, {
        ok: true,
        player,
        turns: state.turns,
        resume: state.resume,
        path: state.path,
        prefs: state.prefs,
        lastCrId: state.lastCrId,
      }, 200);
    } catch (err) {
      sendJson(res, { ok: false, error: err && err.message ? err.message : "state_failed" }, 500);
    }
    return true;
  }

  // ── POST /api/doors/turn ──
  if (url.pathname === "/api/doors/turn") {
    if (req.method !== "POST") { sendJson(res, { ok: false, error: "method_not_allowed" }, 405); return true; }
    let body;
    try {
      const raw = await collectRequestBody(req, 32768);
      body = JSON.parse(raw || "{}");
    } catch {
      sendJson(res, { ok: false, error: "bad_json" }, 400);
      return true;
    }
    if (!body || typeof body !== "object") { sendJson(res, { ok: false, error: "bad_json" }, 400); return true; }

    const player = sanitizePlayer(body.player);

    const sceneKey = typeof body.sceneKey === "string" && /^[a-z0-9-]{1,64}$/.test(body.sceneKey) ? body.sceneKey : null;
    if (!sceneKey) { sendJson(res, { ok: false, error: "invalid_sceneKey" }, 400); return true; }

    let title = null;
    if (body.title != null) {
      title = cleanStr(body.title, 80);
      if (title === null) { sendJson(res, { ok: false, error: "invalid_title" }, 400); return true; }
    }

    const beat = cleanStr(body.beat, 400);
    if (!beat || beat.trim().length < 3) { sendJson(res, { ok: false, error: "invalid_beat" }, 400); return true; }

    const choiceIn = body.choice;
    const label = choiceIn && typeof choiceIn === "object" ? choiceIn.label : null;
    const choiceName = choiceIn && typeof choiceIn === "object" ? cleanStr(choiceIn.name, 80) : null;
    if (!["A", "B", "C", "CUSTOM", "START"].includes(label) || !choiceName || choiceName.length < 1) {
      sendJson(res, { ok: false, error: "invalid_choice" }, 400);
      return true;
    }
    const choice = { label, name: choiceName };

    let canonAdditions = [];
    if (body.canonAdditions != null) {
      if (!Array.isArray(body.canonAdditions) || body.canonAdditions.length > 5) {
        sendJson(res, { ok: false, error: "invalid_canonAdditions" }, 400);
        return true;
      }
      canonAdditions = [];
      for (const a of body.canonAdditions) {
        const c = cleanStr(a, 200);
        if (c === null) { sendJson(res, { ok: false, error: "invalid_canonAdditions" }, 400); return true; }
        canonAdditions.push(c);
      }
    }

    const imagePath = cleanImagePath(body.imagePath); // coerces bad paths to null, never rejects

    const loop = Number.isInteger(body.loop) && body.loop >= 0 && body.loop <= 999 ? body.loop : null;
    if (loop === null) { sendJson(res, { ok: false, error: "invalid_loop" }, 400); return true; }

    const gate = GATE_KEYS.includes(body.gate) ? body.gate : null;
    if (!gate) { sendJson(res, { ok: false, error: "invalid_gate" }, 400); return true; }

    const source = Object.prototype.hasOwnProperty.call(SOURCE_CONF, body.source) ? body.source : null;
    if (!source) { sendJson(res, { ok: false, error: "invalid_source" }, 400); return true; }

    let prevCrId = null;
    if (body.prevCrId != null) {
      if (typeof body.prevCrId !== "string" || !/^cr-[a-z0-9-]{1,40}$/.test(body.prevCrId)) {
        sendJson(res, { ok: false, error: "invalid_prevCrId" }, 400);
        return true;
      }
      prevCrId = body.prevCrId;
    }

    try {
      // CR FIRST so the journey row carries its id. Confidence is server-set.
      const confidence = SOURCE_CONF[source];
      const record = await emitConvergenceRecord({
        hypothesis: `Three Doors web turn stays canon-true: "${beat.slice(0, 140)}"`,
        evidence_ids: [
          ...canonEvidence(readJson),
          ...(prevCrId ? [prevCrId] : []),
          `three-doors:choice:${choice.label}:${slug(choice.name)}`,
          ...(source === "vision" ? [`three-doors:vision:${sceneKey}`] : []),
        ],
        result: { kind: "three-doors-web-turn", scene: sceneKey, beat, choice: { label: choice.label, name: choice.name }, image: imagePath, loop, gate, source },
        confidence,
        reasoner: "three-doors-game", // SAME reasoner as the skill
        verified: source === "seed" || source === "offline", // deterministic verbatim canon only
        verification_notes:
          source === "seed" ? "deterministic canon seed (opening/deliberate)"
          : source === "offline" ? "deterministic canon seed served on generation failure; not choice-responsive"
          : source === "vision" ? "scene image vision-checked against cast canon; narration parsed+validated, not independently verified"
          : source === "prompt" ? "image generated from canon prompt recipe; narration parsed+validated"
          : "LLM narration with canon digest injected; parsed+validated; image unverified",
        source: "three-doors-web (runtime turn)",
        allowed_max_confidence: confidence,
      }); // never throws; may return null — crId:null is honest

      const entry = {
        ts: new Date().toISOString(),
        player,
        kind: "turn",
        sceneKey,
        title,
        beat,
        choice: { label: choice.label, name: choice.name },
        canonAdditions,
        imagePath,
        crId: record ? record.id : null,
        loop,
        gate,
        source,
      };
      await appendJsonlQueued(JOURNEY, entry); // append-only, no rotate
      sendJson(res, { ok: true, crId: entry.crId, confidence, source }, 200);
    } catch (err) {
      sendJson(res, { ok: false, error: err && err.message ? err.message : "turn_failed" }, 500);
    }
    return true;
  }

  // ── POST /api/doors/pref ──
  if (url.pathname === "/api/doors/pref") {
    if (req.method !== "POST") { sendJson(res, { ok: false, error: "method_not_allowed" }, 405); return true; }
    let body;
    try {
      const raw = await collectRequestBody(req, 2048);
      body = JSON.parse(raw || "{}");
    } catch {
      sendJson(res, { ok: false, error: "bad_json" }, 400);
      return true;
    }
    if (!body || typeof body !== "object") { sendJson(res, { ok: false, error: "bad_json" }, 400); return true; }

    const player = sanitizePlayer(body.player);
    const key = typeof body.key === "string" && (PREF_KEY_ALLOWLIST.includes(body.key) || PREF_KEY_RE.test(body.key))
      ? body.key : null;
    if (!key) { sendJson(res, { ok: false, error: "invalid_key" }, 400); return true; }

    let value;
    if (typeof body.value === "boolean") value = body.value;
    else if (typeof body.value === "number" && Number.isFinite(body.value)) value = body.value;
    else if (typeof body.value === "string") value = cleanStr(body.value, 200);
    else value = undefined;
    if (value === undefined || value === null) { sendJson(res, { ok: false, error: "invalid_value" }, 400); return true; }

    try {
      // Prefs are memory, not claims — same ONE journey log, no ConvergenceRecord.
      await appendJsonlQueued(JOURNEY, { ts: new Date().toISOString(), player, kind: "pref", key, value });
      sendJson(res, { ok: true }, 200);
    } catch (err) {
      sendJson(res, { ok: false, error: err && err.message ? err.message : "pref_failed" }, 500);
    }
    return true;
  }

  // Unknown /api/doors/* path — this route owns the namespace.
  sendJson(res, { ok: false, error: "not_found" }, 404);
  return true;
};

// Exported for tests (tests/test_doors_routes.js).
module.exports.reduceJourney = reduceJourney;
module.exports.sanitizePlayer = sanitizePlayer;
module.exports.cleanImagePath = cleanImagePath;
module.exports.SOURCE_CONF = SOURCE_CONF;
module.exports.GATE_KEYS = GATE_KEYS;
