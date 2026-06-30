#!/usr/bin/env node
/**
 * Re-stamp data/csf_memory registry checksums under the single sound
 * canonical scheme (csf-memory-writer.js `_checksum`: recursive key-sort over
 * the whole record, nested content included).
 *
 * Why this exists
 * ---------------
 * data/csf_memory/raw.jsonl accumulated records from three incompatible
 * checksum schemes:
 *   1. Python   `json.dumps(payload, sort_keys=True, ensure_ascii=False)`  (memory_engine.py)
 *   2. JS sound `_canonicalJson` recursive key-sort                        (csf-memory-writer.js)
 *   3. JS broken `JSON.stringify(payload, Object.keys(payload).sort())`    (old trading-memory.js / trading-news.js)
 * Scheme 3 passed the key list as a *replacer allowlist*, not a sort, so the
 * nested content.* payload was excluded from the hash — i.e. tampering the
 * actual order/signal/news body did not change the checksum. Every record in
 * raw.jsonl (373/373 at time of writing) was scheme 3 and failed
 * MemoryRecord.verify().
 *
 * This script recomputes each record's checksum with the sound scheme so the
 * registry has one consistent, content-covering integrity stamp going forward.
 *
 * Safety
 * ------
 * - DRY-RUN BY DEFAULT: prints what would change, writes nothing.
 * - `--apply` rewrites the file(s) after copying each to `<file>.bak-<ts>`.
 * - Records already matching the sound scheme are left byte-identical.
 * - This rewrites an append-only registry in place; it is a one-time data
 *   repair, not a routine operation. Run it deliberately, with a clean git
 *   tree, and review the diff.
 *
 * Usage
 * -----
 *   node scripts/restamp-csf-memory.js                 # dry-run, default registries
 *   node scripts/restamp-csf-memory.js --apply         # re-stamp + back up
 *   node scripts/restamp-csf-memory.js --apply path/to/raw.jsonl [more.jsonl ...]
 */

const fs = require("fs");
const path = require("path");

const csfWriter = require("../apps/lantern-garage/lib/csf-memory-writer");

const repoRoot = path.resolve(__dirname, "..");

function defaultRegistries() {
  const dir = csfWriter._csfMemoryPath();
  return ["raw", "refined", "canon", "archive"]
    .map((p) => path.join(dir, `${p}.jsonl`))
    .filter((f) => fs.existsSync(f));
}

function restampFile(file, apply, stamp) {
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split(/\r?\n/);
  let changed = 0;
  let total = 0;
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
      out.push(line); // preserve unparsable lines untouched
      continue;
    }
    total++;
    const sound = csfWriter._checksum(rec);
    if (rec.checksum !== sound) {
      rec.checksum = sound;
      changed++;
    }
    out.push(JSON.stringify(rec));
  }

  const rel = path.relative(repoRoot, file);
  console.log(
    `${rel}: ${total} records, ${changed} need re-stamp` +
      (unparsable ? `, ${unparsable} unparsable (left untouched)` : "")
  );

  if (apply && changed > 0) {
    const backup = `${file}.bak-${stamp}`;
    fs.copyFileSync(file, backup);
    // Preserve a trailing newline if the original had one.
    const trailing = raw.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(file, out.join("\n").replace(/\n+$/, "") + trailing, "utf8");
    console.log(`  -> re-stamped; backup at ${path.relative(repoRoot, backup)}`);
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

  // Date is allowed here (plain CLI, not a Workflow script).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  console.log(apply ? "RE-STAMP (apply)\n" : "DRY-RUN (no changes written; pass --apply to write)\n");

  let totalChanged = 0;
  for (const f of targets) {
    if (!fs.existsSync(f)) {
      console.log(`${path.relative(repoRoot, f)}: not found, skipping`);
      continue;
    }
    totalChanged += restampFile(f, apply, stamp).changed;
  }

  if (!apply && totalChanged > 0) {
    console.log(`\n${totalChanged} record(s) would be re-stamped. Re-run with --apply to write.`);
  } else if (apply) {
    console.log(`\nDone. ${totalChanged} record(s) re-stamped.`);
  } else {
    console.log("\nAll records already match the sound checksum scheme. Nothing to do.");
  }
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { restampFile };
