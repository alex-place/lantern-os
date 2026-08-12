'use strict';

/**
 * alert-store.js — per-user alert rules + fired-alert feed (#3248).
 *
 * Storage (per-user directory, mirroring the conversation-store convention of
 * per-user files under data/):
 *   data/lantern-garage/trading/alerts/users/<uid>/rules.json   — CRUD doc
 *   data/lantern-garage/trading/alerts/users/<uid>/feed.jsonl   — append-only fires
 *
 * Rules are a small CRUD document (read-modify-write with a cap), the feed is
 * append-only JSONL — same split the trader uses everywhere else (state file vs
 * ledger). ALERTS_DIR overrides the root so tests exercise the real code paths
 * without touching operator data (the TRADER_TRADES_LOG pattern).
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.env.ALERTS_DIR
  ? path.resolve(process.env.ALERTS_DIR)
  : path.join(__dirname, '..', '..', '..', 'data', 'lantern-garage', 'trading', 'alerts', 'users');

const MAX_RULES_PER_USER = 20;   // bounds per-scan evaluation cost
const MAX_FEED_READ = 200;

const RULE_TYPES = new Set(['signal', 'zone', 'washout']);

/** Filesystem-safe user id — reject anything that could escape the directory. */
function safeUid(userId) {
  const uid = String(userId || '').trim();
  if (!uid || uid.length > 128 || !/^[A-Za-z0-9@._-]+$/.test(uid)) return null;
  return uid;
}

function userDir(uid) { return path.join(ROOT, uid); }
function rulesPath(uid) { return path.join(userDir(uid), 'rules.json'); }
function feedPath(uid) { return path.join(userDir(uid), 'feed.jsonl'); }

function listRules(userId) {
  const uid = safeUid(userId);
  if (!uid) return [];
  try {
    const doc = JSON.parse(fs.readFileSync(rulesPath(uid), 'utf8'));
    return Array.isArray(doc.rules) ? doc.rules : [];
  } catch (_e) { return []; }
}

function _writeRules(uid, rules) {
  fs.mkdirSync(userDir(uid), { recursive: true });
  fs.writeFileSync(rulesPath(uid), JSON.stringify({ rules, updatedAt: new Date().toISOString() }, null, 2));
}

/**
 * Validate + normalize a rule. Returns { ok, rule } or { ok:false, error }.
 * Strict allowlist validation (SECURITY.md): nothing user-supplied passes
 * through unchecked.
 */
function normalizeRule(input) {
  const r = input || {};
  const symbol = String(r.symbol || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,7}$/.test(symbol)) return { ok: false, error: 'invalid_symbol' };
  const type = String(r.type || '').trim();
  if (!RULE_TYPES.has(type)) return { ok: false, error: 'invalid_type', supported: [...RULE_TYPES] };
  const out = {
    id: /^[a-z0-9]{6,24}$/.test(String(r.id || '')) ? String(r.id) : ('al' + Math.random().toString(36).slice(2, 10)),
    symbol, type,
    enabled: r.enabled !== false,
    cooldownMin: Math.min(1440, Math.max(5, Number(r.cooldownMin) || 60)),
    createdAt: r.createdAt || new Date().toISOString(),
    lastFiredAt: r.lastFiredAt || null,
  };
  if (type === 'signal') {
    const dir = String(r.direction || 'any').toUpperCase();
    if (!['BULLISH', 'BEARISH', 'ANY'].includes(dir)) return { ok: false, error: 'invalid_direction' };
    out.direction = dir;
  }
  if (type === 'zone') {
    const side = String(r.zone || 'support').toLowerCase();
    if (!['support', 'resistance'].includes(side)) return { ok: false, error: 'invalid_zone' };
    out.zone = side;
    const p = Number(r.proximityPct);
    out.proximityPct = Number.isFinite(p) ? Math.min(5, Math.max(0.1, p)) : 0.5;
  }
  return { ok: true, rule: out };
}

/** Create or update (by id). Returns { ok, rule } or { ok:false, error }. */
function saveRule(userId, input) {
  const uid = safeUid(userId);
  if (!uid) return { ok: false, error: 'invalid_user' };
  const norm = normalizeRule(input);
  if (!norm.ok) return norm;
  const rules = listRules(uid);
  const i = rules.findIndex((x) => x.id === norm.rule.id);
  if (i >= 0) {
    norm.rule.createdAt = rules[i].createdAt;
    norm.rule.lastFiredAt = rules[i].lastFiredAt || null;   // server-owned; a client edit can't reset the cooldown
    rules[i] = norm.rule;
  } else {
    if (rules.length >= MAX_RULES_PER_USER) return { ok: false, error: 'rule_cap', cap: MAX_RULES_PER_USER };
    rules.push(norm.rule);
  }
  _writeRules(uid, rules);
  return { ok: true, rule: norm.rule };
}

function deleteRule(userId, ruleId) {
  const uid = safeUid(userId);
  if (!uid) return false;
  const rules = listRules(uid);
  const next = rules.filter((x) => x.id !== String(ruleId));
  if (next.length === rules.length) return false;
  _writeRules(uid, next);
  return true;
}

/** Persist a fire: stamp the rule's lastFiredAt AND append to the feed. */
function recordFire(userId, ruleId, feedRow) {
  const uid = safeUid(userId);
  if (!uid) return;
  const rules = listRules(uid);
  const r = rules.find((x) => x.id === ruleId);
  if (r) { r.lastFiredAt = feedRow.ts; _writeRules(uid, rules); }
  fs.mkdirSync(userDir(uid), { recursive: true });
  fs.appendFileSync(feedPath(uid), JSON.stringify(feedRow) + '\n');
}

function readFeed(userId, limit = 50) {
  const uid = safeUid(userId);
  if (!uid) return [];
  let text = '';
  try { text = fs.readFileSync(feedPath(uid), 'utf8'); } catch (_e) { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch (_e) { /* skip torn line */ }
  }
  return rows.slice(-Math.min(Number(limit) || 50, MAX_FEED_READ)).reverse();
}

/** Every user who has at least one rule on disk (drives per-scan evaluation). */
function listUsersWithRules() {
  try {
    return fs.readdirSync(ROOT).filter((d) => {
      try { return fs.existsSync(path.join(ROOT, d, 'rules.json')); } catch (_e) { return false; }
    });
  } catch (_e) { return []; }
}

module.exports = {
  listRules, saveRule, deleteRule, recordFire, readFeed, listUsersWithRules,
  normalizeRule, safeUid, MAX_RULES_PER_USER, RULE_TYPES,
};
