'use strict';

/**
 * alert-engine.js — evaluate user alert rules against the live scan (#3248).
 *
 * Piggybacks the existing ~1/min autoscan: routes/trading.js hands the finished
 * scan result here, so alerting costs ZERO extra market-data calls. Three rule
 * types, all computed from fields the scan already carries:
 *
 *   signal   — the engine emitted BULLISH / BEARISH (or any) on the symbol
 *   zone     — price is within proximityPct of the computed support/resistance
 *   washout  — the Σ₀ convergence verdict is ENTER (a washout setup confirmed;
 *              raw IBS is not carried on scan rows, and the ENTER verdict is the
 *              engine's own, stricter version of the same question)
 *
 * Dedup/cooldown: a rule re-fires only after its cooldownMin has passed
 * (lastFiredAt is server-stamped in the store). Evaluation is fail-soft and
 * bounded (MAX_RULES_PER_USER per user) — it must never break a scan.
 */

const store = require('./alert-store');

/** Pure predicate — exported for tests. Returns null (no match) or a fire descriptor. */
function matchRule(rule, sig) {
  if (!rule || rule.enabled === false || !sig) return null;
  if (String(sig.symbol || '').toUpperCase() !== rule.symbol) return null;
  const price = Number(sig.entry_price);

  if (rule.type === 'signal') {
    const dir = String(sig.direction || '').toUpperCase();
    if (dir !== 'BULLISH' && dir !== 'BEARISH') return null;
    if (rule.direction !== 'ANY' && dir !== rule.direction) return null;
    return {
      message: `${rule.symbol}: ${dir.toLowerCase()} signal fired` + (Number.isFinite(price) ? ` at $${price.toFixed(2)}` : ''),
      evidence: { direction: dir, confidence: sig.confidence ?? null, rsi: sig.rsi ?? null },
    };
  }

  if (rule.type === 'zone') {
    const level = Number(rule.zone === 'support' ? sig.support : sig.resistance);
    if (!Number.isFinite(level) || !Number.isFinite(price) || price <= 0 || level <= 0) return null;
    const distPct = Math.abs(price - level) / price * 100;
    if (distPct > rule.proximityPct) return null;
    return {
      message: `${rule.symbol}: $${price.toFixed(2)} is within ${rule.proximityPct}% of ${rule.zone} $${level.toFixed(2)}`,
      evidence: { zone: rule.zone, level, distPct: Math.round(distPct * 100) / 100 },
    };
  }

  if (rule.type === 'washout') {
    const verdict = sig.convergence && String(sig.convergence.decision || '').toUpperCase();
    if (verdict !== 'ENTER') return null;
    return {
      message: `${rule.symbol}: washout setup confirmed — the engine's ENTER verdict` + (Number.isFinite(price) ? ` at $${price.toFixed(2)}` : ''),
      evidence: { decision: 'ENTER', p_win: (sig.convergence && sig.convergence.p_win) ?? null },
    };
  }

  return null;
}

function _coolingDown(rule, nowMs) {
  if (!rule.lastFiredAt) return false;
  const last = Date.parse(rule.lastFiredAt);
  return Number.isFinite(last) && (nowMs - last) < rule.cooldownMin * 60000;
}

/**
 * Evaluate every user's rules against one scan result. Returns the number of
 * alerts fired (for the scan log line). Never throws.
 */
function evaluateScan(scan, nowMs = Date.now()) {
  let fired = 0;
  try {
    const signals = (scan && Array.isArray(scan.signals)) ? scan.signals : [];
    if (!signals.length) return 0;
    const bySym = new Map();
    for (const s of signals) bySym.set(String(s.symbol || '').toUpperCase(), s);
    for (const uid of store.listUsersWithRules()) {
      for (const rule of store.listRules(uid)) {
        try {
          if (rule.enabled === false || _coolingDown(rule, nowMs)) continue;
          const hit = matchRule(rule, bySym.get(rule.symbol));
          if (!hit) continue;
          store.recordFire(uid, rule.id, {
            ts: new Date(nowMs).toISOString(),
            ruleId: rule.id, symbol: rule.symbol, type: rule.type,
            message: hit.message, evidence: hit.evidence,
          });
          fired += 1;
        } catch (_e) { /* one bad rule must not stop the rest */ }
      }
    }
  } catch (_e) { /* alerting must never break the scan loop */ }
  return fired;
}

module.exports = { evaluateScan, matchRule };
