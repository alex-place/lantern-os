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

  if (rule.type === 'price') {
    // Every operator is judged on the CURRENT price and, where the condition is about a
    // change, the price this rule last saw. A rule with no previous observation cannot
    // have crossed anything yet, so those operators wait one scan rather than firing on
    // the first tick they see.
    if (!Number.isFinite(price) || price <= 0) return null;
    const prev = Number.isFinite(rule.lastPrice) ? rule.lastPrice : null;
    const v = rule.value, v2 = rule.value2;
    const lo = Math.min(v, v2 == null ? v : v2), hi = Math.max(v, v2 == null ? v : v2);
    const inBand = (x) => x >= lo && x <= hi;
    const pct = prev ? ((price - prev) / prev) * 100 : 0;
    let hit = false, how = '';
    switch (rule.op) {
      case 'crossing':
        hit = prev != null && ((prev < v && price >= v) || (prev > v && price <= v));
        how = 'crossed ' + v; break;
      case 'crossing_up':
        hit = prev != null && prev < v && price >= v; how = 'crossed up through ' + v; break;
      case 'crossing_down':
        hit = prev != null && prev > v && price <= v; how = 'crossed down through ' + v; break;
      case 'greater': hit = price > v; how = 'is above ' + v; break;
      case 'less':    hit = price < v; how = 'is below ' + v; break;
      case 'entering_channel':
        hit = prev != null && !inBand(prev) && inBand(price); how = 'entered ' + lo + '-' + hi; break;
      case 'exiting_channel':
        hit = prev != null && inBand(prev) && !inBand(price); how = 'left ' + lo + '-' + hi; break;
      case 'inside_channel':  hit = inBand(price);  how = 'is inside ' + lo + '-' + hi; break;
      case 'outside_channel': hit = !inBand(price); how = 'is outside ' + lo + '-' + hi; break;
      case 'moving_up':   hit = prev != null && (price - prev) >= v; how = 'moved up ' + v; break;
      case 'moving_down': hit = prev != null && (prev - price) >= v; how = 'moved down ' + v; break;
      case 'moving_up_pct':   hit = prev != null && pct >= v;  how = 'moved up ' + v + '%'; break;
      case 'moving_down_pct': hit = prev != null && -pct >= v; how = 'moved down ' + v + '%'; break;
      default: return null;
    }
    if (!hit) return null;
    return {
      message: `${rule.symbol}: $${price.toFixed(2)} ${how}`,
      evidence: { op: rule.op, price, prev, value: v, value2: v2 ?? null },
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
      const seenPrices = {};                       // batched: one write per user, not per rule
      for (const rule of store.listRules(uid)) {
        try {
          // Record what a price rule saw even when it is cooling down or disabled --
          // otherwise the "previous price" would jump across the quiet window and the
          // next comparison would be against a stale observation.
          if (rule.type === 'price') {
            const sig0 = bySym.get(rule.symbol);
            const px = sig0 && Number(sig0.entry_price);
            if (Number.isFinite(px) && px > 0) seenPrices[rule.id] = px;
          }
          if (rule.enabled === false || _coolingDown(rule, nowMs)) continue;
          const hit = matchRule(rule, bySym.get(rule.symbol));
          if (!hit) continue;
          const row = {
            ts: new Date(nowMs).toISOString(),
            ruleId: rule.id, symbol: rule.symbol, type: rule.type,
            message: hit.message, evidence: hit.evidence,
          };
          store.recordFire(uid, rule.id, row);
          // Delivery beyond the feed (#3249): fire-and-forget, fail-soft —
          // the in-app row above is already durable whatever email does.
          try { require('./alert-delivery').deliver(uid, row).catch(() => {}); } catch (_e) { /* absent → in-app only */ }
          fired += 1;
        } catch (_e) { /* one bad rule must not stop the rest */ }
      }
      try { store.recordPrices(uid, seenPrices); } catch (_e) { /* never break the scan */ }
    }
  } catch (_e) { /* alerting must never break the scan loop */ }
  return fired;
}

module.exports = { evaluateScan, matchRule };
