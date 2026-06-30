#!/usr/bin/env node
/**
 * Release Manager v1.0 — Version bumping + changelog automation
 * Usage: node scripts/release-manager.js [major|minor|patch] [--auto-changelog]
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const args = process.argv.slice(2);
const bumpType = args[0] || 'patch'; // major, minor, or patch
const autoChangelog = args.includes('--auto-changelog');

const ROOT = path.join(__dirname, '..');
const PKG_MAIN = path.join(ROOT, 'package.json');
const PKG_APP = path.join(ROOT, 'apps/lantern-garage/package.json');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.MD');

// Parse version
function parseVersion(v) {
  const [major, minor, patch] = v.split('.').map(Number);
  return { major, minor, patch };
}

function formatVersion(major, minor, patch) {
  return `${major}.${minor}.${patch}`;
}

function bumpVersion(current, type) {
  const { major, minor, patch } = parseVersion(current);
  const newMajor = type === 'major' ? major + 1 : major;
  const newMinor = type === 'minor' ? minor + 1 : (type === 'major' ? 0 : minor);
  const newPatch = type === 'patch' ? patch + 1 : 0;
  return formatVersion(newMajor, newMinor, newPatch);
}

function updatePackageJson(file, newVersion) {
  const content = fs.readFileSync(file, 'utf-8');
  const updated = content.replace(
    /"version":\s*"[^"]+"/,
    `"version": "${newVersion}"`
  );
  fs.writeFileSync(file, updated);
  console.log(`✓ Updated ${path.relative(ROOT, file)} → ${newVersion}`);
}

function getCommitsSince(lastTag) {
  try {
    return execFileSync('git', ['log', `${lastTag}..HEAD`, '--pretty=format:%s'], { cwd: ROOT, encoding: 'utf-8' })
      .split('\n')
      .filter(l => l.trim())
      .slice(0, 20); // Last 20 commits
  } catch {
    return [];
  }
}

function generateChangelogEntry(newVersion, commits) {
  const date = new Date().toISOString().split('T')[0];
  const build = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  const commit = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf-8' }).trim();

  const sections = {
    feat: [],
    fix: [],
    docs: [],
    refactor: [],
    perf: [],
    test: [],
    other: []
  };

  commits.forEach(commit => {
    if (commit.startsWith('feat:')) sections.feat.push(commit.slice(6).trim());
    else if (commit.startsWith('fix:')) sections.fix.push(commit.slice(5).trim());
    else if (commit.startsWith('docs:')) sections.docs.push(commit.slice(6).trim());
    else if (commit.startsWith('refactor:')) sections.refactor.push(commit.slice(10).trim());
    else if (commit.startsWith('perf:')) sections.perf.push(commit.slice(6).trim());
    else if (commit.startsWith('test:')) sections.test.push(commit.slice(6).trim());
    else sections.other.push(commit.substring(0, 80));
  });

  let entry = `## [${newVersion}] - ${date}\n`;
  entry += `**Build:** ${newVersion}+${build}\n`;
  entry += `**Commit:** ${commit}\n\n`;

  if (sections.feat.length) entry += `### ✨ Features\n${sections.feat.map(f => `- ${f}`).join('\n')}\n\n`;
  if (sections.fix.length) entry += `### 🐛 Fixes\n${sections.fix.map(f => `- ${f}`).join('\n')}\n\n`;
  if (sections.docs.length) entry += `### 📚 Documentation\n${sections.docs.map(d => `- ${d}`).join('\n')}\n\n`;
  if (sections.refactor.length) entry += `### ♻️ Refactoring\n${sections.refactor.map(r => `- ${r}`).join('\n')}\n\n`;
  if (sections.perf.length) entry += `### ⚡ Performance\n${sections.perf.map(p => `- ${p}`).join('\n')}\n\n`;
  if (sections.test.length) entry += `### ✅ Tests\n${sections.test.map(t => `- ${t}`).join('\n')}\n\n`;
  if (sections.other.length) entry += `### 📋 Other\n${sections.other.map(o => `- ${o}`).join('\n')}\n\n`;

  entry += '# 📚 Before pushing: Did you read these?\n';
  entry += '#    □ QUICKSTART.md (dual-boot system)\n';
  entry += '#    □ AGENTS.md (monoworkstream rules)\n';
  entry += '#    □ CLAUDE.md (project architecture)\n\n';
  entry += '---\n\n';

  return entry;
}

// Main
try {
  const pkg = JSON.parse(fs.readFileSync(PKG_MAIN, 'utf-8'));
  const currentVersion = pkg.version;
  const newVersion = bumpVersion(currentVersion, bumpType);

  console.log(`📦 Bumping ${currentVersion} → ${newVersion} (${bumpType})\n`);

  // Update package.json files
  updatePackageJson(PKG_MAIN, newVersion);
  updatePackageJson(PKG_APP, newVersion);

  // Update CHANGELOG
  if (autoChangelog) {
    const lastTag = execSync('git describe --tags --abbrev=0', { cwd: ROOT, encoding: 'utf-8' }).trim();
    const commits = getCommitsSince(lastTag);
    const entry = generateChangelogEntry(newVersion, commits);
    const changelog = fs.readFileSync(CHANGELOG, 'utf-8');
    fs.writeFileSync(CHANGELOG, entry + changelog);
    console.log(`✓ Updated CHANGELOG.MD with ${commits.length} commits`);
  }

  // Commit — shell-free: file list + message are discrete argv elements.
  execFileSync('git', [
    'add', 'package.json', 'apps/lantern-garage/package.json',
    ...(autoChangelog ? ['CHANGELOG.MD'] : []),
  ], { cwd: ROOT });
  execFileSync('git', [
    'commit', '-m',
    `chore(release): bump to ${newVersion}${autoChangelog ? ' + auto-changelog' : ''}\n\nCo-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>`,
  ], { cwd: ROOT });
  console.log(`✓ Committed version bump`);

  console.log(`\n✅ Version bump complete. Ready to tag & release.`);
  console.log(`\n  Next: git tag ${newVersion} && git push origin master --tags`);
} catch (e) {
  console.error('❌ Release failed:', e.message);
  process.exit(1);
}
