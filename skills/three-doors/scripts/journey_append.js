#!/usr/bin/env node
// journey_append.js — append a Three Doors turn (or pref) to the ONE shared
// journey log, or read the current state back from its tail.
//
// Chat play (this skill) and the web game at /three-doors-game.html share one
// world through `data/three-doors/journey.jsonl` in the lantern-os repo. This
// script writes the SAME pinned entry schema the server route
// (apps/lantern-garage/routes/doors.js) writes, with `source:"skill"`, so the
// two surfaces interleave in one append-only log. Nothing is ever deleted or
// rewritten — state shifts only by appending (a `reset` pref newer than the
// last turn means "fresh game"; the history stays).
//
// Best-effort — never let it block a turn. Run with cwd inside the repo when
// possible so the repo's file-queue is used; concurrent skill+server appends
// are single-line fs appends — acceptable, documented.
//
// Modes:
//   APPEND TURN (default):
//     node journey_append.js --scene <key> --beat "<one line>" \
//       [--player doorwalker] [--choice-label A|B|C|CUSTOM|START] \
//       [--choice-name "<door>"] [--canon-add "<fact>"]... [--image <path>] \
//       [--cr <cr-id>] [--loop N] [--gate <gateKey>] [--title "<title>"]
//   APPEND PREF:
//     node journey_append.js --pref steer="more surreal" [--player p]
//   READ STATE (how a chat session resumes where web play left off):
//     node journey_append.js --state [--player p]
//
// Prints ONE JSON line:
//   {"ok":true,"path":"data/three-doors/journey.jsonl","via":"file-queue|fallback"}
// or {"ok":false,"error":"..."} — exit 0 either way in best-effort use;
// repo_root_not_found is the only exit 1 (NEVER write to a stray cwd/data tree).

const fs = require("fs");
const path = require("path");

const GATE_KEYS = [
  "garden", "ancient", "cloverfield", "tomorrow",
  "xp", "xenon", "sigil", "fog-return",
];
const CHOICE_LABELS = ["A", "B", "C", "CUSTOM", "START"];
const JOURNEY_REL = "data/three-doors/journey.jsonl";

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sanitizePlayer(v) {
  const s = String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32);
  return s || "doorwalker";
}

function cleanStr(v, max) {
  if (typeof v !== "string") return "";
  // strip control chars, clamp length
  return v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

// Walk up ≤8 levels from cwd looking for the repo's file-queue; the skill lives
// OUTSIDE any repo, so also try the fixed candidate C:\dev\lantern-os.
function findRepoRoot() {
  const marker = path.join("apps", "lantern-garage", "lib", "file-queue.js");
  let dir = path.resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, marker))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const fixed = "C:\\dev\\lantern-os";
  if (fs.existsSync(path.join(fixed, marker))) return fixed;
  return null;
}

function parseArgs(argv) {
  const a = { canonAdd: [], player: "doorwalker", choiceLabel: "CUSTOM", loop: 0, gate: "garden" };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--player") a.player = argv[++i];
    else if (t === "--scene") a.scene = argv[++i];
    else if (t === "--beat") a.beat = argv[++i];
    else if (t === "--choice-label") a.choiceLabel = String(argv[++i] || "").toUpperCase();
    else if (t === "--choice-name") a.choiceName = argv[++i];
    else if (t === "--canon-add") a.canonAdd.push(argv[++i]);
    else if (t === "--image") a.image = argv[++i];
    else if (t === "--cr") a.cr = argv[++i];
    else if (t === "--loop") a.loop = parseInt(argv[++i], 10);
    else if (t === "--gate") a.gate = argv[++i];
    else if (t === "--title") a.title = argv[++i];
    else if (t === "--pref") a.pref = argv[++i];
    else if (t === "--state") a.state = true;
  }
  return a;
}

// Append one entry to <root>/data/three-doors/journey.jsonl. Preferred path:
// the repo's file-queue (serialized appends, no rotate — the journey is
// append-only by mandate; rotation-with-archives is the documented escape
// hatch if abuse ever appears, never built preemptively). Fallback: a plain
// one-line fs append of the identical JSON to the identical path.
async function appendEntry(repoRoot, entry) {
  const journeyAbs = path.join(repoRoot, "data", "three-doors", "journey.jsonl");
  try {
    const fq = require(path.join(repoRoot, "apps", "lantern-garage", "lib", "file-queue.js"));
    await fq.appendJsonlQueued(journeyAbs, entry);
    return { ok: true, path: JOURNEY_REL, via: "file-queue" };
  } catch (_e) {
    try {
      fs.mkdirSync(path.dirname(journeyAbs), { recursive: true });
      fs.appendFileSync(journeyAbs, JSON.stringify(entry) + "\n", "utf8");
      return { ok: true, path: JOURNEY_REL, via: "fallback" };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

// Same reduction as the server's GET /api/doors/state (reduceJourney):
// prefs = last-wins fold (≤20 keys); lastTurn = last turn row; a `reset` pref
// NEWER than lastTurn ⇒ resume null; path = last 12 turns.
function reduceState(rows, player) {
  const mine = rows.filter((r) => r && r.player === player);
  const prefs = {};
  let lastTurn = null;
  let lastReset = null;
  const turns = [];
  for (const r of mine) {
    if (r.kind === "pref") {
      prefs[r.key] = r.value;
      if (r.key === "reset") lastReset = r;
    } else if (r.kind === "turn") {
      lastTurn = r;
      turns.push(r);
    }
  }
  const prefKeys = Object.keys(prefs).slice(0, 20);
  const prefsOut = {};
  for (const k of prefKeys) prefsOut[k] = prefs[k];
  const resetNewer = lastReset && lastTurn && String(lastReset.ts) > String(lastTurn.ts);
  const resume = lastTurn && !resetNewer
    ? {
        sceneKey: lastTurn.sceneKey, title: lastTurn.title, beat: lastTurn.beat,
        imagePath: lastTurn.imagePath, loop: lastTurn.loop, gate: lastTurn.gate,
        crId: lastTurn.crId, source: lastTurn.source, ts: lastTurn.ts,
      }
    : null;
  const pathOut = turns.slice(-12).map((t) => ({
    sceneKey: t.sceneKey,
    choiceName: t.choice && t.choice.name,
    ts: t.ts,
  }));
  return {
    ok: true, player, turns: turns.length, resume, path: pathOut,
    prefs: prefsOut, lastCrId: lastTurn ? lastTurn.crId : null,
  };
}

function readTail(repoRoot, limit) {
  const journeyAbs = path.join(repoRoot, "data", "three-doors", "journey.jsonl");
  let text = "";
  try {
    text = fs.readFileSync(journeyAbs, "utf8");
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const repoRoot = findRepoRoot();
  if (!repoRoot) {
    out({ ok: false, error: "repo_root_not_found" });
    process.exit(1);
  }
  const player = sanitizePlayer(a.player);

  // READ STATE
  if (a.state) {
    out(reduceState(readTail(repoRoot, 500), player));
    return;
  }

  // APPEND PREF
  if (a.pref != null) {
    const eq = String(a.pref).indexOf("=");
    const key = eq > 0 ? String(a.pref).slice(0, eq).trim() : "";
    const rawVal = eq > 0 ? String(a.pref).slice(eq + 1) : "";
    const allowlist = ["theme", "reducedMotion", "steer", "narrator", "reset"];
    if (!allowlist.includes(key) && !/^[a-z][a-z0-9-]{0,31}$/.test(key)) {
      out({ ok: false, error: "invalid_pref_key" });
      return;
    }
    let value;
    if (rawVal === "true") value = true;
    else if (rawVal === "false") value = false;
    else if (rawVal !== "" && Number.isFinite(Number(rawVal))) value = Number(rawVal);
    else value = cleanStr(rawVal, 200);
    const entry = { ts: new Date().toISOString(), player, kind: "pref", key, value };
    out(await appendEntry(repoRoot, entry));
    return;
  }

  // APPEND TURN (default)
  const sceneKey = String(a.scene || "").toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(sceneKey)) {
    out({ ok: false, error: "invalid_scene" });
    return;
  }
  const beat = cleanStr(a.beat || "", 400);
  if (beat.length < 3) {
    out({ ok: false, error: "invalid_beat" });
    return;
  }
  const label = CHOICE_LABELS.includes(a.choiceLabel) ? a.choiceLabel : "CUSTOM";
  const name = cleanStr(a.choiceName || "", 80) || "unnamed door";
  const canonAdditions = a.canonAdd
    .map((s) => cleanStr(s, 200))
    .filter(Boolean)
    .slice(0, 5);
  const imagePath = a.image ? cleanStr(a.image, 300) || null : null;
  const crId = a.cr && /^cr-[a-z0-9-]{1,40}$/.test(String(a.cr)) ? String(a.cr) : null;
  const loop = Number.isInteger(a.loop) && a.loop >= 0 && a.loop <= 999 ? a.loop : 0;
  const gate = GATE_KEYS.includes(a.gate) ? a.gate : null;
  if (!gate) {
    out({ ok: false, error: "invalid_gate" });
    return;
  }
  const entry = {
    ts: new Date().toISOString(),
    player,
    kind: "turn",
    sceneKey,
    title: cleanStr(a.title || "", 80),
    beat,
    choice: { label, name },
    canonAdditions,
    imagePath,
    crId,
    loop,
    gate,
    source: "skill",
  };
  out(await appendEntry(repoRoot, entry));
}

main().catch((e) => {
  out({ ok: false, error: e && e.message ? e.message : String(e) });
});
