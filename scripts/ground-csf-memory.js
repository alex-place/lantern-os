#!/usr/bin/env node
/**
 * Σ₀-ground the data/csf_memory registry: give every record a human-readable
 * `description` and a small `grounding` block inside its existing `metadata`
 * field, then re-stamp the checksum under the one sound canonical scheme
 * (csf-memory-writer.js `_checksum`).
 *
 * Why this exists
 * ---------------
 * The CSF memory store is the Remember stage of the Σ₀ loop, but its records
 * carried an empty `metadata: {}` — they stored *what happened* with no
 * self-describing summary of what the record IS or which loop stage it serves.
 * This makes the store self-describing (the same intent as adding per-file
 * `description`/`metadata` to CSF-Pack archives) so recall surfaces can show a
 * one-line gloss and filter by loop stage without re-parsing raw content.
 *
 * What it writes (only inside `metadata` — the 23-field record schema is left
 * exactly as-is, guarded by tests/test_csf_memory_integrity.py):
 *   metadata.description : one-line gloss derived deterministically from content
 *   metadata.grounding   : { schema, kind, loop_stage, object, source }
 * Any pre-existing metadata keys (e.g. news impact/sentiment) are preserved.
 *
 * Idempotent: derives everything from record content (no wall-clock), so a
 * second run produces byte-identical output. Re-stamps checksums with the sound
 * scheme, so every record stays classified "js-canonical" by the integrity test.
 *
 * Safety
 * ------
 * - DRY-RUN BY DEFAULT: prints what would change, writes nothing.
 * - `--apply` rewrites the file(s) after copying each to `<file>.bak-<ts>`.
 * - Records whose grounding + checksum are already current are left byte-identical.
 *
 * Usage
 * -----
 *   node scripts/ground-csf-memory.js                 # dry-run, default registries
 *   node scripts/ground-csf-memory.js --apply         # ground + re-stamp + back up
 *   node scripts/ground-csf-memory.js --apply path/to/raw.jsonl [more.jsonl ...]
 */

const fs = require("fs");
const path = require("path");

const csfWriter = require("../lib/csf-memory-writer");

const repoRoot = path.resolve(__dirname, "..");
const GROUNDING_SCHEMA = "sigma0-memory-grounding-1";

function defaultRegistries() {
  const dir = csfWriter._csfMemoryPath();
  return ["raw", "refined", "canon", "archive"]
    .map((p) => path.join(dir, `${p}.jsonl`))
    .filter((f) => fs.existsSync(f));
}

function trunc(s, n) {
  s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Deterministically derive { kind, loop_stage, description } from a record.
 * loop_stage names the loop stage the recorded *event* belongs to (Observe for
 * signals/news, Act for orders, Reason for chat/convergence); the record itself
 * always serves the Memory object.
 */
function derive(rec) {
  const c = (rec && rec.content) || {};
  const tags = Array.isArray(rec.tags) ? rec.tags : [];
  const surface = rec.source_surface || "";
  const raw = (c && c.raw) || {};

  if (c.headline || tags.includes("news") || surface.includes("news")) {
    const src = c.source ? ` (${c.source})` : "";
    return { kind: "news", loop_stage: "Observe",
      description: `Market news — ${trunc(c.headline || c.text, 140)}${src}` };
  }
  if (c.event === "order" || c.order_id || tags.includes("order")) {
    const side = String(c.side || "").toUpperCase();
    const qty = c.qty != null ? `${c.qty} ` : "";
    const sym = c.symbol || "";
    const status = c.status ? ` [${c.status}]` : "";
    return { kind: "order", loop_stage: "Act",
      description: trunc(`Trading order — ${side} ${qty}${sym}${status}`.replace(/\s+/g, " ").trim(), 140) };
  }
  if (c.event === "convergance" || tags.includes("convergance")) {
    return { kind: "convergance", loop_stage: "Reason",
      description: `Convergence — ${trunc(c.question || c.text, 160)}` };
  }
  if (c.event === "signal" || c.signal_id || tags.includes("signal") || c.agent || raw.agent) {
    const agent = c.agent || raw.agent || "agent";
    const body = c.body || raw.body || c.text || c.action || "";
    return { kind: "signal", loop_stage: "Observe",
      description: trunc(`Trading signal — ${agent}: ${body}`.trim(), 160) };
  }
  if (surface.includes("chat") || c.session_id) {
    return { kind: "chat", loop_stage: "Reason",
      description: `Chat trace — ${trunc(c.text || c.raw_input, 160)}` };
  }
  if (rec.tier === "entity") {
    return { kind: "entity", loop_stage: "Remember",
      description: `Entity — ${trunc(c.text || c.name || JSON.stringify(c), 160)}` };
  }
  return { kind: "trace", loop_stage: "Remember",
    description: `${surface || "trace"} — ${trunc(c.text || JSON.stringify(c), 160)}` };
}

/** Return true if the record's metadata already carries current grounding. */
function isGrounded(rec, d) {
  const md = rec.metadata || {};
  const g = md.grounding;
  return !!(g && g.schema === GROUNDING_SCHEMA &&
    md.description === d.description && g.kind === d.kind &&
    g.loop_stage === d.loop_stage);
}

function groundFile(file, apply, stamp) {
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split(/\r?\n/);
  let total = 0;
  let changed = 0;
  let unparsable = 0;
  const out = [];

  for (const line of lines) {
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      unparsable++;
      out.push(line);
      continue;
    }
    total++;
    const d = derive(rec);
    const existingMd = rec.metadata && typeof rec.metadata === "object" ? rec.metadata : {};
    // Preserve any pre-existing metadata (e.g. news impact/sentiment); overlay grounding.
    rec.metadata = {
      ...existingMd,
      description: d.description,
      grounding: {
        schema: GROUNDING_SCHEMA,
        kind: d.kind,
        loop_stage: d.loop_stage,
        object: "Memory",
        source: rec.source_surface || "",
      },
    };
    const sound = csfWriter._checksum(rec);
    const before = line;
    rec.checksum = sound;
    const after = JSON.stringify(rec);
    if (after !== before) changed++;
    out.push(after);
  }

  const rel = path.relative(repoRoot, file);
  console.log(
    `${rel}: ${total} records, ${changed} to ground/re-stamp` +
      (unparsable ? `, ${unparsable} unparsable (left untouched)` : "")
  );

  if (apply && changed > 0) {
    const backup = `${file}.bak-${stamp}`;
    fs.copyFileSync(file, backup);
    const trailing = raw.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(file, out.join("\n").replace(/\n+$/, "") + trailing, "utf8");
    console.log(`  -> grounded; backup at ${path.relative(repoRoot, backup)}`);
  }
  return { total, changed, unparsable };
}

function main(argv) {
  const args = argv.slice(2);
  const apply = args.includes("--apply");
  const files = args.filter((a) => !a.startsWith("--"));
  const targets = files.length ? files.map((f) => path.resolve(f)) : defaultRegistries();

  if (!targets.length) {
    console.log("No csf_memory registries found.");
    return 0;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  console.log(apply ? "GROUND (apply)\n" : "DRY-RUN (no changes written; pass --apply to write)\n");

  let totalChanged = 0;
  for (const f of targets) {
    if (!fs.existsSync(f)) {
      console.log(`${path.relative(repoRoot, f)}: not found, skipping`);
      continue;
    }
    totalChanged += groundFile(f, apply, stamp).changed;
  }

  if (!apply && totalChanged > 0) {
    console.log(`\n${totalChanged} record(s) would be grounded/re-stamped. Re-run with --apply to write.`);
  } else if (apply) {
    console.log(`\nDone. ${totalChanged} record(s) grounded.`);
  } else {
    console.log("\nAll records already grounded under the current schema. Nothing to do.");
  }
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { groundFile, derive, GROUNDING_SCHEMA };
