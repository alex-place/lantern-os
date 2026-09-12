'use strict';

/**
 * trade-notes.js — what the reader has to say about their own trades (#3559).
 *
 * This was scoped out of the journal once, on the reasoning that competitors need notes
 * because their users type in their own trades while ours do not. That was wrong: the
 * autonomous trader is `minPlan:"pilot"`, so everyone below $200/mo trades by hand, and
 * for them this is not a competitor's crutch — it is the point of keeping a journal.
 *
 * A statistic tells a trader WHAT happened. This is the only part of the record that can
 * say why, and the only part the machine cannot produce for them.
 *
 *   { v: 1, notes: { "<tradeId>": { note, tags: [], feel, at } } }
 *
 * TAGS ARE THE READER'S OWN WORDS. No fixed vocabulary of setups or mistakes: the useful
 * tag is the one they already use for the thing they keep doing. They are normalised to
 * lower case so "Chased" and "chased" aggregate together, because the aggregate is the
 * whole payoff — "every trade I tagged chased is a loss" is a fact worth having.
 *
 * FEELINGS ARE A FIXED, SHORT LIST, for the opposite reason: free text cannot be
 * aggregated, and one trade's mood is worth nothing while forty are worth something.
 *
 * PRIVACY. These are the reader's private writing about their own money. One file per
 * user, never merged into anyone else's view, never shared by any route here, and
 * exportable so they can leave with them.
 */

const fs = require('fs');
const path = require('path');

// Resolved against THIS module, not the cwd — same rationale as journal-layout.js.
const DIR = process.env.TRADE_NOTES_DIR
  ? path.resolve(process.env.TRADE_NOTES_DIR)
  : path.join(__dirname, '..', 'data', 'trade-notes');

/* A trade id is either the broker's order id or the trade log's fallback key
   (ts|symbol|qty), so the shape is broad but bounded. */
const ID = /^[A-Za-z0-9._:|-]{1,80}$/;
const TAG = /^[a-z0-9][a-z0-9 _-]{0,23}$/;
const FEELINGS = ['calm', 'confident', 'unsure', 'anxious', 'frustrated'];
const MAX_NOTE = 2000;
const MAX_TAGS = 8;
const MAX_TRADES = 5000;

function _file(userId) { return path.join(DIR, encodeURIComponent(String(userId)) + '.json'); }

/** One trade's annotation, or null when there is nothing worth storing. */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, MAX_NOTE) : '';
  const tags = [];
  for (const t of Array.isArray(raw.tags) ? raw.tags : []) {
    if (typeof t !== 'string') continue;
    // Collapse the ways people type the same tag, so they aggregate as one.
    const tag = t.trim().toLowerCase().replace(/\s+/g, ' ');
    if (TAG.test(tag) && !tags.includes(tag) && tags.length < MAX_TAGS) tags.push(tag);
  }
  const feel = FEELINGS.includes(raw.feel) ? raw.feel : null;
  // An entry with nothing in it is a deletion, not an empty record to keep forever.
  if (!note && !tags.length && !feel) return null;
  const at = typeof raw.at === 'string' && raw.at ? raw.at : new Date().toISOString();
  return { note, tags, feel, at };
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { v: 1, notes: {} };
  const src = (raw.notes && typeof raw.notes === 'object' && !Array.isArray(raw.notes)) ? raw.notes : {};
  const notes = {};
  let n = 0;
  for (const [id, entry] of Object.entries(src)) {
    if (!ID.test(id) || n >= MAX_TRADES) continue;
    const clean = normalizeEntry(entry);
    if (!clean) continue;
    notes[id] = clean;
    n += 1;
  }
  return { v: 1, notes };
}

/** Everything this reader has written, or an empty set. */
function all(userId) {
  if (userId == null) return { v: 1, notes: {} };
  try { return normalize(JSON.parse(fs.readFileSync(_file(userId), 'utf8'))); } catch (_e) { return { v: 1, notes: {} }; }
}

/** One trade's annotation, or null. */
function get(userId, tradeId) {
  if (userId == null || !ID.test(String(tradeId || ''))) return null;
  return all(userId).notes[tradeId] || null;
}

/**
 * Write one trade's annotation. An entry that normalizes to nothing REMOVES it, so
 * clearing the boxes is how a reader takes a note back — there is no separate gesture
 * to learn, and no empty record left behind.
 * Returns the stored entry, or null when it was removed or could not be stored.
 */
function set(userId, tradeId, entry) {
  if (userId == null || !ID.test(String(tradeId || ''))) return null;
  const book = all(userId);
  const clean = normalizeEntry(entry);
  if (clean) {
    if (!book.notes[tradeId] && Object.keys(book.notes).length >= MAX_TRADES) return null;
    book.notes[tradeId] = clean;
  } else {
    delete book.notes[tradeId];
  }
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(_file(userId), JSON.stringify(book, null, 2));
  return clean;
}

/** Every tag this reader has used, most-used first — so the next one is a pick, not a typo. */
function tagsUsed(userId) {
  const counts = new Map();
  for (const entry of Object.values(all(userId).notes)) {
    for (const tag of entry.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, n]) => ({ tag, n }));
}

/** Forget everything this reader wrote. */
function clear(userId) {
  if (userId == null) return false;
  try { fs.unlinkSync(_file(userId)); return true; } catch (_e) { return false; }
}

module.exports = { DIR, FEELINGS, MAX_NOTE, MAX_TAGS, MAX_TRADES, normalize, normalizeEntry, all, get, set, tagsUsed, clear };
