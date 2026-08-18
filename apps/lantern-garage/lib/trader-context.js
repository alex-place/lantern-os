'use strict';

/**
 * trader-context.js — the user's live watchlist, folded into the chat system prompt (#3331).
 *
 * The trader_watchlist TOOL answers "what am I watching" when the assistant thinks to
 * ask. That is not enough for advice: a user who says "should I trim anything?" or "how
 * does today look?" expects the assistant to already know which symbols are theirs, the
 * way a desk colleague would. So a compact snapshot rides along with every real chat
 * turn and the tools stay for depth (trader_signal for one symbol's full reasoning,
 * trader_alerts for rules, portfolio_analysis for the book).
 *
 * Constraints this is built around:
 *   - it runs on EVERY turn, including "write me a poem", so it must be cheap and
 *     must never be the reason a chat is slow: 30s cache, 2s timeout, and any failure
 *     returns "" so the turn proceeds with no trader context at all rather than erroring.
 *   - it is per user. The loopback hop carries no cookie, so the caller's id is
 *     forwarded as x-keystone-user exactly the way the trading tools do it.
 *   - it is a SNAPSHOT, not a claim. The text says when it was taken, because a price
 *     from 25 seconds ago presented as "now" is the kind of small lie that makes the
 *     rest of an answer untrustworthy.
 */

const http = require('http');

const CACHE_MS = 30000;
const TIMEOUT_MS = 2000;
const MAX_SYMBOLS = 40;      // a huge watchlist must not crowd out the base prompt

const _cache = new Map();    // userId -> { at, text }

function _get(pathAndQuery, userId) {
  const port = process.env.LANTERN_GARAGE_PORT || process.env.PORT || 4177;
  const headers = { 'x-keystone-internal': '1' };
  if (process.env.UNISONA_LOCAL_TOKEN) headers['x-unisona-token'] = process.env.UNISONA_LOCAL_TOKEN;
  if (userId) headers['x-keystone-user'] = encodeURIComponent(String(userId));
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathAndQuery, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
  });
}

/** Render the snapshot block, or "" when there is nothing trustworthy to say. */
function _render(rows, zones, takenAt) {
  if (!rows.length) return '';
  const lines = rows.slice(0, MAX_SYMBOLS).map((r) => {
    const z = (zones && zones[r.ticker]) || {};
    const px = r.price == null ? '?' : Number(r.price).toFixed(2);
    const chg = r.chg_pct == null ? '' : ` ${r.chg_pct >= 0 ? '+' : ''}${r.chg_pct}%`;
    const dir = z.direction ? ` ${z.direction}${z.confidence != null ? `/${z.confidence}%` : ''}` : '';
    const pos = z.position ? ' [HOLDING]' : '';
    return `${r.ticker} $${px}${chg}${dir}${pos}`;
  });
  const more = rows.length > MAX_SYMBOLS ? ` (+${rows.length - MAX_SYMBOLS} more)` : '';
  return [
    "\n\n# The user's trader watchlist (live snapshot)",
    `Taken ${takenAt}. These are THEIR symbols in THEIR order, with the engine's current`,
    'direction/confidence and [HOLDING] where they have an open position. Use this instead of',
    'assuming a default list. It is a snapshot, so for anything you are about to act or advise on,',
    'call trader_signal for that ticker to get the engine\'s full current reasoning, and say when',
    'your numbers came from. For a ticker NOT in this list, use trader_quote (the autopilot does',
    'not watch it — say so). You can read and analyse, but you cannot place, size, or cancel',
    'orders; if the user wants a trade executed, tell them to use the trader.',
    more ? `Symbols${more}:` : 'Symbols:',
    lines.join(' · '),
  ].join('\n');
}

/**
 * Compact watchlist context for `userId`. Always resolves; never throws, and returns
 * "" whenever there is no user, no server, no watchlist, or anything at all goes wrong.
 */
async function watchlistContext(userId) {
  if (!userId) return '';
  const hit = _cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.text;
  let text = '';
  try {
    const [wl, zx] = await Promise.all([
      _get('/api/trading/watchlist-prices', userId).catch(() => null),
      _get('/api/trading/zones', userId).catch(() => null),
    ]);
    const rows = Array.isArray(wl) ? wl : (wl && wl.prices) || [];
    text = _render(rows, (zx && zx.zones) || {}, new Date().toISOString());
  } catch (_e) {
    text = '';   // a chat turn must never fail because the trader is unreachable
  }
  _cache.set(userId, { at: Date.now(), text });
  return text;
}

module.exports = { watchlistContext, _render };
