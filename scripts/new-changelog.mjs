#!/usr/bin/env node
/**
 * new-changelog.mjs — create a conflict-free changelog fragment.
 *
 * Every PR drops its own uniquely-named, TIMESTAMPED fragment under
 * changelog.d/ instead of editing the single CHANGELOG.MD or bumping the
 * version. Because the filename carries a millisecond timestamp, two concurrent
 * PRs never touch the same file — nothing to merge-conflict.
 * scripts/assemble-changelog.js folds every fragment into CHANGELOG.MD and bumps
 * the version ONCE, at release time.
 *
 * Usage:
 *   node scripts/new-changelog.mjs "what changed and why"
 *   node scripts/new-changelog.mjs "Fixed the thing" --kind fixed   # added|fixed|changed
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRAG_DIR = path.join(ROOT, 'changelog.d');

const argv = process.argv.slice(2);
let kind = 'changed';
const kindIdx = argv.indexOf('--kind');
if (kindIdx !== -1) {
  kind = (argv[kindIdx + 1] || 'changed').toLowerCase();
  argv.splice(kindIdx, 2);
}
const summary = argv.join(' ').trim();

if (!summary) {
  console.error('usage: node scripts/new-changelog.mjs "what changed and why" [--kind added|fixed|changed]');
  process.exit(1);
}
const SECTION = { added: 'Added', fixed: 'Fixed', changed: 'Changed' }[kind] || 'Changed';

// filesystem-safe millisecond timestamp: 2026-07-11T20-15-30-123Z
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const slug =
  summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'change';
const name = `${ts}-${slug}.md`;

fs.mkdirSync(FRAG_DIR, { recursive: true });
const body = `### ${SECTION}\n\n- ${summary}\n`;
fs.writeFileSync(path.join(FRAG_DIR, name), body, 'utf-8');
console.log(`changelog.d/${name}`);
