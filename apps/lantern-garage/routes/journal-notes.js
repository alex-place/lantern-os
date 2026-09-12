'use strict';
/**
 * routes/journal-notes.js — the reader's own notes on their own trades (#3559).
 *
 * Loop stage: Remember. A statistic says what happened; this is the only part of the
 * record that can say why, and the only part the machine cannot write for them.
 *
 *   GET    /api/journal/notes              → { notes, tags }        everything they wrote
 *   GET    /api/journal/notes?stats=1      → { trades, annotated, tags[], feelings[] }
 *   GET    /api/journal/notes?export=1     → the file, as a download
 *   POST   /api/journal/notes  { id, note, tags, feel } → { ok, saved }
 *   DELETE /api/journal/notes?id=…         → { ok, removed }
 *
 * UNDER /api/journal, NOT /api/trading, and deliberately. This is journal
 * personalisation — the same kind of thing as the card arrangement next door in
 * journal-layout.js — while the trading gate requires the `trade` entitlement. A
 * reader's own writing about their own record should not inherit a gate meant for
 * placing orders, and nothing here returns anything but their own.
 *
 * SIGNED-IN ONLY, AND ONLY EVER THEIR OWN. The user id comes from the session and never
 * from the request, so there is no shape of this call that reads or writes somebody
 * else's notes. There is deliberately no route that returns more than one reader's.
 */

const notesStore = require('../lib/trade-notes');
const { taggedStats } = require('../lib/trade-log');
const { readExits } = require('../lib/trader-scorecard');
const { getEffectiveUserId } = require('../lib/session-identity');
const { internalUserId } = require('../lib/request-auth');

const PATH = '/api/journal/notes';

// Same scoping rule as the trade log, so a note lands on the trade the reader is looking at.
function readerId(req) {
  const id = getEffectiveUserId(req) || internalUserId(req);
  if (id) return id;
  try { return require('../lib/auth-middleware').loginGateEnabled() ? null : 'local-owner'; } catch (_e) { return null; }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 64 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

function _json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

module.exports = async function journalNotesRoutes(req, res, url) {
  if (url.pathname !== PATH) return false;
  const sendJson = (r, obj, code) => _json(r, code || 200, obj);
  const userId = readerId(req);

  if (req.method === 'GET') {
    // A guest writes nothing and reads nothing: an empty set, not an error, so the card
    // renders its own empty state rather than a failure.
    if (!userId) { sendJson(res, { notes: {}, tags: [], stored: false }, 200); return true; }

    if (url.searchParams.get('stats') === '1') {
      const book = notesStore.all(userId).notes;
      const rows = readExits(undefined, userId);
      sendJson(res, Object.assign({ stored: true }, taggedStats(rows, book, { view: url.searchParams.get('view') })), 200);
      return true;
    }

    if (url.searchParams.get('export') === '1') {
      // Their writing, in a form they can keep. Nothing about anyone else is in it.
      const body = JSON.stringify({ exportedAt: new Date().toISOString(), ...notesStore.all(userId) }, null, 2);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="unisona-trade-notes.json"',
      });
      res.end(body);
      return true;
    }

    sendJson(res, { ...notesStore.all(userId), tags: notesStore.tagsUsed(userId), stored: true }, 200);
    return true;
  }

  if (req.method === 'POST') {
    if (!userId) { sendJson(res, { ok: false, error: 'not_signed_in' }, 401); return true; }
    const body = await readBody(req);
    if (!body || typeof body.id !== 'string') { sendJson(res, { ok: false, error: 'bad_request' }, 400); return true; }
    const saved = notesStore.set(userId, body.id, body);
    // `saved: null` with ok:true is a cleared note -- emptying the boxes is how a reader
    // takes one back, so it is a success, not a refusal.
    sendJson(res, { ok: true, saved, tags: notesStore.tagsUsed(userId) }, 200);
    return true;
  }

  if (req.method === 'DELETE') {
    if (!userId) { sendJson(res, { ok: false, error: 'not_signed_in' }, 401); return true; }
    const id = url.searchParams.get('id');
    if (!id) { sendJson(res, { ok: false, error: 'bad_request' }, 400); return true; }
    notesStore.set(userId, id, null);
    sendJson(res, { ok: true, removed: true }, 200);
    return true;
  }

  sendJson(res, { error: 'method_not_allowed' }, 405);
  return true;
};
module.exports.readerId = readerId;
