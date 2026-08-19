'use strict';

/**
 * legacy-data-migrate.js — one-time merge of the pre-#3136 cwd-relative auth
 * stores into the canonical data root.
 *
 * #3136 collapsed the two data roots (process.cwd()/data vs <repoRoot>/data) so
 * every module resolves ONE store via app-paths. Correct going forward — but on
 * any deployment whose service cwd was the app dir (the GCE box: systemd cwd
 * /opt/lantern-os/apps/lantern-garage), the upgrade ORPHANED every existing
 * account: the store the server now reads (<repoRoot>/data/profiles) was empty
 * while the real accounts sat in the legacy tree. Email+password logins 401'd
 * ("Email or password is incorrect" — the credential lives in the profile
 * record) and Google sign-ins silently minted fresh guest profiles. #3136
 * shipped only a startup WARNING for this; this module does the actual merge.
 *
 * Semantics (auth-critical stores only — sessions are deliberately excluded,
 * re-login is cheap and the store was never split):
 *   • JSONL files: merged = legacy lines + canonical lines. Every store here is
 *     append-only latest-record-wins, so putting the OLDER (legacy) lines first
 *     preserves that: any account touched after the move keeps its newer
 *     canonical record; consumed-token / processed-event ledgers become the
 *     UNION, which is the safe direction for replay protection. The canonical
 *     file is backed up beside itself as *.pre-merge.bak first.
 *   • Non-JSONL files (profiles.csf): copied only when the canonical file is
 *     missing; when both exist the canonical one is kept and the skip is logged
 *     (the JSONL index is the source of truth — never guess with a binary blob).
 *   • Each migrated legacy file is renamed <name>.migrated afterwards, so the
 *     merge is idempotent, re-runs are no-ops, and the #3088 orphan warning
 *     stops firing once the data is safe.
 *
 * Every step is fail-soft and per-file: a single unreadable file logs and moves
 * on — boot must never be broken by a migration aid.
 */

const fs = require('fs');
const path = require('path');
const { dataRoot } = require('./app-paths');

// Auth-critical stores, relative to each data root. Directories mean "every
// file directly inside" (profiles/ holds per-user subdirs too — those are
// moved wholesale when absent canonically).
const STORES = [
  'profiles',
  'auth',
  'billing',
];

function _isJsonl(f) { return /\.jsonl$/i.test(f); }

function _mergeJsonl(legacyFile, canonFile, log) {
  const legacy = fs.readFileSync(legacyFile, 'utf8');
  if (!legacy.trim()) return 'empty';
  if (!fs.existsSync(canonFile)) {
    fs.mkdirSync(path.dirname(canonFile), { recursive: true });
    fs.copyFileSync(legacyFile, canonFile);
    return 'copied';
  }
  const canon = fs.readFileSync(canonFile, 'utf8');
  if (canon.includes(legacy.trim())) return 'already-contained';
  fs.copyFileSync(canonFile, canonFile + '.pre-merge.bak');
  const merged = legacy.replace(/\n?$/, '\n') + canon;
  fs.writeFileSync(canonFile, merged);
  log(`merged ${legacyFile} into ${canonFile} (legacy-first, ${legacy.split('\n').filter(Boolean).length} legacy lines; backup ${path.basename(canonFile)}.pre-merge.bak)`);
  return 'merged';
}

function _migrateEntry(legacyPath, canonPath, log) {
  const st = fs.statSync(legacyPath);
  if (st.isDirectory()) {
    if (!fs.existsSync(canonPath)) {
      fs.mkdirSync(path.dirname(canonPath), { recursive: true });
      fs.renameSync(legacyPath, canonPath);
      log(`moved directory ${legacyPath} -> ${canonPath}`);
      return true; // whole dir moved — nothing left to rename
    }
    let any = false;
    for (const f of fs.readdirSync(legacyPath)) {
      if (/\.migrated$/.test(f)) continue;
      try { if (_migrateEntry(path.join(legacyPath, f), path.join(canonPath, f), log)) any = true; } catch (e) { log(`SKIP ${f}: ${e.message}`); }
    }
    return any;
  }
  if (_isJsonl(legacyPath)) {
    const r = _mergeJsonl(legacyPath, canonPath, log);
    if (r === 'merged' || r === 'copied' || r === 'already-contained' || r === 'empty') {
      fs.renameSync(legacyPath, legacyPath + '.migrated');
      if (r === 'copied') log(`copied ${legacyPath} -> ${canonPath}`);
      return true;
    }
    return false;
  }
  // Binary / unknown format: only fill a hole, never overwrite.
  if (!fs.existsSync(canonPath)) {
    fs.mkdirSync(path.dirname(canonPath), { recursive: true });
    fs.copyFileSync(legacyPath, canonPath);
    fs.renameSync(legacyPath, legacyPath + '.migrated');
    log(`copied ${legacyPath} -> ${canonPath}`);
    return true;
  }
  log(`kept canonical ${canonPath}; legacy ${legacyPath} left in place (both exist, non-JSONL — resolve by hand)`);
  return false;
}

/**
 * Run the one-time merge. Returns a summary {migrated:boolean, details:[]}.
 * No-op when the legacy root and the canonical root are the same path (the
 * documented repo-root launch) or when no legacy store exists.
 */
function migrateLegacyData({ cwd = process.cwd(), logger = console } = {}) {
  const details = [];
  const log = (m) => { details.push(m); try { logger.info(`[data-migrate] ${m}`); } catch { /* logging is best-effort */ } };
  try {
    const legacyRoot = path.join(cwd, 'data');
    const canonRoot = dataRoot();
    if (path.resolve(legacyRoot) === path.resolve(canonRoot)) return { migrated: false, details };
    let any = false;
    for (const store of STORES) {
      const legacyPath = path.join(legacyRoot, store);
      if (!fs.existsSync(legacyPath)) continue;
      try { if (_migrateEntry(legacyPath, path.join(canonRoot, store), log)) any = true; } catch (e) { log(`SKIP ${store}: ${e.message}`); }
    }
    if (any) log(`legacy auth stores merged from ${legacyRoot} into ${canonRoot} — pre-#3136 accounts are visible again`);
    return { migrated: any, details };
  } catch (e) {
    try { logger.warn(`[data-migrate] failed (non-fatal): ${e.message}`); } catch { /* ignore */ }
    return { migrated: false, details };
  }
}

module.exports = { migrateLegacyData };
