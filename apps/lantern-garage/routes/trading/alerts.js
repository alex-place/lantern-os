'use strict';

/**
 * routes/trading/alerts.js — per-user alert rules + fired-alert feed (#3248/#3250).
 *
 * Loop stage: Observe (the scan finally reaches the user when they're not
 * looking at the page). Sits behind the standard trading gate in server.js
 * (requireEntitlement('trade') — Pro+ by plan matrix, or a connected own
 * broker), so there is NO public/demo variant of these endpoints: rules and
 * fires are personal data.
 *
 *   GET    /api/trading/alerts/rules          → { rules, cap }
 *   POST   /api/trading/alerts/rules          → create/update  { rule } | { error }
 *   DELETE /api/trading/alerts/rules/<id>     → { ok }
 *   GET    /api/trading/alerts/feed?limit=50  → { alerts }
 */

const store = require('../../lib/alert-store');
const { getEffectiveUserId } = require('../../lib/session-identity');
const { internalUserId } = require('../../lib/request-auth');

const userOf = (req) => getEffectiveUserId(req) || internalUserId(req) || null;

module.exports = async function alertsRoutes(req, res, url, ctx) {
  if (!url.pathname.startsWith('/api/trading/alerts/')) return false;
  const { sendJson, collectRequestBody } = ctx;
  const userId = userOf(req);
  if (!store.safeUid(userId)) { sendJson(res, { error: 'sign_in_required' }, 401); return true; }

  try {
    if (url.pathname === '/api/trading/alerts/rules' && req.method === 'GET') {
      sendJson(res, { rules: store.listRules(userId), cap: store.MAX_RULES_PER_USER }, 200);
      return true;
    }
    if (url.pathname === '/api/trading/alerts/rules' && req.method === 'POST') {
      const body = await collectRequestBody(req, 8 * 1024);
      let input;
      try { input = JSON.parse(body || '{}'); } catch (_e) { sendJson(res, { error: 'invalid_json' }, 400); return true; }
      const r = store.saveRule(userId, input);
      sendJson(res, r, r.ok ? 200 : 400);
      return true;
    }
    const del = url.pathname.match(/^\/api\/trading\/alerts\/rules\/([a-z0-9]{6,24})$/);
    if (del && req.method === 'DELETE') {
      sendJson(res, { ok: store.deleteRule(userId, del[1]) }, 200);
      return true;
    }
    if (url.pathname === '/api/trading/alerts/feed' && req.method === 'GET') {
      sendJson(res, { alerts: store.readFeed(userId, url.searchParams.get('limit')) }, 200);
      return true;
    }
  } catch (e) {
    sendJson(res, { error: 'alerts_failed', message: e.message }, 500);
    return true;
  }
  return false;
};
