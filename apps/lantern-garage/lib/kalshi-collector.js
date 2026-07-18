/**
 * Kalshi Tight-Band Collector — polls live markets when active.
 *
 * Cadence: fixed 6s by default. With KALSHI_ADAPTIVE_POLL=1 the delay between
 * polls is send-on-delta (lib/kalshi-adaptive-poll.js): the measured variance
 * rate of the fastest-moving market sets the next delay (floor 6s = today's
 * behavior, cap 60s when quiet, idle cadence when the exchange is closed,
 * spike-reset to the floor). Both modes run on a setTimeout chain, so polls
 * never overlap and the next one is scheduled only after the current completes
 * — during a 429 backoff nothing is scheduled until the backoff expires.
 *
 * Stores snapshots as JSONL in data/kalshi/tight-band-{YYYY-MM-DD}.jsonl
 * Each line: {ts, exitCount, entryCount, snapshot: {markets: [...], generatedAt}}
 *
 * The swipe deck uses the latest snapshot for live trajectory analysis instead
 * of making a fresh API call each time.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const kalshi = require("./kalshi-api");
const { createScheduler, parseEnvConfig } = require("./kalshi-adaptive-poll");

const KALSHI_DIR = path.resolve(__dirname, "..", "..", "..", "data", "kalshi");
const FIXED_INTERVAL_MS = 6000;

const adaptiveEnabled = String(process.env.KALSHI_ADAPTIVE_POLL || "") === "1";
const scheduler = adaptiveEnabled ? createScheduler(parseEnvConfig()) : null;

let timer = null;
let latestSnapshot = null;
let isRunning = false;
let backoffUntil = null;
let currentIntervalMs = FIXED_INTERVAL_MS;
let nextPollAt = null;
let lastReason = adaptiveEnabled ? "init" : "fixed";

function getSnapshotPath() {
  const today = new Date().toISOString().split("T")[0];
  return path.join(KALSHI_DIR, `tight-band-${today}.jsonl`);
}

function logSnapshot(snapshot) {
  try {
    fs.mkdirSync(KALSHI_DIR, { recursive: true });
    const ts = new Date().toISOString();
    const line = JSON.stringify({
      ts,
      markets: snapshot.cards?.length || 0,
      exitCount: snapshot.exitCount || 0,
      snapshot,
    });
    fs.appendFileSync(getSnapshotPath(), line + "\n");
  } catch (e) {
    console.error("[Kalshi Collector] snapshot log failed:", e.message);
  }
}

/**
 * Fetch and store a fresh now-slice snapshot. Returns the snapshot or null.
 * The outcome kind (for cadence decisions) is reported via _lastOutcome.
 */
let _lastOutcome = "init";

async function collectSnapshot() {
  if (backoffUntil && Date.now() < backoffUntil) {
    _lastOutcome = "backoff";
    return null;
  }

  try {
    // Check if exchange is active
    const status = await kalshi.getExchangeStatus();
    if (status.status === 429) {
      const retryAfter = Math.max(30, parseInt(status.retryAfter || "60", 10)) * 1000;
      backoffUntil = Date.now() + retryAfter;
      console.warn(`[Kalshi Collector] 429 rate limit — pausing ${retryAfter / 1000}s`);
      _lastOutcome = "backoff";
      return null;
    }
    if (!status.ok || !status.data?.exchange_active) {
      _lastOutcome = "closed";
      return null; // markets closed
    }

    // Get live markets
    const mk = await kalshi.getMarkets({
      series_ticker: "KXMLBGAME",
      status: "open",
      limit: 200,
    });

    if (mk.status === 429) {
      const retryAfter = Math.max(30, parseInt(mk.retryAfter || "60", 10)) * 1000;
      backoffUntil = Date.now() + retryAfter;
      console.warn(`[Kalshi Collector] 429 rate limit — pausing ${retryAfter / 1000}s`);
      _lastOutcome = "backoff";
      return null;
    }
    if (!mk.ok || !mk.data?.markets) {
      _lastOutcome = "error";
      return null;
    }

    const markets = mk.data.markets;
    if (markets.length === 0) {
      _lastOutcome = "empty";
      return null; // no open games
    }

    // Build snapshot structure matching kalshi-suggest output
    const snapshot = {
      count: markets.length,
      exitCount: 0, // exits require positions; would need separate call
      generatedAt: new Date().toISOString(),
      note: "Tight-band 6s snapshot for delta analysis",
      markets,
    };

    latestSnapshot = snapshot;
    logSnapshot(snapshot);
    _lastOutcome = "ok";
    return snapshot;
  } catch (e) {
    console.error("[Kalshi Collector] collection failed:", e.message);
    _lastOutcome = "error";
    return null;
  }
}

/**
 * Decide the delay until the next poll, from the outcome of the one that just
 * finished. Fixed mode always returns 6s (legacy cadence, including while the
 * exchange is closed). Adaptive mode delegates to the send-on-delta scheduler;
 * a pending 429 backoff overrides both modes so no polls burn during it.
 */
function nextDelayMs(snapshot) {
  const now = Date.now();
  if (backoffUntil && now < backoffUntil) {
    lastReason = "backoff";
    return Math.max(1000, backoffUntil - now);
  }
  if (!adaptiveEnabled) {
    lastReason = "fixed";
    return FIXED_INTERVAL_MS;
  }
  if (snapshot && Array.isArray(snapshot.markets)) {
    const res = scheduler.observe(snapshot.markets, now);
    lastReason = res.reason;
    return res.intervalMs;
  }
  const kind = _lastOutcome === "closed" ? "closed" : _lastOutcome === "empty" ? "empty" : "error";
  const res = scheduler.idle(kind);
  lastReason = res.reason;
  return res.intervalMs;
}

function scheduleNext(delayMs) {
  if (!isRunning) return;
  currentIntervalMs = delayMs;
  nextPollAt = Date.now() + delayMs;
  timer = setTimeout(tick, delayMs);
}

async function tick() {
  let snapshot = null;
  try {
    snapshot = await collectSnapshot();
  } catch (e) {
    console.error("[Kalshi Collector] polling failed:", e);
    _lastOutcome = "error";
  }
  scheduleNext(nextDelayMs(snapshot));
}

/**
 * Start the polling loop.
 */
function start() {
  if (isRunning) return;
  isRunning = true;
  console.info(
    `[Kalshi Collector] starting ${adaptiveEnabled ? "adaptive send-on-delta" : "6s fixed"} polling loop`
  );
  // Initial collection, then self-scheduling chain.
  tick();
}

/**
 * Stop the polling loop
 */
function stop() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  isRunning = false;
  nextPollAt = null;
  console.info("[Kalshi Collector] stopped");
}

/**
 * Get the latest snapshot (used by kalshi-suggest to avoid redundant API calls)
 */
function getLatest() {
  return latestSnapshot;
}

/**
 * Get latest markets from the snapshot
 */
function getLatestMarkets() {
  return latestSnapshot?.markets || [];
}

function getStatus() {
  const now = Date.now();
  const inBackoff = backoffUntil != null && now < backoffUntil;
  return {
    running: isRunning,
    mode: adaptiveEnabled ? "adaptive" : "fixed",
    backoff: inBackoff,
    resumeAt: inBackoff ? new Date(backoffUntil).toISOString() : null,
    latestSnapshotAt: latestSnapshot?.generatedAt || null,
    currentIntervalMs,
    nextPollAt: nextPollAt ? new Date(nextPollAt).toISOString() : null,
    lastReason,
    scheduler: scheduler ? scheduler.stats() : null,
  };
}

module.exports = {
  start,
  stop,
  getLatest,
  getLatestMarkets,
  getStatus,
  collectSnapshot, // for manual testing
};
