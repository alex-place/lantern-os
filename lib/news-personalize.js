/**
 * news-personalize.js — per-user relevance ranking for finance news.
 *
 * The Convergence loop applied to news: OBSERVE the user (watchlist, interests,
 * past engagement) → REASON a relevance score → ACT (serve most-relevant first)
 * → the existing /api/explore/interaction feedback closes VERIFY/CONVERGE.
 *
 * Σ₀ / External-Reality Rule: relevance is NOT a black box. It's a transparent
 * weighted sum of named signals, and every ranked item carries a `why` listing
 * the signals that lifted it — claim (relevance) + evidence (signal breakdown).
 *
 * Pure functions only (no I/O); the caller assembles `ctx` from user-profiles.js,
 * the watchlist, and the per-user leaderboard, so this stays unit-testable.
 */

"use strict";

// Default signal weights. Tunable per-user via profile.preferences.news.weights.
// They need not sum to 1 — scoreOne normalizes by the active weight total so a
// user who zeroes a signal doesn't deflate every score.
const DEFAULT_WEIGHTS = Object.freeze({
  ticker: 0.40, // news about stocks the user actually follows
  impact: 0.20, // how market-moving the headline is
  recency: 0.20, // fresher news first
  engagement: 0.12, // the user's own click history on this source (per-user PCSF)
  interest: 0.08, // keyword overlap with stated interests
});

const RECENCY_HALFLIFE_DAYS = 3; // a 3-day-old item scores ~0.5 on recency

function toTime(published) {
  if (!published) return null;
  if (typeof published === "number") return published > 1e12 ? published : published * 1000;
  const t = Date.parse(published);
  return Number.isNaN(t) ? null : t;
}

// Exponential time-decay in [0,1]. Unknown date → neutral 0.5 (don't punish).
function recencyScore(published, nowMs) {
  const t = toTime(published);
  if (t == null) return 0.5;
  const ageDays = Math.max(0, (nowMs - t) / 86400000);
  return Math.pow(0.5, ageDays / RECENCY_HALFLIFE_DAYS);
}

// Fraction of the item's symbols the user follows, with a small bump for ANY hit
// so a single relevant ticker still clearly beats none. Returns [0,1].
function tickerScore(symbols, followed) {
  if (!followed || followed.size === 0) return 0;
  const syms = Array.isArray(symbols) ? symbols : [];
  if (syms.length === 0) return 0;
  let hits = 0;
  for (const s of syms) if (followed.has(String(s).toUpperCase())) hits++;
  if (hits === 0) return 0;
  const frac = hits / syms.length;
  return Math.min(1, 0.5 + 0.5 * frac); // any hit ≥0.5; all-hit = 1.0
}

// Keyword overlap of the headline with the user's interests. Returns [0,1].
function interestScore(headline, interests) {
  if (!interests || interests.length === 0) return 0;
  const h = String(headline || "").toLowerCase();
  let hits = 0;
  for (const kw of interests) {
    const k = String(kw || "").toLowerCase().trim();
    if (k && h.includes(k)) hits++;
  }
  if (hits === 0) return 0;
  return Math.min(1, 0.4 + 0.3 * hits);
}

/**
 * Score one record for the user. Returns { relevance:[0,1], signals:{...}, why:[] }.
 * `signals` are the raw per-signal values; `why` is the human evidence string list
 * naming the signals that contributed most.
 */
function scoreOne(rec, ctx, nowMs) {
  const w = ctx.weights || DEFAULT_WEIGHTS;
  const followed = ctx.followed || new Set();
  const sourceScore = typeof ctx.sourceScore === "function" ? ctx.sourceScore : () => 0.5;

  const signals = {
    ticker: tickerScore(rec.symbols, followed),
    impact: Math.max(0, Math.min(1, (Number(rec.impact) || 0) / 100)),
    recency: recencyScore(rec.published || rec.date, nowMs),
    engagement: Math.max(0, Math.min(1, sourceScore(rec.source))),
    interest: interestScore(rec.headline || rec.title, ctx.interests),
  };

  let num = 0, den = 0;
  for (const k of Object.keys(DEFAULT_WEIGHTS)) {
    const weight = Number(w[k]) || 0;
    num += weight * signals[k];
    den += weight;
  }
  const relevance = den > 0 ? num / den : 0;

  // Evidence: name the signals that actually pulled weight, strongest first.
  const why = Object.keys(signals)
    .map((k) => ({ k, contrib: (Number(w[k]) || 0) * signals[k] }))
    .filter((x) => x.contrib > 0.01)
    .sort((a, b) => b.contrib - a.contrib)
    .slice(0, 3)
    .map((x) => {
      if (x.k === "ticker") {
        const hits = (rec.symbols || []).filter((s) => followed.has(String(s).toUpperCase()));
        return hits.length ? "follows " + hits.slice(0, 3).join(", ") : "watched ticker";
      }
      if (x.k === "impact") return "impact " + (rec.impact || 0);
      if (x.k === "recency") return "fresh";
      if (x.k === "engagement") return "you read " + (rec.source || "this source");
      if (x.k === "interest") return "matches your interests";
      return x.k;
    });

  return { relevance, signals, why };
}

/**
 * Rank records for a user, newest-relevant first. Non-destructive — returns new
 * objects with `relevance` and `relevanceWhy` attached. `ctx`:
 *   { followed:Set<UPPER ticker>, interests:string[], weights?:{}, sourceScore?:fn, nowMs?:number }
 */
function rankNewsForUser(records, ctx = {}) {
  const nowMs = Number.isFinite(ctx.nowMs) ? ctx.nowMs : Date.now();
  const list = (Array.isArray(records) ? records : []).map((rec) => {
    const { relevance, signals, why } = scoreOne(rec, ctx, nowMs);
    return { ...rec, relevance, relevanceSignals: signals, relevanceWhy: why };
  });
  // Stable sort by relevance desc; ties keep input order (already newest-first).
  return list
    .map((r, i) => [r, i])
    .sort((a, b) => b[0].relevance - a[0].relevance || a[1] - b[1])
    .map(([r]) => r);
}

// ── Context assembly (Observe) ───────────────────────────────────────────────
// The one place that does I/O: pull the user's followed tickers (profile prefs,
// else the shared desk watchlist so a fresh user still gets relevance), stated
// interests, weight overrides, and their OWN explore-engagement leaderboard.
// Kept separate from the pure scorer above so scoring stays unit-testable.
const fs = require("fs");
const path = require("path");

function loadWatchlistTickers() {
  try {
    const p = path.resolve(__dirname, "..", "data", "lantern-garage", "trading", "watchlist.json");
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(parsed.tickers) ? parsed.tickers : [];
  } catch {
    return [];
  }
}

function buildUserNewsContext(userId) {
  let weightOverrides = {};
  let profileTickers = [];
  let interests = [];
  try {
    if (userId) {
      const { getProfile } = require("./user-profiles");
      const profile = getProfile(userId);
      const news = (profile && profile.preferences && profile.preferences.news) || {};
      weightOverrides = news.weights && typeof news.weights === "object" ? news.weights : {};
      if (Array.isArray(news.tickers)) profileTickers = news.tickers;
      if (Array.isArray(news.interests)) interests = news.interests;
    }
  } catch { /* no profile → fall back to desk defaults below */ }

  const followedArr = profileTickers.length ? profileTickers : loadWatchlistTickers();
  const followed = new Set(followedArr.map((t) => String(t).toUpperCase()));

  // Per-user engagement: read THIS user's own leaderboard scope in the
  // "explore-user" domain (written per-user by /api/explore/interaction). Unseen
  // sources get the 0.5 cold prior — identical to the model-router's cold start.
  // Guests (no userId) share the "global" scope, so they still benefit from the
  // crowd's engagement signal.
  let scope = {};
  try {
    const { getDomainScope } = require("./model-leaderboard");
    scope = getDomainScope("explore-user", userId || "global") || {};
  } catch { /* leaderboard unavailable → neutral engagement */ }
  const sourceScore = (source) => {
    const e = scope["source:" + String(source || "")];
    return e && Number.isFinite(e.score) ? e.score : 0.5;
  };

  return {
    userId: userId || null,
    followed,
    interests,
    weights: { ...DEFAULT_WEIGHTS, ...weightOverrides },
    sourceScore,
  };
}

module.exports = {
  rankNewsForUser,
  scoreOne,
  buildUserNewsContext,
  DEFAULT_WEIGHTS,
  // exported for tests
  _internals: { tickerScore, interestScore, recencyScore, loadWatchlistTickers },
};
