#!/usr/bin/env node
/**
 * assemble-changelog.js — fold changelog.d/ fragments into CHANGELOG.MD
 *
 * Concurrent PRs each drop a uniquely-named fragment into `changelog.d/` instead
 * of editing the single CHANGELOG.MD (which file-locked the auto-merge zipper).
 * This script — run on master at release time — collects every fragment, bumps
 * the version ONCE, writes a single `## [X.X.X] - DATE` entry assembled from all
 * fragments, deletes the consumed fragments, and refreshes version.json.
 *
 * Usage:
 *   node scripts/assemble-changelog.js            # patch bump (default)
 *   node scripts/assemble-changelog.js minor      # or major
 *   node scripts/assemble-changelog.js --check     # list pending fragments, no writes
 *
 * Idempotent: a no-fragment run is a no-op (exit 0, nothing changed).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FRAG_DIR = path.join(ROOT, 'changelog.d');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.MD');
const PKG_MAIN = path.join(ROOT, 'package.json');
const PKG_APP = path.join(ROOT, 'apps/lantern-garage/package.json');
const VERSION_JSON = path.join(ROOT, 'apps/lantern-garage/version.json');

// Filename prefix -> default section for un-sectioned bullets.
const PREFIX_SECTION = {
  feat: '### Added',
  fix: '### Fixed',
  change: '### Changed',
  verify: '### Verify',
  test: '### Tests',
  cleanup: '### Cleanup',
};
const DEFAULT_SECTION = '### Changed';
// Stable display order for assembled sections.
const SECTION_ORDER = [
  '### Added', '### Fixed', '### Changed', '### Verify',
  '### Tests', '### Cleanup', '### Performance', '### Other',
];

function listFragments() {
  if (!fs.existsSync(FRAG_DIR)) return [];
  return fs
    .readdirSync(FRAG_DIR)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => f !== 'README.md' && !f.startsWith('_') && !f.startsWith('.'))
    .sort()
    .map((f) => path.join(FRAG_DIR, f));
}

function prefixSection(filename) {
  const base = path.basename(filename).toLowerCase();
  const m = base.match(/^([a-z]+)-/);
  if (m && PREFIX_SECTION[m[1]]) return PREFIX_SECTION[m[1]];
  return DEFAULT_SECTION;
}

/**
 * Parse a fragment into { section -> [bullets...] }. Lines under an explicit
 * `### Section` header go there; bullets before any header go to the filename's
 * default section.
 */
function parseFragment(file) {
  const text = fs.readFileSync(file, 'utf-8');
  const fallback = prefixSection(file);
  const out = {};
  let current = fallback;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const header = line.match(/^#{2,4}\s+(.*)$/);
    if (header) {
      let title = header[1].trim();
      // Normalize "Added"/"### Added"/"## Fixed" -> "### Added"
      current = '### ' + title.replace(/^#+\s*/, '');
      continue;
    }
    (out[current] = out[current] || []).push(line.startsWith('-') ? line : `- ${line}`);
  }
  return out;
}

function parseVersion(v) {
  const [major, minor, patch] = String(v).split('.').map(Number);
  return { major, minor, patch };
}

function bump(current, type) {
  const { major, minor, patch } = parseVersion(current);
  if (type === 'major') return `${major + 1}.0.0`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function updatePackageVersion(file, newVersion) {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf-8');
  fs.writeFileSync(
    file,
    content.replace(/"version":\s*"[^"]+"/, `"version": "${newVersion}"`),
  );
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function buildEntry(version, merged) {
  let entry = `## [${version}] - ${todayISO()}\n\n`;
  const sections = Object.keys(merged).sort((a, b) => {
    const ia = SECTION_ORDER.indexOf(a);
    const ib = SECTION_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  for (const section of sections) {
    entry += `${section}\n${merged[section].join('\n')}\n\n`;
  }
  return entry;
}

function insertIntoChangelog(entry) {
  let changelog = fs.existsSync(CHANGELOG) ? fs.readFileSync(CHANGELOG, 'utf-8') : '# Changelog\n';
  // Insert above the most recent released version, keeping the header pinned.
  const firstRelease = changelog.search(/^## \[\d+\.\d+\.\d+/m);
  if (firstRelease === -1) {
    fs.writeFileSync(CHANGELOG, changelog.replace(/\n*$/, '\n\n') + entry);
  } else {
    const head = changelog.slice(0, firstRelease);
    const rest = changelog.slice(firstRelease);
    fs.writeFileSync(CHANGELOG, head + entry + rest);
  }
}

function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const bumpType = args.find((a) => ['major', 'minor', 'patch'].includes(a)) || 'patch';

  const fragments = listFragments();
  if (fragments.length === 0) {
    console.log('No changelog fragments pending — nothing to assemble.');
    return 0;
  }

  if (checkOnly) {
    console.log(`${fragments.length} pending fragment(s):`);
    fragments.forEach((f) => console.log(`  - changelog.d/${path.basename(f)}`));
    return 0;
  }

  // Merge all fragments by section.
  const merged = {};
  for (const f of fragments) {
    const parsed = parseFragment(f);
    for (const [section, bullets] of Object.entries(parsed)) {
      (merged[section] = merged[section] || []).push(...bullets);
    }
  }

  const pkg = JSON.parse(fs.readFileSync(PKG_MAIN, 'utf-8'));
  const newVersion = bump(pkg.version, bumpType);

  insertIntoChangelog(buildEntry(newVersion, merged));
  updatePackageVersion(PKG_MAIN, newVersion);
  updatePackageVersion(PKG_APP, newVersion);

  // Refresh version.json for client display (best-effort).
  try {
    const now = new Date().toISOString();
    fs.writeFileSync(
      VERSION_JSON,
      JSON.stringify(
        { version: newVersion, buildId: `${newVersion}+${now.slice(0, 10)}`, timestamp: now, branch: 'master' },
        null,
        2,
      ) + '\n',
    );
  } catch { /* non-fatal */ }

  // Delete consumed fragments.
  fragments.forEach((f) => fs.unlinkSync(f));

  console.log(`✓ Assembled ${fragments.length} fragment(s) into CHANGELOG.MD`);
  console.log(`✓ Version bumped ${pkg.version} → ${newVersion} (${bumpType})`);
  console.log(`✓ Removed ${fragments.length} consumed fragment(s) from changelog.d/`);
  console.log(`\n  Commit: git add -A && git commit -m "chore(release): ${newVersion}"`);
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { listFragments, parseFragment, bump, buildEntry };
