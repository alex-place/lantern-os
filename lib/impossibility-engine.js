"use strict";

/**
 * Impossibility Engine — constraint-based state elimination.
 *
 * Knowledge = Remaining States After Constraint Elimination
 *
 * The engine does not predict. It loads all world-states compatible with known
 * constraints, eliminates impossible branches, and returns what remains.
 * If only one valid state survives, the answer is determined — not guessed.
 *
 * State space for binary prediction markets:
 *   A probability interval [lo, hi] over P(YES) ∈ [0, 100] centile space.
 *   Width = 100 → complete uncertainty (all states remain)
 *   Width = 0  → fully determined (one state remains)
 *
 * Shelby lacks information. The answer may still be determined.
 */

const DETERMINED_THRESHOLD = 15;  // interval width ≤ 15 → "DETERMINED"
const CONFIDENT_THRESHOLD  = 40;  // interval width ≤ 40 → "CONFIDENT"

// ── Core engine ──────────────────────────────────────────────────────────────

class ImpossibilityEngine {
  constructor(constraints = []) {
    this.constraints = constraints;
  }

  /**
   * Solve one market: eliminate impossible states, return the remainder.
   *
   * @param {object} market - normalized Kalshi market object (yes_ask in cents)
   * @returns {EngineResult}
   */
  solve(market) {
    let lo = 0, hi = 100;
    const trace = [];

    for (const c of this.constraints) {
      const result = c.apply(market, lo, hi);
      if (!result) continue;

      const prevWidth = hi - lo;
      if (result.lo != null) lo = Math.max(lo, result.lo);
      if (result.hi != null) hi = Math.min(hi, result.hi);

      // Floor: never collapse below 2-wide (epistemic floor)
      lo = Math.max(0, Math.min(lo, 98));
      hi = Math.min(100, Math.max(hi, lo + 2));

      const eliminated = prevWidth - (hi - lo);
      if (eliminated > 0.4) {
        trace.push({
          constraint: c.name,
          eliminated: +eliminated.toFixed(1),
          remaining: +(hi - lo).toFixed(1),
          interval: [+lo.toFixed(1), +hi.toFixed(1)],
        });
      }
    }

    const width    = hi - lo;
    const mid      = (lo + hi) / 2;
    const favSide  = mid >= 50 ? "yes" : "no";
    const favProb  = favSide === "yes" ? Math.round(mid) : Math.round(100 - mid);
    const confidence  = Math.min(99, Math.round(100 - width));
    const determined  = width <= DETERMINED_THRESHOLD;
    const confident   = width <= CONFIDENT_THRESHOLD;
    const stateLabel  = determined ? "DETERMINED" : confident ? "CONFIDENT" : "UNCERTAIN";

    return {
      ticker: market.ticker,
      title:  market.title || market.ticker,
      favSide,
      favProb,
      confidence,
      determined,
      confident,
      stateLabel,
      validRange: { lo: +lo.toFixed(1), hi: +hi.toFixed(1), width: +width.toFixed(1) },
      knowledge: determined
        ? `${favSide.toUpperCase()} — state determined (${favProb}% probable, ${trace.length} constraints applied)`
        : `${stateLabel} — P(YES) ∈ [${lo.toFixed(0)}, ${hi.toFixed(0)}] (${width.toFixed(0)} valid states remain)`,
      trace,
    };
  }

  /** Solve a batch, sorted by confidence descending. */
  solveAll(markets) {
    return markets
      .map(m => ({ market: m, result: this.solve(m) }))
      .sort((a, b) => b.result.confidence - a.result.confidence);
  }
}

// ── Built-in Kalshi constraints ───────────────────────────────────────────────
// Each has: name (string) + apply(market, lo, hi) → { lo?, hi? } | null

/**
 * C1 — Price signal.
 * The market's yes_ask IS the crowd's consensus on P(YES).
 * Narrows valid range to [yesAsk ± buffer] where buffer grows with spread.
 */
const priceConstraint = {
  name: "price",
  apply(market, lo, hi) {
    const yesAsk = market.yes_ask;
    if (yesAsk == null) return null;
    const spread = Math.abs((market.yes_ask ?? 50) - (market.no_ask ?? 50));
    const buffer = Math.max(5, spread * 0.55);
    return { lo: yesAsk - buffer, hi: yesAsk + buffer };
  },
};

/**
 * C2 — Spread quality.
 * Tight spread → market makers agree → price signal is strong → narrow further.
 * Wide spread → market makers disagree → price signal is weak → widen.
 */
const spreadConstraint = {
  name: "spread",
  apply(market, lo, hi) {
    const spread = Math.abs((market.yes_ask ?? 50) - (market.no_ask ?? 50));
    const center = (lo + hi) / 2;
    const half   = (hi - lo) / 2;
    if (spread <= 1)  return { lo: center - half * 0.6, hi: center + half * 0.6 };
    if (spread <= 3)  return { lo: center - half * 0.8, hi: center + half * 0.8 };
    if (spread >= 20) return { lo: center - half * 1.3, hi: center + half * 1.3 };
    return null;
  },
};

/**
 * C3 — Momentum.
 * A recent price tick means the market is moving toward the true state.
 * Shift the valid interval in the direction of movement.
 */
const momentumConstraint = {
  name: "momentum",
  apply(market, lo, hi) {
    const prevDollars = market.previous_yes_ask_dollars;
    const prev = prevDollars != null ? Math.round(parseFloat(prevDollars) * 100) : null;
    const cur  = market.yes_ask;
    if (prev == null || cur == null) return null;
    const tick = cur - prev;
    if (Math.abs(tick) < 2) return null;
    const shift = tick * 0.45;
    return { lo: lo + shift, hi: hi + shift };
  },
};

/**
 * C4 — Urgency / time to close.
 * Near resolution, market price converges to truth.
 * ≤5m: price IS the answer (collapse to ±4).
 * ≤15m: very strong (collapse 50%).
 * ≤60m: moderate (narrow 25%).
 */
const urgencyConstraint = {
  name: "urgency",
  apply(market, lo, hi) {
    if (!market.close_time) return null;
    const minsLeft = (new Date(market.close_time).getTime() - Date.now()) / 60000;
    if (minsLeft <= 0) return null;

    const center = market.yes_ask != null ? market.yes_ask : (lo + hi) / 2;
    const half   = (hi - lo) / 2;

    if (minsLeft <= 5)  return { lo: center - 4,          hi: center + 4 };
    if (minsLeft <= 15) return { lo: center - half * 0.5,  hi: center + half * 0.5 };
    if (minsLeft <= 60) return { lo: center - half * 0.75, hi: center + half * 0.75 };
    return null;
  },
};

/**
 * C5 — Volume.
 * High volume → many observers agree → price is well-tested → narrow.
 * Thin volume → few observers → price untested → widen.
 */
const volumeConstraint = {
  name: "volume",
  apply(market, lo, hi) {
    const vol    = market.volume ?? 0;
    const center = (lo + hi) / 2;
    const half   = (hi - lo) / 2;
    if (vol > 50000) return { lo: center - half * 0.60, hi: center + half * 0.60 };
    if (vol > 10000) return { lo: center - half * 0.75, hi: center + half * 0.75 };
    if (vol > 1000)  return { lo: center - half * 0.88, hi: center + half * 0.88 };
    if (vol < 50)    return { lo: center - half * 1.20, hi: center + half * 1.20 };
    return null;
  },
};

/**
 * C6 — Binary complement constraint.
 * In a two-outcome market YES + NO = 100¢ (plus spread).
 * If the sum is far from 100, the market is dislocated → widen (price signal unreliable).
 * If the sum is near 100, markets are consistent → confirm price constraint.
 */
const complementConstraint = {
  name: "complement",
  apply(market, lo, hi) {
    const yesAsk = market.yes_ask;
    const noAsk  = market.no_ask;
    if (yesAsk == null || noAsk == null) return null;
    const sum = yesAsk + noAsk;
    // Arbitrage dislocation: sum < 90 means YES is cheap relative to NO
    if (sum < 90) {
      // YES underpriced — shift valid range upward (more YES states remain viable)
      const shift = (100 - sum) * 0.3;
      return { lo: lo + shift, hi: hi + shift };
    }
    // sum > 115 means market maker spread is extremely wide — widen
    if (sum > 115) {
      const center = (lo + hi) / 2;
      const half   = (hi - lo) / 2 * 1.15;
      return { lo: center - half, hi: center + half };
    }
    return null;
  },
};


/**
 * C7 -- Convergence IO certificate (Sigma0-gated).
 *
 * MEASURED ACCURACY (June 13 2026, 20 resolved MLB markets):
 *   AR(1) fixed-point accuracy: 40% correct direction -- BELOW 50% baseline.
 *   Average signal lead-time: 67% of game elapsed (too late to trade).
 *   Root cause: AR(1) assumes mean-reversion. MLB game prices trend to 0/1.
 *
 * STATUS: wired but EXCLUDED from DEFAULT_CONSTRAINTS.
 * Re-evaluate for non-game markets (elections, econ data) where mean-reversion
 * is plausible, OR when upgraded to a momentum-aware divergence model (|l| > 1).
 *
 * Compose via: createKalshiEngine([cioConstraint])
 * Cache: data/kalshi/cio-trajectory-cache.jsonl
 * Issues: #424 (model), #425 (flywheel), #426 (activation criteria)
 */
const cioConstraint = {
  name: "cio",
  apply(market, lo, hi) {
    const cio = market.cio;
    if (!cio || !cio.has_signal || cio.p_star == null) return null;
    const pStar = cio.p_star * 100;
    const edge  = cio.edge;
    if (Math.abs(edge) < 0.06) return null;
    const strength = Math.min(0.8, Math.abs(edge) * 3);
    const center   = (lo + hi) / 2;
    const newCenter = center + (pStar - center) * strength;
    const half      = (hi - lo) / 2 * (1 - strength * 0.4);
    return { lo: newCenter - half, hi: newCenter + half };
  },
};

// -- Default stack ---------------------------------------------------------------
// C7 (cio) excluded: 40% accuracy on trend markets -- net negative signal.

const DEFAULT_CONSTRAINTS = [
  priceConstraint,
  spreadConstraint,
  momentumConstraint,
  urgencyConstraint,
  volumeConstraint,
  complementConstraint,
];

function createKalshiEngine(extraConstraints = []) {
  return new ImpossibilityEngine([...DEFAULT_CONSTRAINTS, ...extraConstraints]);
}

// ── Card builder: engine result → terminal-compatible card ────────────────────

function engineResultToCard(market, result) {
  const minsToClose = market.close_time
    ? Math.round((new Date(market.close_time).getTime() - Date.now()) / 60000)
    : null;

  const yesAsk = market.yes_ask ?? 50;
  const noAsk  = market.no_ask  ?? 50;
  const yesPct = Math.round(result.validRange.lo + result.validRange.width / 2);
  const spread = Math.abs(yesAsk - noAsk);

  const urgencyLevel = minsToClose == null ? "normal"
    : minsToClose <= 5  ? "critical"
    : minsToClose <= 30 ? "hot"
    : "normal";

  const reason = [
    `${result.stateLabel}`,
    `${result.validRange.width.toFixed(0)} states remain`,
    minsToClose != null ? `${minsToClose}m to close` : null,
    `${spread}¢ spread`,
  ].filter(Boolean).join(" · ");

  return {
    kind: "entry",
    action: "buy",
    ticker: market.ticker,
    title: market.title || market.ticker,
    yesLabel: "YES",
    noLabel: "NO",
    yesCents: yesAsk,
    noCents: noAsk,
    yesPct,
    favSide: result.favSide,
    favLabel: result.favSide === "yes" ? "YES" : "NO",
    favAsk:   result.favSide === "yes" ? yesAsk : noAsk,
    conviction: result.confidence,
    reason,
    minsToClose,
    close: market.close_time,
    urgencyLevel,
    // Engine-specific fields
    determined: result.determined,
    stateLabel: result.stateLabel,
    knowledge: result.knowledge,
    validRange: result.validRange,
    trace: result.trace,
    engineScore: result.confidence,
  };
}

module.exports = {
  ImpossibilityEngine,
  createKalshiEngine,
  engineResultToCard,
  DEFAULT_CONSTRAINTS,
  // Export individual constraints for composition
  priceConstraint,
  spreadConstraint,
  momentumConstraint,
  urgencyConstraint,
  volumeConstraint,
  complementConstraint,
  cioConstraint,
};
