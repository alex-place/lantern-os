/**
 * Send-on-delta cadence for the Kalshi collector — computes the next batch-poll
 * delay from the measured per-market variance rate, instead of a fixed 6s clock.
 *
 * Theory (docs/research/2026-07-17-control-engineering-tranche-analysis.md, Ask 2/4):
 * MSE-optimal sampling of a diffusing signal under a rate budget is a threshold
 * ("send-on-delta") policy, strictly better than periodic at equal request rate
 * (arXiv:1707.02531 Thm 1). A REST poller can't observe between polls, so the
 * implementable form is the self-trigger: sleep until the *predicted* innovation
 * crosses the threshold (arXiv:1609.07534 eq. 34) — for a random-walk price with
 * variance rate sigma², that is dt = beta/sigma². The collector polls all markets
 * in ONE batched request, so the batch must be as fresh as its fastest-moving
 * member: dt = beta / max_m sigma²_m. Today's 6s is the floor (never poll faster
 * than the current behavior), a cap bounds staleness when quiet (arXiv:0906.3588:
 * unmodeled events accrue while sleeping), and a spike observation resets to the
 * floor immediately.
 *
 * Pure module: no I/O, no timers — the collector owns the clock. All prices in
 * cents; variance rates in cents²/second.
 */

"use strict";

const DEFAULTS = {
  floorMs: 6000,        // today's cadence — adaptive mode never polls faster
  capMs: 60000,         // max staleness while exchange is open with live markets
  idleClosedMs: 60000,  // exchange inactive (the loop used to burn 2 req/6s all night)
  idleEmptyMs: 30000,   // exchange open but zero open markets (between games)
  halfLifeMs: 600000,   // EWMA half-life for the variance rate (10 min)
  // Variance rate (cents²/s) that maps to the floor cadence. 0.04 ≈ a market
  // moving 1 cent every 25s. Calibrated by experiments/kalshi_send_on_delta_replay.js.
  sigmaRefCents2PerSec: 0.04,
  spikeCents: 3,        // a move ≥ this within spikeWindowMs resets to the floor
  spikeWindowMs: 12000, // spikes only count over short gaps; over long gaps the
                        // variance rate (delta²/dt) prices the move instead
  staleTtlMs: 900000,   // drop per-ticker state not seen for 15 min
};

/** Read scheduler config from env (KALSHI_POLL_*), falling back to DEFAULTS. */
function parseEnvConfig(env = process.env) {
  const num = (key, fallback) => {
    const v = parseFloat(env[key]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    floorMs: num("KALSHI_POLL_FLOOR_MS", DEFAULTS.floorMs),
    capMs: num("KALSHI_POLL_CAP_MS", DEFAULTS.capMs),
    idleClosedMs: num("KALSHI_POLL_IDLE_MS", DEFAULTS.idleClosedMs),
    idleEmptyMs: num("KALSHI_POLL_EMPTY_MS", DEFAULTS.idleEmptyMs),
    halfLifeMs: num("KALSHI_POLL_HALFLIFE_MS", DEFAULTS.halfLifeMs),
    sigmaRefCents2PerSec: num("KALSHI_POLL_SIGMA_REF", DEFAULTS.sigmaRefCents2PerSec),
    spikeCents: num("KALSHI_POLL_SPIKE_CENTS", DEFAULTS.spikeCents),
    spikeWindowMs: num("KALSHI_POLL_SPIKE_WINDOW_MS", DEFAULTS.spikeWindowMs),
    staleTtlMs: num("KALSHI_POLL_STALE_TTL_MS", DEFAULTS.staleTtlMs),
  };
}

/** Mid price in cents for a Kalshi market object; null when unpriceable. */
function midCents(market) {
  const bid = Number(market?.yes_bid);
  const ask = Number(market?.yes_ask);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 && ask >= bid) {
    return (bid + ask) / 2;
  }
  const last = Number(market?.last_price);
  return Number.isFinite(last) && last > 0 ? last : null;
}

function createScheduler(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  /** ticker -> { mid, tsMs, sigma2 } */
  const state = new Map();
  let last = { intervalMs: cfg.floorMs, reason: "init", driver: null, sigma2Max: 0, tracked: 0 };

  function prune(nowMs) {
    for (const [ticker, s] of state) {
      if (nowMs - s.tsMs > cfg.staleTtlMs) state.delete(ticker);
    }
  }

  /**
   * Feed one observed snapshot (array of Kalshi market objects) taken at nowMs.
   * Returns { intervalMs, reason, driver, sigma2Max, tracked, spikeTicker }.
   */
  function observe(markets, nowMs) {
    prune(nowMs);
    let sigma2Max = 0;
    let driver = null;
    let spikeTicker = null;

    for (const m of markets || []) {
      const ticker = m?.ticker;
      const mid = midCents(m);
      if (!ticker || mid == null) continue;

      const prev = state.get(ticker);
      if (!prev) {
        // Unseen market: hot prior (= floor cadence) until measured — conservative.
        state.set(ticker, { mid, tsMs: nowMs, sigma2: cfg.sigmaRefCents2PerSec });
      } else {
        const dtSec = (nowMs - prev.tsMs) / 1000;
        if (dtSec > 0) {
          const delta = mid - prev.mid;
          if (Math.abs(delta) >= cfg.spikeCents && dtSec * 1000 <= cfg.spikeWindowMs) {
            spikeTicker = ticker;
          }
          // Irregular-interval EWMA: weight of the old estimate decays with
          // elapsed time, so a long sleep doesn't underweight fresh evidence.
          const decay = Math.pow(0.5, (dtSec * 1000) / cfg.halfLifeMs);
          const rate = (delta * delta) / dtSec;
          prev.sigma2 = decay * prev.sigma2 + (1 - decay) * rate;
          prev.mid = mid;
          prev.tsMs = nowMs;
        }
      }

      const s = state.get(ticker);
      if (s.sigma2 > sigma2Max) {
        sigma2Max = s.sigma2;
        driver = ticker;
      }
    }

    let intervalMs;
    let reason;
    if (spikeTicker) {
      intervalMs = cfg.floorMs;
      reason = "spike";
    } else if (sigma2Max <= 0) {
      intervalMs = cfg.capMs;
      reason = "no-priceable-markets";
    } else {
      // dt = beta / sigma²_max with beta = floor · sigmaRef (arXiv:1609.07534).
      const raw = cfg.floorMs * (cfg.sigmaRefCents2PerSec / sigma2Max);
      intervalMs = Math.min(cfg.capMs, Math.max(cfg.floorMs, Math.round(raw)));
      reason = intervalMs === cfg.floorMs ? "hot" : intervalMs === cfg.capMs ? "quiet-cap" : "scaled";
    }

    last = { intervalMs, reason, driver, sigma2Max, tracked: state.size, spikeTicker };
    return last;
  }

  /** Cadence when no snapshot was collected. kind: 'closed' | 'empty' | 'error'. */
  function idle(kind) {
    const intervalMs =
      kind === "closed" ? cfg.idleClosedMs :
      kind === "empty" ? cfg.idleEmptyMs :
      cfg.floorMs; // errors: retry at the floor; 429 backoff is handled outside
    last = { ...last, intervalMs, reason: `idle-${kind}` };
    return { intervalMs, reason: last.reason };
  }

  function stats() {
    return {
      tracked: state.size,
      sigma2Max: last.sigma2Max,
      driver: last.driver,
      intervalMs: last.intervalMs,
      reason: last.reason,
      config: { ...cfg },
    };
  }

  return { observe, idle, stats };
}

module.exports = { createScheduler, parseEnvConfig, midCents, DEFAULTS };
