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
 * Stores snapshots as JSONL in data/kalshi/tight-band-{YYYY-MM-DD}.jsonl using
 * the v2 keyframe+delta codec (lib/kalshi-snapshot-codec.js): a full markets
 * array every KALSHI_KEYFRAME_EVERY lines, then only the fields that changed.
 * Yesterday's file is gzipped on day rollover. Readers should decode via
 * iterateSnapshots() / kalshi_snapshot_codec.py rather than JSON.parse per
 * line; both handle v1, v2 and .gz transparently.
 *
 * Set KALSHI_SNAPSHOT_FORMAT=v1 to fall back to the legacy full-snapshot-per-
 * line writer (~200 KB/line, ~2.5 GB/day - what filled the GCE disk on
 * 2026-08-06 and broke every write on the box for five days).
 *
 * The swipe deck uses the latest snapshot for live trajectory analysis instead
 * of making a fresh API call each time.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const kalshi = require("./kalshi-api");
const { createScheduler, parseEnvConfig } = require("./kalshi-adaptive-poll");
const { SnapshotEncoder } = require("./kalshi-snapshot-codec");

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

const legacyFormat = String(process.env.KALSHI_SNAPSHOT_FORMAT || "v2") === "v1";
const encoder = new SnapshotEncoder();

/**
 * Gzip a rolled-over snapshot file. Best-effort: on any failure the plain
 * .jsonl is left untouched (retention matches both). Streamed, not read-whole,
 * so a large legacy file cannot spike RSS.
 */
let _gzipChain = Promise.resolve();
function gzipRolledFile(filePath) {
  // Serialise: a sweep can queue several multi-GB files and we do not want them
  // competing for the same disk.
  _gzipChain = _gzipChain.then(() => new Promise((resolve) => {
    try { _gzipOne(filePath, resolve); } catch { resolve(); }
  }));
  return _gzipChain;
}

function _gzipOne(filePath, done) {
  if (!filePath || filePath.endsWith(".gz")) return done();
  const gzPath = `${filePath}.gz`;
  const lockPath = `${gzPath}.lock`;
  try {
    if (!fs.existsSync(filePath) || fs.existsSync(gzPath)) return done();
  } catch { return done(); }

  // Cross-process lock. Multiple servers routinely share one data/ dir (dual
  // boot on 4177/4178, plus `node --watch` restarts); without this they race on
  // the same .tmp path and can unlink a source another process is reading.
  let lockFd;
  try {
    lockFd = fs.openSync(lockPath, "wx");
  } catch {
    return done(); // another process owns this file
  }
  const releaseLock = () => {
    try { fs.closeSync(lockFd); } catch { /* already closed */ }
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  };

  // Never delete a source still being appended to (today's file).
  if (path.basename(filePath) === path.basename(getSnapshotPath())) {
    releaseLock();
    return done();
  }

  const src = fs.createReadStream(filePath);
  const dst = fs.createWriteStream(`${gzPath}.tmp`);
  let settled = false;
  const fail = (e) => {
    if (settled) return;
    settled = true;
    console.warn(`[Kalshi Collector] gzip of ${path.basename(filePath)} failed:`, e?.message || e);
    try { fs.unlinkSync(`${gzPath}.tmp`); } catch { /* best-effort */ }
    // If a bad archive got renamed into place, drop it - the source is still
    // there, and a half-written .gz would be mistaken for a good one later.
    try { if (fs.existsSync(filePath)) fs.unlinkSync(gzPath); } catch { /* best-effort */ }
    releaseLock();
    done();
  };
  src.on("error", fail);
  dst.on("error", fail);
  dst.on("close", () => {
    if (settled) return;
    try {
      if (!fs.existsSync(`${gzPath}.tmp`)) return fail(new Error("temp file missing"));
      // Verify the archive round-trips to the source's exact byte count BEFORE
      // dropping the only other copy. gzip's trailer stores ISIZE (uncompressed
      // length mod 2^32) in the last 4 bytes - an O(1) check that catches the
      // truncation case that would otherwise destroy data silently.
      const srcBytes = fs.statSync(filePath).size;
      fs.renameSync(`${gzPath}.tmp`, gzPath);
      const gzBytes = fs.statSync(gzPath).size;
      if (gzBytes <= 0) throw new Error("empty archive");
      const tail = Buffer.alloc(4);
      const fd = fs.openSync(gzPath, "r");
      try { fs.readSync(fd, tail, 0, 4, gzBytes - 4); } finally { fs.closeSync(fd); }
      const isize = tail.readUInt32LE(0);
      if (isize !== srcBytes % 2 ** 32) {
        throw new Error(`archive size mismatch (gzip ISIZE ${isize} vs source ${srcBytes})`);
      }
      fs.unlinkSync(filePath);
      settled = true;
      releaseLock();
      console.info(`[Kalshi Collector] gzipped ${path.basename(filePath)} (${(gzBytes / 1e6).toFixed(1)} MB)`);
      done();
    } catch (e) { fail(e); }
  });
  src.pipe(zlib.createGzip({ level: 6 })).pipe(dst);
}

/**
 * Gzip every complete (not-today) snapshot file still sitting uncompressed.
 * Measured ~14.5x on the v1 corpus.
 *
 * OPT-IN (KALSHI_SNAPSHOT_GZIP_BACKLOG=1). Day-rollover gzip runs
 * unconditionally - one file at one well-defined moment - but a bulk sweep that
 * deletes source files at every process start is a different risk class:
 * `node --watch` restarts on each edit and the dual-boot topology puts two
 * servers on one data dir, so "on start" can mean dozens of times an hour.
 */
function gzipCompleteSnapshots() {
  if (String(process.env.KALSHI_SNAPSHOT_GZIP_BACKLOG || "0") !== "1") return;
  const todayFile = path.basename(getSnapshotPath());
  try {
    for (const f of fs.readdirSync(KALSHI_DIR)) {
      if (!/^tight-band-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
      if (f === todayFile) continue;
      gzipRolledFile(path.join(KALSHI_DIR, f));
    }
  } catch { /* dir missing / unreadable */ }
}

let _lastSnapshotPath = null;
function logSnapshot(snapshot) {
  try {
    fs.mkdirSync(KALSHI_DIR, { recursive: true });
    // Day rollover -> new file -> prune past retention, gzip yesterday, and
    // force a keyframe so each file is independently decodable from line 1.
    const p = getSnapshotPath();
    if (p !== _lastSnapshotPath) {
      const rolled = _lastSnapshotPath;
      _lastSnapshotPath = p;
      encoder.reset();
      pruneOldSnapshots();
      if (rolled) gzipRolledFile(rolled);
    }
    const ts = new Date().toISOString();
    const line = legacyFormat
      ? JSON.stringify({
          ts,
          markets: snapshot.markets?.length || 0,
          exitCount: snapshot.exitCount || 0,
          snapshot,
        })
      : encoder.encode(snapshot, ts);
    fs.appendFileSync(p, line + "\n");
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
 * Retention sweep: delete tight-band snapshot files older than
 * KALSHI_SNAPSHOT_RETAIN_DAYS (default 14; 0 disables the sweep). The 6s loop
 * writes ~2.5 GB/day of snapshots; left unrotated they filled the 30 GB GCE
 * disk to 100% on 2026-08-06, which broke every write on the box (sessions,
 * ledgers, deploys) for five days. Runs at start and on each day rollover.
 */
function pruneOldSnapshots() {
  const days = parseFloat(process.env.KALSHI_SNAPSHOT_RETAIN_DAYS ?? "14");
  if (!(days > 0)) return;
  try {
    const cutoff = Date.now() - days * 86400000;
    for (const f of fs.readdirSync(KALSHI_DIR)) {
      if (!/^tight-band-\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f)) continue;
      const full = path.join(KALSHI_DIR, f);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.unlinkSync(full);
          console.info(`[Kalshi Collector] pruned ${f} (older than ${days}d retention)`);
        }
      } catch { /* per-file best-effort */ }
    }
  } catch { /* dir missing / unreadable — nothing to prune */ }
}

/**
 * Start the polling loop. KALSHI_COLLECTOR=0 disables the collector outright
 * (no polling, no snapshot files) — the surgical off-switch for deployments
 * that don't want the telemetry; LANTERN_CHAT_ONLY=1 remains the broad one.
 */
function start() {
  if (String(process.env.KALSHI_COLLECTOR || "1") === "0") {
    console.info("[Kalshi Collector] disabled (KALSHI_COLLECTOR=0) — no polling, no snapshot files");
    return;
  }
  if (isRunning) return;
  isRunning = true;
  console.info(
    `[Kalshi Collector] starting ${adaptiveEnabled ? "adaptive send-on-delta" : "6s fixed"} polling loop`
  );
  pruneOldSnapshots();
  gzipCompleteSnapshots();
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
