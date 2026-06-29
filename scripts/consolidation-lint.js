#!/usr/bin/env node
/**
 * consolidation-lint.js — top-down "squeeze & consolidate" linter.
 *
 * The repo's North Star is anti-sprawl (CLAUDE.md): one loop, four objects,
 * "prefer extension over addition." Sprawl accretes as duplicate files, stray
 * scratch artifacts, and un-modernised code. The diff-scoped slop-check
 * (.github/workflows/slop-check.yml + scripts/hooks/pre-commit) catches *new*
 * slop; nothing scans the *whole tree* for accumulated debt. This does.
 *
 * It is one self-contained, dependency-free Node script (no eslint, no new
 * subsystem) that enumerates tracked files via `git ls-files` and reports:
 *
 *   DEDUPLICATE  exact-duplicate     identical content in 2+ files          HIGH
 *                duplicate-basename  same filename across dirs (consolidate) MED
 *   SQUEEZE      stray-file          tracked temp/backup/scratch artifact    HIGH
 *                loose-root-file     un-allowlisted scratch at repo root     MED
 *   MODERNIZE    unsafe-exec         exec/spawn on interpolated input        HIGH
 *                legacy-var          `var` declarations (use const/let)      LOW
 *   CONSOLIDATE  duplicate-merger    2nd PR auto-merger (`gh pr merge`)      HIGH
 *                forbidden-subsystem CLAUDE.md banned subsystem name (advice) INFO
 *
 * Modes:
 *   (default)   scan the whole tracked tree, print a report, exit 0.
 *   --staged    scan only staged files (fast; for the pre-commit hook).
 *   --strict    exit 1 if any HIGH finding is present (gate mode).
 *   --json      machine-readable output.
 *   --fix       untrack obvious stray/junk files (git rm --cached, keeps disk).
 *               Never auto-deletes duplicates — canonical choice is yours.
 *
 * Exit 0 = clean (or report-only). Exit 1 = HIGH findings under --strict.
 */
'use strict';

const { execSync, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const args = new Set(process.argv.slice(2));
const STAGED = args.has('--staged');
const STRICT = args.has('--strict') || (STAGED && !args.has('--no-strict'));
const JSON_OUT = args.has('--json');
const FIX = args.has('--fix');
if (args.has('--help') || args.has('-h')) { printHelp(); process.exit(0); }

const REPO = sh('git rev-parse --show-toplevel');

// ── classification tables ───────────────────────────────────────────────────
const SEV = { HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };

// Filenames that are *meant* to repeat across the tree — never a dup signal.
const UBIQUITOUS = new Set([
  '__init__.py', 'README.md', 'README.rst', 'readme.md', 'index.html',
  'index.js', 'setup.py', 'conftest.py', 'pytest.ini', 'pyproject.toml',
  'setup.cfg', 'package.json', 'package-lock.json', '.gitignore', '.gitkeep',
  '.gitattributes', 'Makefile', 'Dockerfile', '.env.example', 'tsconfig.json',
  'SKILL.md', 'requirements.txt', 'CHANGELOG.MD', 'changelog.md',
]);

// Root-level filenames that legitimately live at the repo root.
const ROOT_ALLOW = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'tsconfig.json', 'jsconfig.json', 'pytest.ini', 'pyproject.toml',
  'setup.cfg', 'setup.py', 'requirements.txt', 'Makefile', 'Dockerfile',
  'docker-compose.yml', 'manifest.json', '.prettierrc', '.eslintrc.json',
  'railway.json', 'render.yaml', 'vercel.json', 'jest.config.js',
  'playwright.config.js', 'tailwind.config.js',
]);

// Extensions whose content we hash for exact-dup + read for modernize rules.
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.ps1',
  '.html', '.css', '.json', '.md', '.yml', '.yaml', '.toml', '.sql',
]);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.ps1']);
const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);

// Directories whose files differ *by design* (append-only logs, datasets,
// model weights) — exclude from content-dup and basename-dup.
const DATA_DIR = /^(data|models|notebooks|manifests|\.claude)\//;
const VENDOR = /(^|\/)(node_modules|dist|build|vendor|\.venv|__pycache__)\//;
const TEST_FILE = /(^|\/)(tests?|__tests__)\/|(^|[._-])test[._-]|\.test\.|_test\./i;

const MAX_HASH_BYTES = 2 * 1024 * 1024; // skip files > 2MB for content-dup

// Stray / junk artifacts that should never be tracked.
const STRAY = [
  /\.(tmp|bak|orig|swp|swo|rej|old)$/i,
  /~$/,
  /(^|[._-])tmp([._-]|$)/i,      // tmp.js, steptoe_tmp.html, x-tmp.json
  /(^|[._-])scratch([._-]|$)/i,
  /\.(log)$/i,                    // committed logs
  /^.*\.(py|js)\.orig$/i,
];

// CLAUDE.md forbidden subsystems (advisory consolidation flags).
const FORBIDDEN_SUBSYSTEM = [
  { re: /dream[-_]?engine/i, why: 'separate dream engine (use a reasoning strategy)' },
  { re: /digital[-_]?twin/i, why: 'digital-twin / simulation (persistence ≠ simulation)' },
  { re: /mind[-_]?upload/i, why: 'mind-uploading concept (out of scope)' },
  { re: /(^|\/)bci[-_]/i, why: 'BCI concept (out of scope)' },
];

// MONO-MERGER RULE (anti-sprawl): the repo must have exactly ONE PR auto-merger.
// Canonical = apps/lantern-garage/lib/pr-watcher.js (review + verdict gate +
// protected-path gate + self-healing ignore-list). Any OTHER executable file that
// lands PRs via `gh pr merge` is a competing merger — sprawl — and is flagged HIGH.
// (Two mergers were consolidated into one on 2026-06-29; this rule keeps it that way.)
const CANONICAL_MERGER = 'apps/lantern-garage/lib/pr-watcher.js';
// Files allowed to mention `gh pr merge`: the canonical merger, and this linter
// itself (it names the pattern in its own rule definition + report strings).
const MERGER_EXEMPT = new Set([CANONICAL_MERGER, 'scripts/consolidation-lint.js']);
const MERGE_CALL = /gh\s+pr\s+merge\b|["']pr["']\s*,\s*["']merge["']/;
const MERGER_SCAN_EXT = new Set([...CODE_EXT, '.yml', '.yaml']); // code + CI workflows

// ── gather the file universe ────────────────────────────────────────────────
const tracked = sh('git ls-files').split('\n').filter(Boolean);
let universe, reportSet;
if (STAGED) {
  const staged = sh('git diff --cached --name-only --diff-filter=ACM')
    .split('\n').filter(Boolean);
  reportSet = new Set(staged);
  universe = Array.from(new Set([...tracked, ...staged]));
} else {
  reportSet = new Set(tracked);
  universe = tracked;
}

// ── single content pass: hash + modernize rules ─────────────────────────────
const hashMap = new Map();        // sha256 -> [paths]
const basenameMap = new Map();    // basename -> Set(dir)
const findings = [];

function add(rule, severity, file, detail) {
  findings.push({ rule, severity, file, detail });
}

for (const file of universe) {
  if (VENDOR.test(file)) continue;
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file);
  const abs = path.join(REPO, file);

  // ── path-only rules (no read) ──
  if (STRAY.some((re) => re.test(base))) {
    add('stray-file', 'HIGH', file, 'temp/backup/scratch artifact — should not be tracked');
  } else if (!file.includes('/') && !ROOT_ALLOW.has(base) &&
             /\.(txt|html|json|js|log|tmp)$/i.test(base) && !base.startsWith('.')) {
    add('loose-root-file', 'MEDIUM', file, 'scratch-looking file at repo root — move into a subdir or delete');
  }

  for (const f of FORBIDDEN_SUBSYSTEM) {
    if (f.re.test(file)) add('forbidden-subsystem', 'INFO', file, f.why);
  }

  // mono-merger: only the canonical merger may call `gh pr merge`
  if (MERGER_SCAN_EXT.has(ext) && !MERGER_EXEMPT.has(file) &&
      !TEST_FILE.test(file) && !VENDOR.test(file)) {
    let src = '';
    try { src = fs.readFileSync(abs, 'utf8'); } catch { src = ''; }
    if (MERGE_CALL.test(src)) {
      add('duplicate-merger', 'HIGH', file,
          `auto-merges PRs via 'gh pr merge' — only ${CANONICAL_MERGER} may; consolidate (anti-sprawl)`);
    }
  }

  // basename map for code consolidation candidates
  if (CODE_EXT.has(ext) && !UBIQUITOUS.has(base) && !DATA_DIR.test(file)) {
    if (!basenameMap.has(base)) basenameMap.set(base, new Set());
    basenameMap.get(base).add(path.dirname(file));
  }

  // ── content rules ──
  if (!TEXT_EXT.has(ext)) continue;
  if (DATA_DIR.test(file) && ext === '.json') continue; // datasets, not code
  let stat;
  try { stat = fs.statSync(abs); } catch { continue; }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_HASH_BYTES) continue;

  let content;
  try { content = fs.readFileSync(abs); } catch { continue; }

  // exact-duplicate (skip ubiquitous + data/model dirs)
  if (!UBIQUITOUS.has(base) && !DATA_DIR.test(file)) {
    const h = crypto.createHash('sha256').update(content).digest('hex');
    if (!hashMap.has(h)) hashMap.set(h, []);
    hashMap.get(h).push(file);
  }

  // modernize (JS family, non-test)
  if (JS_EXT.has(ext) && !TEST_FILE.test(file)) {
    const text = content.toString('utf8');
    const lines = text.split('\n');
    let varCount = 0;
    lines.forEach((line, i) => {
      if (/^\s*var\s+[A-Za-z_$]/.test(line)) varCount++;
      // exec/spawn fed an interpolated or concatenated argument
      if (/\b(execSync|exec|spawnSync|spawn)\s*\(\s*[`'"][^)]*\$\{/.test(line) ||
          /\b(execSync|spawnSync)\s*\([^)]*['"`]\s*\+/.test(line)) {
        add('unsafe-exec', 'HIGH', `${file}:${i + 1}`,
            'shell call on interpolated input — route through lib/safe-exec.js');
      }
    });
    if (varCount > 0) add('legacy-var', 'LOW', file, `${varCount} \`var\` declaration(s) — use const/let`);
  }
}

// ── dedup grouping ──────────────────────────────────────────────────────────
for (const [, paths] of hashMap) {
  if (paths.length < 2) continue;
  if (STAGED && !paths.some((p) => reportSet.has(p))) continue;
  add('exact-duplicate', 'HIGH', paths[0], `identical to: ${paths.slice(1).join(', ')}`);
}
for (const [base, dirs] of basenameMap) {
  if (dirs.size < 2) continue;
  const sample = Array.from(dirs).slice(0, 4).map((d) => `${d}/${base}`);
  const rep = sample[0];
  if (STAGED && !reportSet.has(rep)) continue;
  add('duplicate-basename', 'MEDIUM', base,
      `${dirs.size} copies: ${sample.join(', ')}${dirs.size > 4 ? ', …' : ''}`);
}

// In staged mode, only surface findings about staged files (dup groups already
// gated above; primary-file findings filtered here).
const shown = STAGED
  ? findings.filter((f) => {
      const p = f.file.split(':')[0];
      return reportSet.has(p) || f.rule === 'exact-duplicate' || f.rule === 'duplicate-basename';
    })
  : findings;

// ── --fix: untrack stray/junk only (safe, reversible) ───────────────────────
if (FIX) {
  const strays = [...new Set(shown.filter((f) => f.rule === 'stray-file').map((f) => f.file))];
  for (const f of strays) {
    // shell-free (the rule this tool enforces): pass the path as an argv element,
    // never interpolated into a shell string.
    try { execFileSync('git', ['rm', '--cached', '--quiet', f], { cwd: REPO }); console.log(`untracked: ${f}`); }
    catch (e) { console.error(`could not untrack ${f}: ${e.message}`); }
  }
  if (!strays.length) console.log('--fix: no stray files to untrack.');
}

// ── report ──────────────────────────────────────────────────────────────────
const counts = { HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
shown.forEach((f) => { counts[f.severity]++; });

if (JSON_OUT) {
  console.log(JSON.stringify({ mode: STAGED ? 'staged' : 'full', scanned: universe.length, counts, findings: shown }, null, 2));
} else {
  printReport(shown, counts, universe.length);
}

const exitBad = STRICT && counts.HIGH > 0;
process.exit(exitBad ? 1 : 0);

// ── helpers ─────────────────────────────────────────────────────────────────
function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function printReport(items, counts, scanned) {
  const G = {
    DEDUPLICATE: ['exact-duplicate', 'duplicate-basename'],
    SQUEEZE: ['stray-file', 'loose-root-file'],
    MODERNIZE: ['unsafe-exec', 'legacy-var'],
    CONSOLIDATE: ['duplicate-merger', 'forbidden-subsystem'],
  };
  const mark = { HIGH: '✖', MEDIUM: '⚠', LOW: '·', INFO: 'ℹ' };
  console.log(`\n🔍 Consolidation Lint — squeeze & consolidate  (mode: ${STAGED ? 'staged' : 'full'})`);
  console.log(`   scanned ${scanned} files\n`);
  if (!items.length) { console.log('   ✓ clean — nothing to squeeze.\n'); return; }

  for (const [group, rules] of Object.entries(G)) {
    const inGroup = items.filter((f) => rules.includes(f.rule));
    if (!inGroup.length) continue;
    console.log(`${group}`);
    for (const rule of rules) {
      const rf = inGroup.filter((f) => f.rule === rule);
      if (!rf.length) continue;
      const sev = rf[0].severity;
      console.log(`  ${mark[sev]} ${rule} (${sev}) — ${rf.length}`);
      for (const f of rf.slice(0, 12)) {
        console.log(`       ${f.file}${f.detail ? '  —  ' + f.detail : ''}`);
      }
      if (rf.length > 12) console.log(`       … and ${rf.length - 12} more`);
    }
    console.log('');
  }
  console.log(`Summary: ${counts.HIGH} HIGH · ${counts.MEDIUM} MEDIUM · ${counts.LOW} LOW · ${counts.INFO} INFO`);
  if (STRICT && counts.HIGH > 0) {
    console.log(`\n✖ ${counts.HIGH} HIGH finding(s) under --strict. Fix, or bypass with SKIP_MONOWORKSTREAM=1.\n`);
  } else if (!STAGED) {
    console.log('\nRun `node scripts/consolidation-lint.js --fix` to untrack stray files.\n');
  }
}

function printHelp() {
  console.log(`consolidation-lint — top-down squeeze & consolidate

Usage: node scripts/consolidation-lint.js [options]

  (default)   scan the whole tracked tree, report, exit 0
  --staged    scan only staged files (for the pre-commit hook; implies --strict)
  --strict    exit 1 if any HIGH finding is present
  --no-strict in --staged mode, report without blocking
  --json      machine-readable output
  --fix       untrack stray/junk files (git rm --cached; keeps them on disk)
  -h, --help  this message

Rules: exact-duplicate, duplicate-basename (DEDUPLICATE) · stray-file,
loose-root-file (SQUEEZE) · unsafe-exec, legacy-var (MODERNIZE) ·
duplicate-merger, forbidden-subsystem (CONSOLIDATE).`);
}
