"use strict";
/**
 * Drift canaries as a passive observability product (#1428).
 *
 * The two passive canary axes already score every reply (lib/canary.js):
 *   - collapse (#1010)     — output diversity too LOW (repetition / degeneration)
 *   - groundedness (#1260) — fluent-but-unanchored, the "42-state"
 * They only append an event when an axis TRIPS, so the canary stream is a stream of
 * drift incidents. This generalizes that stream into a drop-in "is my agent quietly
 * drifting?" monitor: windowed trip rates per axis, a rising/stable/falling trend, an
 * alert level, top contributors, and a timeline — for this app or any chat app that
 * feeds it canary-shaped events.
 *
 * assessDrift() is pure (takes the events + `now`), so it's deterministic and testable.
 */
const fs = require("fs");
const path = require("path");

const DEFAULT_REPO_ROOT = path.resolve(__dirname, "../../..");
const HOUR_MS = 3_600_000;
const AXES = ["collapse", "grounded"];

function _ts(e) { return Date.parse(e && e.ts) || 0; }
function _inAxis(e, axis) { return Array.isArray(e.tripped) && e.tripped.includes(axis); }

function trend(recent, prior) {
  if (prior === 0) return recent > 0 ? "rising" : "flat";
  const r = recent / prior;
  if (r >= 1.5) return "rising";
  if (r <= 0.66) return "falling";
  return "stable";
}

// Top N values of `key` among events, with counts.
function topContributors(events, key, n = 4) {
  const counts = {};
  for (const e of events) { const v = e[key] || "unknown"; counts[v] = (counts[v] || 0) + 1; }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, count]) => ({ value, count }));
}

/**
 * @param {Array} events  canary events ({ ts, tripped:[...], provider, agent, surface, ... })
 * @param {object} opts   { nowMs, windowMs=24h, buckets=12 }
 */
function assessDrift(events, opts = {}) {
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const windowMs = opts.windowMs || 24 * HOUR_MS;
  const all = (events || []).filter((e) => e && _ts(e) > 0);
  const recentStart = nowMs - windowMs;
  const priorStart = nowMs - 2 * windowMs;
  const recent = all.filter((e) => _ts(e) >= recentStart && _ts(e) <= nowMs);
  const prior = all.filter((e) => _ts(e) >= priorStart && _ts(e) < recentStart);

  const axes = {};
  for (const axis of AXES) {
    const r = recent.filter((e) => _inAxis(e, axis)).length;
    const p = prior.filter((e) => _inAxis(e, axis)).length;
    axes[axis] = { recent: r, prior: p, trend: trend(r, p) };
  }

  // Alert level: any rising axis, or a high absolute recent volume, escalates.
  const recentTotal = recent.length;
  const anyRising = AXES.some((a) => axes[a].trend === "rising" && axes[a].recent > 0);
  let alert = "ok";
  if (recentTotal === 0) alert = "ok";
  else if (recentTotal >= 20 || anyRising) alert = recentTotal >= 40 ? "alert" : "warn";

  // Timeline: trips per bucket across the recent window, split by axis (for a sparkline).
  const nB = opts.buckets || 12;
  const bw = windowMs / nB;
  const timeline = Array.from({ length: nB }, (_, i) => {
    const lo = recentStart + i * bw, hi = lo + bw;
    const inB = recent.filter((e) => _ts(e) >= lo && _ts(e) < hi);
    return { collapse: inB.filter((e) => _inAxis(e, "collapse")).length, grounded: inB.filter((e) => _inAxis(e, "grounded")).length };
  });

  const summary = recentTotal === 0
    ? "No drift incidents in the window — both canary axes quiet."
    : `${recentTotal} drift incident${recentTotal === 1 ? "" : "s"} in the last ${Math.round(windowMs / HOUR_MS)}h `
      + `(collapse ${axes.collapse.recent} ${axes.collapse.trend}, 42-state ${axes.grounded.recent} ${axes.grounded.trend}).`;

  return {
    windowHours: Math.round(windowMs / HOUR_MS),
    recentTotal, priorTotal: prior.length,
    axes, alert, timeline,
    byProvider: topContributors(recent, "provider"),
    byAgent: topContributors(recent, "agent"),
    bySurface: topContributors(recent, "surface"),
    summary,
    status: all.length ? "ok" : "insufficient_data",
  };
}

function readCanaryEvents(root) {
  const f = path.join(root || DEFAULT_REPO_ROOT, "data", "convergence", "canary-events.jsonl");
  try {
    return fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

module.exports = { assessDrift, readCanaryEvents, trend, topContributors, AXES };
