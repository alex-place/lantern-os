#!/usr/bin/env node
/**
 * Run the apps/lantern-garage/test suite — all of it.
 *
 * Why this exists
 * ---------------
 * On 2026-08-18 that directory held 305 test files and CI ran FIVE, named one by
 * one in workflow YAML. The other 300 had never run in CI. They were not skipped
 * or disabled; nothing referenced them, so nobody noticed. That included every
 * suite shipped with the 1.15.4 trader work — alert-engine, mfe-mae, track-record,
 * scorecard-breakdown, chat-trader-tools, ledger-attribution — all written, all
 * passing locally, all invisible to the pipeline they were supposed to protect.
 *
 * Naming each file by hand guarantees this: the list is written once and every
 * test added afterwards is dark by default. So this runner globs instead, and new
 * test files are protected the moment they land.
 *
 * The ratchet
 * -----------
 * 26 of the 305 did not pass when this landed. Turning them all on would have made
 * the job permanently red, and a permanently-red job is one people learn to scroll
 * past. They are listed in `apps/lantern-garage/test/.quarantine` and skipped —
 * but they are still RUN, and if a quarantined test starts passing this exits
 * non-zero and tells you to delete the line. The list can only shrink.
 *
 * The first CI run then taught us the list needs two kinds of entry: a test can
 * fail because it is broken, or because of the machine it is on. `env:` entries
 * cover the second (see parkLists below) and are never ratcheted.
 *
 * Usage:  node scripts/run-garage-tests.mjs [--quarantine-only] [--concurrency N]
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(REPO, 'apps', 'lantern-garage', 'test');
const QUARANTINE = path.join(TEST_DIR, '.quarantine');

const argv = process.argv.slice(2);
const quarantineOnly = argv.includes('--quarantine-only');
const ci = Number(argv[argv.indexOf('--concurrency') + 1]) || 4;
const PER_TEST_TIMEOUT_MS = 90_000;

/**
 * Two kinds of parked test, and conflating them breaks the ratchet.
 *
 *   plain `name.test.js`      broken — ratcheted. If it starts passing, the build
 *                             fails until the line is deleted, so the list shrinks.
 *
 *   `env: name.test.js`       environment-dependent — skipped, NOT ratcheted. Its
 *                             result is a property of the machine, not the code:
 *                             the local-model suites pass on the 8GB dev box and
 *                             fail on a hosted runner that has no model. Ratcheting
 *                             those makes the build fail on whichever machine
 *                             happens to satisfy them — red locally OR red in CI,
 *                             with no edit that satisfies both.
 */
function parkLists() {
  const broken = new Set();
  const envDependent = new Set();
  if (!existsSync(QUARANTINE)) return { broken, envDependent };
  for (const raw of readFileSync(QUARANTINE, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^env:\s*(.+)$/);
    if (m) envDependent.add(m[1].trim());
    else broken.add(line);
  }
  return { broken, envDependent };
}

function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', path.join(TEST_DIR, file)], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    // A hung test must not hang the pipeline; killing it counts as a failure.
    const timer = setTimeout(() => child.kill('SIGKILL'), PER_TEST_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ file, ok: code === 0, out });
    });
  });
}

async function runAll(files) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(ci, files.length) }, async () => {
    while (i < files.length) results.push(await runOne(files[i++]));
  });
  await Promise.all(workers);
  return results;
}

const all = readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.js')).sort();
const { broken, envDependent } = parkLists();
const enforced = all.filter((f) => !broken.has(f) && !envDependent.has(f));
const parked = all.filter((f) => broken.has(f));          // ratcheted
const envParked = all.filter((f) => envDependent.has(f)); // skipped outright

// An entry naming a file that no longer exists is stale bookkeeping — say so, so
// the list stays honest as tests are renamed or deleted.
const ghosts = [...broken, ...envDependent].filter((f) => !all.includes(f));

console.log(
  `garage suite: ${all.length} files — ${enforced.length} enforced, ` +
  `${parked.length} quarantined, ${envParked.length} environment-dependent (skipped)`
);

const enforcedResults = quarantineOnly ? [] : await runAll(enforced);
const failed = enforcedResults.filter((r) => !r.ok);

for (const r of failed) {
  console.log(`\n──────── FAIL ${r.file}`);
  console.log(r.out.split('\n').filter((l) => /✖|Error|AssertionError|actual:|expected:/.test(l)).slice(0, 12).join('\n'));
}

// The ratchet: anything parked that now passes must leave the list.
const parkedResults = await runAll(parked);
const recovered = parkedResults.filter((r) => r.ok).map((r) => r.file);

console.log(`\nenforced : ${enforced.length - failed.length}/${enforced.length} passing`);
console.log(`quarantined: ${parked.length - recovered.length} still failing, ${recovered.length} now passing`);
if (ghosts.length) console.log(`stale quarantine entries (file not found): ${ghosts.join(', ')}`);

let exit = 0;
if (failed.length) {
  console.log(`\n::error::${failed.length} enforced test file(s) failed: ${failed.map((f) => f.file).join(', ')}`);
  exit = 1;
}
if (recovered.length) {
  console.log(
    `\n::error::${recovered.length} quarantined test(s) now PASS — delete them from ` +
    `apps/lantern-garage/test/.quarantine so they stay protected: ${recovered.join(', ')}`
  );
  exit = 1;
}
if (ghosts.length) {
  console.log(`\n::error::quarantine lists files that do not exist: ${ghosts.join(', ')}`);
  exit = 1;
}
if (!exit) console.log('\nOK — every enforced test passed and the quarantine list is accurate.');
process.exit(exit);
