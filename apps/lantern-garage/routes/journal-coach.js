'use strict';
/**
 * routes/journal-coach.js — the journal, read back to the reader (#3560).
 *
 * Loop stage: Verify. Everything the page already computes, turned into the handful of
 * claims the record actually supports — each carrying the figures it came from.
 *
 *   GET /api/journal/coach          → { findings, text, source, model }
 *   GET /api/journal/coach?plain=1  → the computed wording, no model call
 *
 * PRO ($20). `journal_coach` in lib/plan-matrix.js — the journal itself is for everyone,
 * the coach is the paid part, and the autonomous trader stays Pilot. Founder decision,
 * recorded in the matrix rather than in a condition here so the pricing page and
 * planReport() cannot drift from what the route enforces.
 *
 * THE MODEL DOES NOT GET TO MAKE CLAIMS. The findings are computed first; the model is
 * asked only to reword them, and `verifyText` throws the wording away if it contains a
 * figure the findings do not vouch for. With no provider configured, or a provider that
 * is down, the computed wording is what ships — the feature degrades in wording, never
 * in truthfulness.
 */

const coach = require('../lib/journal-coach');
const { scorecard, breakdown, readExits } = require('../lib/trader-scorecard');
const { taggedStats } = require('../lib/trade-log');
const notesStore = require('../lib/trade-notes');
const { buildTrackRecord } = require('../lib/track-record');
const { getEffectiveUserId } = require('../lib/session-identity');
const { internalUserId } = require('../lib/request-auth');
const { requireEntitlement } = require('../lib/auth-middleware');

const PATH = '/api/journal/coach';

function _json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readerId(req) {
  const id = getEffectiveUserId(req) || internalUserId(req);
  if (id) return id;
  try { return require('../lib/auth-middleware').loginGateEnabled() ? null : 'local-owner'; } catch (_e) { return null; }
}

/** Everything the coach reads, gathered here rather than trusted from the page. */
function gather(userId) {
  const rows = readExits(undefined, userId);
  let maxDrawdown = { amount: 0 };
  try {
    const rec = buildTrackRecord(undefined, userId);
    const book = Object.values((rec && rec.books) || {})[0];
    if (book && book.maxDrawdown) maxDrawdown = book.maxDrawdown;
  } catch (_e) { /* no record yet: the drawdown finding simply cannot fire */ }
  return {
    scorecard: scorecard(undefined, userId),
    bySymbol: breakdown('symbol', undefined, userId),
    byWeekdayHour: breakdown('weekday-hour', undefined, userId),
    rdist: breakdown('r', undefined, userId),
    tags: taggedStats(rows, notesStore.all(userId).notes),
    maxDrawdown,
  };
}

module.exports = async function journalCoachRoutes(req, res, url) {
  if (url.pathname !== PATH) return false;
  if (req.method !== 'GET') { _json(res, 405, { error: 'method_not_allowed' }); return true; }

  // Denies and explains in one place; a Free reader gets the upgrade, not a broken card.
  if (!requireEntitlement(req, res, 'journal_coach')) return true;

  const userId = readerId(req);
  if (!userId) { _json(res, 401, { error: 'not_signed_in' }); return true; }

  try {
    const list = coach.findings(gather(userId));
    const plain = coach.plainText(list);
    const refusing = list.length === 1 && list[0].kind === 'refusal';

    // Nothing to reword when there is nothing to say, or when asked for the plain read.
    if (refusing || !list.length || url.searchParams.get('plain') === '1') {
      _json(res, 200, { findings: list, text: plain, source: 'computed', model: null });
      return true;
    }

    let text = plain;
    let source = 'computed';
    let model = null;
    let rejected = null;
    try {
      const { callVerifyModel } = require('../lib/verify-llm');
      const out = await callVerifyModel(coach.buildPrompt(list), { maxTokens: 400 });
      if (out && out.text) {
        const check = coach.verifyText(out.text, list);
        if (check.ok) { text = out.text; source = 'model'; model = out.provider; }
        // A model that invented a figure does not get to speak. The computed wording
        // stands, and the rejection is reported rather than hidden — a coach that
        // silently fell back would look identical to one that was never checked.
        else { rejected = check.unvouched; }
      }
    } catch (_e) { /* no provider, or it is down: the computed wording is the answer */ }

    _json(res, 200, { findings: list, text, source, model, rejected });
  } catch (e) {
    _json(res, 500, { error: 'coach_failed', message: e.message });
  }
  return true;
};
module.exports.gather = gather;
