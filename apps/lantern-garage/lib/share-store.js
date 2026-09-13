'use strict';
/**
 * share-store.js — the shares a reader has published, one file each (#3562).
 *
 * NOTHING IS PUBLIC UNTIL A READER MAKES IT SO, and a revoke is a delete. Not a flag, not
 * a tombstone with the figures still in it: the file goes, so there is nothing left to
 * serve by mistake and nothing left on disk for a later bug to leak. A revoked share and
 * a share that never existed are the same 404, which is also the right answer to anyone
 * probing for one.
 *
 * IDS ARE UNGUESSABLE AND UNORDERED. 128 bits of crypto randomness in base32 — a share
 * cannot be found by counting up from someone else's, and nothing about a reader is
 * recoverable from one. The owner is stored INSIDE the record (so a reader can list and
 * revoke their own) and never leaves this module: the public route sends `payload` only.
 *
 * A CAP PER READER, because a share is a file and an uncapped writer is a disk-filler.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.JOURNAL_SHARE_DIR
  ? path.resolve(process.env.JOURNAL_SHARE_DIR)
  : path.join(__dirname, '..', '..', '..', 'data', 'lantern-garage', 'shares');

const MAX_PER_OWNER = 25;
// Crockford-ish base32, no I/L/O/U: an id gets read aloud and typed, and a shared link
// that fails because a 1 was read as an l is a support ticket.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const ID_LEN = 26;

function newId() {
  const bytes = crypto.randomBytes(ID_LEN);
  let out = '';
  for (let i = 0; i < ID_LEN; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Only our own ids can name a file. Anything else is not a miss, it is an attempt. */
function validId(id) {
  return typeof id === 'string' && id.length === ID_LEN && /^[0-9a-hjkmnp-tv-z]+$/.test(id);
}

const fileFor = (id) => path.join(DIR, id + '.json');

function readOne(id) {
  if (!validId(id)) return null;
  try { return JSON.parse(fs.readFileSync(fileFor(id), 'utf8')); } catch (_e) { return null; }
}

/** Every share, newest first. Internal — callers get their OWN through listFor. */
function _all() {
  let names = [];
  try { names = fs.readdirSync(DIR); } catch (_e) { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const rec = readOne(n.slice(0, -5));
    if (rec && rec.id) out.push(rec);
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * Publish one card. `payload` is a share-card envelope — already allow-listed, because
 * this module stores what it is given and is not the place that decides what may leave.
 */
function create(owner, payload) {
  if (!owner) throw new Error('a share needs an owner');
  const mine = listFor(owner);
  if (mine.length >= MAX_PER_OWNER) {
    const e = new Error('share_limit');
    e.code = 'share_limit';
    e.limit = MAX_PER_OWNER;
    throw e;
  }
  fs.mkdirSync(DIR, { recursive: true });
  const rec = { v: 1, id: newId(), owner: String(owner), createdAt: new Date().toISOString(), payload };
  // wx: never overwrite. An id collision at 128 bits will not happen, and if it somehow
  // did, silently replacing somebody's share with somebody else's is not the failure to
  // choose.
  fs.writeFileSync(fileFor(rec.id), JSON.stringify(rec, null, 2), { flag: 'wx' });
  return rec;
}

/** The public read. Returns the whole record; the caller sends `payload` and nothing else. */
function get(id) { return readOne(id); }

/** One reader's own shares, without their payloads — a list, not a re-publication. */
function listFor(owner) {
  if (!owner) return [];
  const want = String(owner);
  return _all().filter((r) => r.owner === want).map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    kind: (r.payload && r.payload.kind) || null,
    label: (r.payload && r.payload.label) || null,
    dollars: !!(r.payload && r.payload.dollars),
    month: (r.payload && r.payload.card && r.payload.card.month) || null,
  }));
}

/**
 * Take one down. Only the owner can, and a share that is not theirs reports the same
 * "not found" as one that does not exist — a different answer would confirm it exists.
 */
function revoke(owner, id) {
  const rec = readOne(id);
  if (!rec || !owner || rec.owner !== String(owner)) return false;
  try { fs.unlinkSync(fileFor(id)); } catch (_e) { return false; }
  return true;
}

function _reset() { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_e) { /* gone */ } }

module.exports = { create, get, listFor, revoke, newId, validId, fileFor, DIR, MAX_PER_OWNER, ID_LEN, _reset };
