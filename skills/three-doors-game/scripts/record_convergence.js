#!/usr/bin/env node
// record_convergence.js — the Converge stage for a Three Doors scene image.
//
// Every time a new scene image is sent, emit ONE ConvergenceRecord that grounds
// the image in the game's canon "memories". The record schema mirrors
// apps/lantern-garage/lib/convergence-records.js (and src/convergence/objects.py)
// EXACTLY, so the Python Convergence Core loads it. It appends to the same
// CSF-backed convergence log: data/convergence/records.jsonl. Best-effort — it
// never throws and must never block a turn.
//
// Grounding: `evidence_ids` cite the canon the image was checked against — the
// hand-drawn cast reference art, the King's creed, the art-direction steer — plus
// any scene-specific memory ids (--evidence) and the previous record (--prev) so
// the turns form a continuity chain. The canon-check IS the Verify stage:
// pass --canon-ok true only when the cast is on-model, no fox, no stray text.
//
// Usage:
//   node skills/three-doors-game/scripts/record_convergence.js \
//     --beat "Odin bows as the King reads the creed" --scene fog-door-return \
//     --image <scratch>/scene-creed.png --canon-ok true --confidence 0.9 \
//     --evidence three-doors:odin-fog-god --prev cr-abc123
//
// Prints one JSON line: {"ok":true,"id":"cr-...","records":"data/convergence/records.jsonl"}

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const a = { evidence: [], canonOk: true, confidence: 0.8 };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--beat") a.beat = argv[++i];
    else if (t === "--scene") a.scene = argv[++i];
    else if (t === "--image") a.image = argv[++i];
    else if (t === "--canon-ok") a.canonOk = String(argv[++i]).toLowerCase() !== "false";
    else if (t === "--confidence") a.confidence = parseFloat(argv[++i]);
    else if (t === "--notes") a.notes = argv[++i];
    else if (t === "--evidence") a.evidence.push(...String(argv[++i]).split(",").map((s) => s.trim()).filter(Boolean));
    else if (t === "--prev") a.prev = argv[++i];
    else if (t === "--records") a.records = argv[++i];
  }
  return a;
}

// The canon "memories" every Three Doors image is grounded against.
const CANON_EVIDENCE = [
  "three-doors:cast-canon",     // locked hand-drawn cast (Lantern/Eclipse/Keystone/Blinkbug)
  "three-doors:creed",          // the King of Hearts creed
  "three-doors:art-direction",  // surreal / adult / atmospheric steer
  "three-doors:ref:lantern",    // hand-drawn reference (source of truth, on CDN)
  "three-doors:ref:eclipse",
  "three-doors:ref:keystone",
  "three-doors:ref:blinkbug",
];

// Walk up from a starting dir to find the repo root (holds the canonical emitter).
function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "apps/lantern-garage/lib/convergence-records.js"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const evidence_ids = [...CANON_EVIDENCE, ...(a.prev ? [a.prev] : []), ...a.evidence];
  const result = {
    kind: "three-doors-scene-image",
    scene: a.scene || null,
    beat: a.beat || null,
    image: a.image || null,
  };
  const hypothesis =
    `Three Doors scene image${a.beat ? ` — "${a.beat}"` : ""} faithfully depicts the Kingdome canon ` +
    "(cast on-model, no fox, no stray text).";
  const notes =
    a.notes ||
    (a.canonOk
      ? "canon-check passed: cast matches the hand-drawn reference, no fox, no lettering."
      : "canon-check FAILED: image drifted from the hand-drawn canon — regenerate.");
  const confidence = Math.max(0, Math.min(1, Number(a.confidence) || 0));

  const repoRoot = findRepoRoot(a.records ? path.dirname(a.records) : process.cwd());

  // Preferred: the repo's canonical emitter (append-queue + rotation, #872).
  if (repoRoot) {
    try {
      const { emitConvergenceRecord } = require(path.join(repoRoot, "apps/lantern-garage/lib/convergence-records.js"));
      const rec = await emitConvergenceRecord({
        hypothesis,
        evidence_ids,
        result,
        confidence,
        reasoner: "three-doors-game",
        verified: a.canonOk,
        verification_notes: notes,
        source: "skills/three-doors-game (image-per-turn)",
      });
      console.log(JSON.stringify({ ok: !!rec, id: rec && rec.id, records: "data/convergence/records.jsonl", via: "emitter" }));
      return;
    } catch (_e) {
      /* fall through to the self-contained append */
    }
  }

  // Fallback: self-contained append with the identical schema (same file).
  const records = a.records || path.join(repoRoot || process.cwd(), "data/convergence/records.jsonl");
  const rec = {
    id: `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    hypothesis,
    evidence_ids: evidence_ids.map(String),
    result,
    confidence,
    reasoner: "three-doors-game",
    timestamp: new Date().toISOString(),
    verified: Boolean(a.canonOk),
    verification_notes: notes,
    source: "skills/three-doors-game (image-per-turn)",
    applied_evidence: [],
    grounding_signals: [],
    allowed_max_confidence: null,
  };
  try {
    fs.mkdirSync(path.dirname(records), { recursive: true });
    fs.appendFileSync(records, JSON.stringify(rec) + "\n");
    console.log(JSON.stringify({ ok: true, id: rec.id, records, via: "fallback" }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }
}

main();
