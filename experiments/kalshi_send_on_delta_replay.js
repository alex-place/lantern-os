/**
 * Replay the recorded Kalshi tight-band snapshots through the send-on-delta
 * scheduler (lib/kalshi-adaptive-poll.js) and measure what adaptive polling
 * would have cost in staleness vs what it saves in requests/disk.
 *
 * Ground truth = the recorded ~6s ticks (data/kalshi/tight-band-*.jsonl).
 * Policies simulated in ONE streaming pass over the same ticks:
 *   - adaptive @ sigmaRef in a calibration grid (scheduler instances from the lib)
 *   - fixed every k-th tick, k in {2,3,5,10} (12s/18s/30s/60s at nominal cadence)
 *   - baseline = poll every tick (what actually happened; staleness 0 by definition)
 * Staleness at each tick t, per market: (true mid − last-polled mid)², reported
 * overall and on MOVING ticks only (markets whose mid changed since the previous
 * tick — the ones the tight-band engine acts on). Contiguous segments split on
 * recording gaps > 60s; all policies re-sync at segment starts so data holes
 * neither punish nor credit anyone.
 *
 * Run: node experiments/kalshi_send_on_delta_replay.js [file.jsonl] [--max-lines N]
 * Writes experiments/results/kalshi_send_on_delta_replay.json
 */

"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { createScheduler, midCents } = require("../apps/lantern-garage/lib/kalshi-adaptive-poll");

const KALSHI_DIR = path.resolve(__dirname, "..", "data", "kalshi");
const OUT_PATH = path.resolve(__dirname, "results", "kalshi_send_on_delta_replay.json");
const SEGMENT_GAP_MS = 60_000;
const SIGMA_REF_GRID = [0.01, 0.02, 0.04, 0.08];
const FIXED_KS = [2, 3, 5, 10];

function pickDefaultFile() {
  const today = new Date().toISOString().split("T")[0];
  const files = fs.readdirSync(KALSHI_DIR)
    .filter((f) => /^tight-band-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && !f.includes(today))
    .sort();
  if (!files.length) throw new Error(`no complete tight-band-*.jsonl in ${KALSHI_DIR}`);
  return path.join(KALSHI_DIR, files[files.length - 1]);
}

class Policy {
  constructor(name) {
    this.name = name;
    this.lastMid = new Map(); // ticker -> mid at our last poll
    this.polls = 0;
    this.sse = 0; this.n = 0;               // all ticks
    this.sseMoving = 0; this.nMoving = 0;   // ticks where the true mid moved
    this.maxErr = 0;
  }
  resetSegment() { this.lastMid.clear(); }
  accountThenMaybePoll(ticks, moved, doPoll) {
    for (const [ticker, mid] of ticks) {
      const seen = this.lastMid.get(ticker);
      if (seen != null) {
        const e2 = (mid - seen) * (mid - seen);
        this.sse += e2; this.n++;
        if (e2 > this.maxErr) this.maxErr = e2;
        if (moved.has(ticker)) { this.sseMoving += e2; this.nMoving++; }
      }
    }
    if (doPoll) {
      this.polls++;
      for (const [ticker, mid] of ticks) this.lastMid.set(ticker, mid);
    }
  }
  summary(totalTicks, avgLineBytes, durationMs) {
    return {
      policy: this.name,
      polls: this.polls,
      pollShare: +(this.polls / totalTicks).toFixed(4),
      avgIntervalSec: +((durationMs / 1000) / Math.max(1, this.polls)).toFixed(1),
      rmseCents: +Math.sqrt(this.sse / Math.max(1, this.n)).toFixed(3),
      rmseMovingCents: +Math.sqrt(this.sseMoving / Math.max(1, this.nMoving)).toFixed(3),
      maxErrCents: +Math.sqrt(this.maxErr).toFixed(1),
      estDiskMB: +((this.polls * avgLineBytes) / 1e6).toFixed(1),
    };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const maxIdx = args.indexOf("--max-lines");
  const maxLines = maxIdx >= 0 ? parseInt(args[maxIdx + 1], 10) : Infinity;
  const file = args.find((a) => a.endsWith(".jsonl")) || pickDefaultFile();
  const fileBytes = fs.statSync(file).size;
  console.log(`replaying ${file} (${(fileBytes / 1e6).toFixed(0)} MB)`);

  // Policies: baseline + fixed grid + adaptive grid (scheduler from the real lib).
  const baseline = new Policy("baseline-every-tick");
  const fixed = FIXED_KS.map((k) => ({ k, p: new Policy(`fixed-every-${k}-ticks`) }));
  const adaptive = SIGMA_REF_GRID.map((ref) => ({
    ref,
    p: new Policy(`adaptive-sigmaRef-${ref}`),
    sched: createScheduler({ sigmaRefCents2PerSec: ref }),
    nextPollAt: 0,
    reasons: Object.create(null),
  }));

  const prevMid = new Map(); // ticker -> mid at previous tick (for "moving" flag)
  let tickIdx = 0, lineCount = 0, byteCount = 0;
  let firstTs = null, lastTs = null, prevTs = null, segments = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (++lineCount > maxLines) break;
    byteCount += line.length + 1;
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const tsMs = Date.parse(rec.ts);
    const markets = rec.snapshot && Array.isArray(rec.snapshot.markets) ? rec.snapshot.markets : null;
    if (!Number.isFinite(tsMs) || !markets || !markets.length) continue;

    const ticks = [];
    for (const m of markets) {
      const mid = midCents(m);
      if (m && m.ticker && mid != null) ticks.push([m.ticker, mid]);
    }
    if (!ticks.length) continue;

    if (firstTs == null) firstTs = tsMs;
    const gap = prevTs != null ? tsMs - prevTs : 0;
    if (prevTs == null || gap > SEGMENT_GAP_MS) {
      segments++;
      prevMid.clear();
      baseline.resetSegment();
      for (const f of fixed) f.p.resetSegment();
      for (const a of adaptive) { a.p.resetSegment(); a.nextPollAt = tsMs; }
    }

    const moved = new Set();
    for (const [ticker, mid] of ticks) {
      const pm = prevMid.get(ticker);
      if (pm != null && pm !== mid) moved.add(ticker);
      prevMid.set(ticker, mid);
    }

    baseline.accountThenMaybePoll(ticks, moved, true);
    for (const f of fixed) f.p.accountThenMaybePoll(ticks, moved, tickIdx % f.k === 0);
    for (const a of adaptive) {
      // Half-tick tolerance so a floor-cadence (6s) schedule doesn't randomly
      // skip recorded ticks spaced 6s±jitter — an interval at the floor must
      // read as "poll every tick" (adaptive == baseline on a busy slate),
      // not a phantom 35% saving from aliasing.
      const doPoll = tsMs >= a.nextPollAt - 3000;
      a.p.accountThenMaybePoll(ticks, moved, doPoll);
      if (doPoll) {
        const res = a.sched.observe(markets, tsMs);
        a.nextPollAt = tsMs + res.intervalMs;
        a.reasons[res.reason] = (a.reasons[res.reason] || 0) + 1;
      }
    }

    prevTs = tsMs; lastTs = tsMs; tickIdx++;
  }
  rl.close();

  const durationMs = lastTs - firstTs;
  const avgLineBytes = byteCount / Math.max(1, tickIdx);
  const rows = [
    baseline.summary(tickIdx, avgLineBytes, durationMs),
    ...fixed.map((f) => f.p.summary(tickIdx, avgLineBytes, durationMs)),
    ...adaptive.map((a) => ({ ...a.p.summary(tickIdx, avgLineBytes, durationMs), reasons: a.reasons })),
  ];

  const result = {
    file: path.basename(file),
    ticks: tickIdx,
    segments,
    durationHours: +(durationMs / 3.6e6).toFixed(2),
    marketsSeen: prevMid.size,
    note: "RMSE in cents vs recorded truth at every tick; moving = ticks where the true mid changed. baseline staleness is 0 by construction (it IS the recording).",
    policies: rows,
    generatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));

  console.log(`\nticks=${tickIdx} segments=${segments} duration=${result.durationHours}h markets=${result.marketsSeen}`);
  console.log(
    "policy".padEnd(26), "polls".padStart(7), "share".padStart(7), "avg-int".padStart(8),
    "rmse".padStart(7), "rmse-mov".padStart(9), "disk-MB".padStart(8)
  );
  for (const r of rows) {
    console.log(
      r.policy.padEnd(26), String(r.polls).padStart(7), String(r.pollShare).padStart(7),
      `${r.avgIntervalSec}s`.padStart(8), String(r.rmseCents).padStart(7),
      String(r.rmseMovingCents).padStart(9), String(r.estDiskMB).padStart(8)
    );
  }
  console.log(`\nwrote ${OUT_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
