'use strict';

/**
 * journal-layout.js — the journal's arrangement, per user (#3543).
 *
 *   GET    /api/journal/layout  → { layout, stored }   layout null when there is none
 *   POST   /api/journal/layout  { layout } → { ok, layout, stored }
 *   DELETE /api/journal/layout  → { ok, stored:false } (Reset)
 *
 * A guest gets `stored:false` and a 200, never an error: their arrangement lives in their
 * browser, and the page treats the server as the copy that follows them between devices.
 * Nothing here is secret, so there is no role gate — you can only read or write your own.
 */

const store = require('../lib/journal-layout');
const { getEffectiveUserId } = require('../lib/session-identity');

function _json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function _readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 64 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

/* Owner convention, same as routes/broker-preference: on a box whose login gate is OFF
   (a local or single-user server) an id-less request IS the owner, so their arrangement
   is stored rather than stranded in one browser. Where the gate is on — the hosted app —
   an anonymous visitor stays anonymous. */
function _readerId(req) {
  const id = getEffectiveUserId(req);
  if (id != null) return id;
  try { return require('../lib/auth-middleware').loginGateEnabled() ? null : 'local-owner'; } catch (_e) { return null; }
}

module.exports = async function journalLayoutRoutes(req, res, url) {
  if (url.pathname !== '/api/journal/layout') return false;
  const userId = _readerId(req);

  if (req.method === 'GET') {
    return _json(res, 200, { layout: store.get(userId), stored: userId != null }), true;
  }

  if (req.method === 'POST') {
    const body = await _readBody(req);
    if (!body) return _json(res, 400, { error: 'bad_json' }), true;
    const layout = body.layout || body;
    if (!store.normalize(layout)) {
      return _json(res, 400, { error: 'bad_layout', message: 'A layout needs an order of known card ids; widths are 1 or 2.' }), true;
    }
    const saved = store.set(userId, layout);
    // A guest is not an error: the browser keeps it, and says so.
    return _json(res, 200, { ok: true, stored: !!saved, layout: saved || store.normalize(layout) }), true;
  }

  if (req.method === 'DELETE') {
    const removed = store.clear(userId);
    return _json(res, 200, { ok: true, stored: false, removed }), true;
  }

  return _json(res, 405, { error: 'method_not_allowed' }), true;
};
