'use strict';

/**
 * journal-layout.js — how each user arranged their journal (#3543).
 *
 * The journal is a grid of cards, and which cards show, in what order, at what width is
 * the reader's business, not ours. One small JSON file per user, same convention as the
 * other per-user stores (broker-preference.js); nothing secret lives here.
 *
 * The browser keeps its own copy so the page paints the right arrangement before any
 * request finishes — the file is what makes it follow the reader to another device.
 * A guest has no file: their arrangement lives in their browser and nowhere else.
 *
 * Shape (validated on the way in AND on the way out, because a file on disk is input):
 *   { v: 1, order: ['kpis', ...], hidden: ['placements'], width: { balance: 2 } }
 * Width is 1 (half) or 2 (full). Ids the page doesn't know are dropped when it renders,
 * and cards the layout never heard of are appended — so adding a card doesn't strand
 * anyone on a layout that hides it by omission.
 */

const fs = require('fs');
const path = require('path');

// Resolved against THIS module, not the cwd: servers started from different directories
// must read the same store (same rationale as ibkr-credentials.js). Tests point the env
// var at a temp dir.
const DIR = process.env.JOURNAL_LAYOUT_DIR
  ? path.resolve(process.env.JOURNAL_LAYOUT_DIR)
  : path.join(__dirname, '..', 'data', 'journal-layout');

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_CARDS = 40;

function _file(userId) { return path.join(DIR, encodeURIComponent(String(userId)) + '.json'); }

/**
 * A layout we are willing to store and serve, or null. Unknown keys are dropped rather
 * than trusted: this parses a file that a previous version — or a hand edit — wrote.
 */
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const order = [];
  const seen = new Set();
  for (const id of Array.isArray(raw.order) ? raw.order : []) {
    if (typeof id !== 'string' || !ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  if (!order.length || order.length > MAX_CARDS) return null;
  const hidden = [];
  for (const id of Array.isArray(raw.hidden) ? raw.hidden : []) {
    if (typeof id === 'string' && seen.has(id) && !hidden.includes(id)) hidden.push(id);
  }
  const width = {};
  for (const [id, w] of Object.entries(raw.width && typeof raw.width === 'object' ? raw.width : {})) {
    if (seen.has(id) && (w === 1 || w === 2)) width[id] = w;
  }
  return { v: 1, order, hidden, width };
}

/** The user's stored arrangement, or null when there is none (or none we trust). */
function get(userId) {
  if (userId == null) return null;
  try { return normalize(JSON.parse(fs.readFileSync(_file(userId), 'utf8'))); } catch (_e) { return null; }
}

/** Store an arrangement. Returns the stored (normalized) layout, or null if it was
 *  unusable or there is no identity to store it under — the caller answers accordingly. */
function set(userId, layout) {
  const clean = normalize(layout);
  if (userId == null || !clean) return null;
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(_file(userId), JSON.stringify(clean, null, 2));
  return clean;
}

/** Forget it — the page's Reset. Returns true when a file was actually removed. */
function clear(userId) {
  if (userId == null) return false;
  try { fs.unlinkSync(_file(userId)); return true; } catch (_e) { return false; }
}

module.exports = { DIR, MAX_CARDS, normalize, get, set, clear };
