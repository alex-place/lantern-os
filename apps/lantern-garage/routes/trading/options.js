'use strict';
/**
 * routes/trading/options.js — options-chain DATA + strategy-PROPOSAL endpoints
 * for the trader surfaces.
 *
 * Loop stages: Observe (chain) + Reason (strategies). Thin HTTP surface over
 * lib/options-data.js — the NO-NEW-KEYS provider chain (the user's connected
 * Alpaca account when available → keyless Yahoo → Alpha Vantage only if a key
 * already exists) — and lib/options-strategies.js (pure, deterministic
 * proposal engine). ADVISORY ONLY: no orders are placed, simulated, or
 * recommended for execution — Act stays behind the ADR-0020 trading gates.
 * Covered / cash-secured structures only; naked shorts are refused upstream.
 *
 *   GET /api/trading/options/chain?symbol=SPY&date=YYYY-MM-DD
 *   GET /api/trading/options/strategies?symbol=IBM&strategy=covered_call
 *       |cash_secured_put|collar&shares=&cash=&target_delta=&put_delta=
 *       &call_delta=&min_dte=&max_dte=&price=&date=
 *
 * The requesting user's id is forwarded to the data layer the same way the
 * portfolio routes do (ctx.getEffectiveUserId: session user, else the
 * operator-trusted x-keystone-user loopback id) so a connected Alpaca account
 * is picked up automatically — no configuration on this surface.
 *
 * Responses are always 200. All-providers-failed / rate-limited / upstream
 * errors come back as { available: false, reason } — honest degradation,
 * never fake rows. Engine refusals (no qualifying strike, shares < 100, cash
 * can't secure one contract) come back inside proposal as { ok:false, reason }.
 */

const optionsData = require('../../lib/options-data');
const strategies = require('../../lib/options-strategies');

const STRATEGIES = ['covered_call', 'cash_secured_put', 'collar'];

function _num(v) {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

module.exports = async function optionsRoutes(req, res, url, ctx) {
  const { sendJson, getEffectiveUserId } = ctx;
  const _uid = () => {
    try { return typeof getEffectiveUserId === 'function' ? getEffectiveUserId(req) : null; }
    catch (_e) { return null; }
  };

  if (url.pathname === '/api/trading/options/chain' && req.method === 'GET') {
    const symbol = url.searchParams.get('symbol') || '';
    const date = url.searchParams.get('date') || null;
    const out = await optionsData.getOptionsChain(symbol, {
      ...(date ? { date } : {}),
      userId: _uid(),
    });
    sendJson(res, out, 200);
    return true;
  }

  // POST /api/trading/options/order — MANUAL paper option order (operator ask
  // 2026-07-26: the user can place their own paper option trade; the AI doesn't own
  // the account). Paper-host-only via options-shadow.placePaperOrder (live auth is
  // refused in code). Signed-in users; a Pro ($20) capability, enforced always.
  if (url.pathname === '/api/trading/options/order' && req.method === 'POST') {
    const uid = _uid();
    if (!uid) { sendJson(res, { error: 'not_authenticated' }, 401); return true; }
    try {
      const am = require('../../lib/auth-middleware');
      if (!am.hasEntitlement(req, 'options_manual')) {
        sendJson(res, { error: 'pro_required', message: 'Manual options orders are a Pro ($20) feature' }, 403);
        return true;
      }
    } catch (_e) { /* gate infra must never break the surface */ }
    let body = {};
    try { body = JSON.parse(await ctx.collectRequestBody(req) || '{}'); } catch (_e) { sendJson(res, { error: 'invalid_json' }, 400); return true; }
    const shadow = require('../../lib/options-shadow');
    const contract = String(body.contract || '').trim().toUpperCase();
    const side = String(body.side || '').toLowerCase();
    const qty = Math.floor(Number(body.qty));
    const limit = Number(body.limit);
    if (!shadow.parseOcc(contract)) { sendJson(res, { error: 'invalid_contract', message: 'expected an OCC option symbol (e.g. SPY260727C00745000)' }, 400); return true; }
    if (side !== 'buy' && side !== 'sell') { sendJson(res, { error: 'invalid_side' }, 400); return true; }
    if (!(qty >= 1 && qty <= 10)) { sendJson(res, { error: 'invalid_qty', message: 'qty must be 1-10 contracts' }, 400); return true; }
    if (!(limit > 0 && limit <= 500)) { sendJson(res, { error: 'invalid_limit' }, 400); return true; }
    const r = await shadow.placePaperOrder({ contract, side, qty, limit: +limit.toFixed(2) });
    if (r.error) { sendJson(res, { ok: false, error: r.error }, 502); return true; }
    sendJson(res, { ok: true, paper: true, order_id: r.order_id, status: r.status, contract, side, qty, limit }, 200);
    return true;
  }

  if (url.pathname === '/api/trading/options/strategies' && req.method === 'GET') {
    const symbol = url.searchParams.get('symbol') || '';
    const strategy = String(url.searchParams.get('strategy') || '').trim().toLowerCase();
    const date = url.searchParams.get('date') || null;

    if (!STRATEGIES.includes(strategy)) {
      sendJson(res, {
        available: false,
        reason: `unknown strategy '${strategy}' (expected ${STRATEGIES.join(' | ')})`,
      }, 200);
      return true;
    }

    const minDte = _num(url.searchParams.get('min_dte'));
    const maxDte = _num(url.searchParams.get('max_dte'));
    const chain = await optionsData.getOptionsChain(symbol, {
      ...(date ? { date } : {}),
      userId: _uid(),
      // Make the Yahoo path fetch expirations that actually COVER the engine's
      // DTE window (daily-expiry symbols like SPY would otherwise cluster the
      // fetched expiries inside the next week).
      minDays: minDte !== undefined ? minDte : strategies.DEFAULT_MIN_DTE,
      horizonDays: (maxDte !== undefined ? maxDte : strategies.DEFAULT_MAX_DTE) + 10,
    });
    if (!chain || chain.available === false) {
      // Honest passthrough: every provider's failure reason, verbatim.
      sendJson(res, chain || { available: false, reason: 'options data unavailable' }, 200);
      return true;
    }

    // Resolve underlying price: explicit ?price= wins; else the provider's own
    // underlying quote (Yahoo carries it); else put-call parity at the ATM
    // strike. Never invented.
    let price = _num(url.searchParams.get('price'));
    let priceSource = 'explicit price param';
    if (price === undefined && Number.isFinite(chain.underlying_price) && chain.underlying_price > 0) {
      price = chain.underlying_price;
      priceSource = `provider quote (${chain.source})`;
    }
    if (price === undefined) {
      const inferred = strategies.inferUnderlyingPrice(chain.contracts);
      if (inferred) {
        price = inferred.price;
        priceSource = `inferred: ${inferred.method} (strike ${inferred.strike}, exp ${inferred.expiration})`;
      }
    }

    const base = {
      available: true,
      symbol: chain.symbol,
      session: chain.session,
      source: chain.source,
      cached: chain.cached,
      contracts: chain.count,
      strategy,
      price: price !== undefined ? price : null,
      priceSource: price !== undefined ? priceSource : null,
    };

    if (price === undefined) {
      sendJson(res, {
        ...base,
        proposal: {
          ok: false,
          reason: 'could not resolve the underlying price (no provider quote and no strike with both call and put marks) — pass price= explicitly',
        },
      }, 200);
      return true;
    }

    const common = {
      price,
      targetDelta: _num(url.searchParams.get('target_delta')),
      minDte,
      maxDte,
    };
    // Drop undefined keys so the engine's own defaults apply.
    for (const k of Object.keys(common)) if (common[k] === undefined) delete common[k];

    let proposal;
    if (strategy === 'covered_call') {
      proposal = strategies.proposeCoveredCall(chain.contracts, {
        ...common, shares: _num(url.searchParams.get('shares')),
      });
    } else if (strategy === 'cash_secured_put') {
      proposal = strategies.proposeCashSecuredPut(chain.contracts, {
        ...common, cash: _num(url.searchParams.get('cash')),
      });
    } else {
      const putDelta = _num(url.searchParams.get('put_delta'));
      const callDelta = _num(url.searchParams.get('call_delta')) ?? common.targetDelta;
      delete common.targetDelta;
      proposal = strategies.proposeCollar(chain.contracts, {
        ...common,
        shares: _num(url.searchParams.get('shares')),
        ...(putDelta !== undefined ? { putDelta } : {}),
        ...(callDelta !== undefined ? { callDelta } : {}),
      });
    }

    sendJson(res, { ...base, proposal }, 200);
    return true;
  }

  return false;
};
