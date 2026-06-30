"use strict";
/**
 * Learn-anything tutor that tracks retention (#1438).
 *
 * Not flashcards-as-a-list: a spaced-repetition tutor (SM-2) that remembers what you got
 * wrong, re-surfaces it sooner, and tracks whether your understanding is actually sticking.
 * Each concept is a convergence record of understanding — graded recall drives the next
 * review interval; a failed recall collapses the interval so the concept comes back fast.
 *
 * The scheduling math is pure (takes `now`), so it's deterministic + testable. JSONL
 * persistence is the thin I/O layer.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_REPO_ROOT = path.resolve(__dirname, "../../..");
const DAY_MS = 86_400_000;
const MATURE_DAYS = 21;          // an interval ≥ 21d means the concept is "mature" (well-retained)

function round2(x) { return Math.round(x * 100) / 100; }

// SM-2: grade q in 0..5 (0=blackout, 3=correct-but-hard, 5=perfect). A fail (<3) resets
// the repetition streak and drops the interval to 1 day; a pass grows it by the ease
// factor. Ease drifts up for easy recalls, down (floored at 1.3) for hard ones.
function reviewCard(card, grade, nowMs) {
  const q = Math.max(0, Math.min(5, Math.round(Number(grade))));
  let easeFactor = Number(card.easeFactor) > 0 ? Number(card.easeFactor) : 2.5;
  let interval = Number(card.interval) || 0;
  let repetitions = Number(card.repetitions) || 0;
  let lapses = Number(card.lapses) || 0;

  if (q < 3) {
    repetitions = 0; interval = 1; lapses += 1;
  } else {
    if (repetitions === 0) interval = 1;
    else if (repetitions === 1) interval = 6;
    else interval = Math.round(interval * easeFactor);
    repetitions += 1;
  }
  easeFactor = Math.max(1.3, easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  const nowIso = new Date(nowMs).toISOString();
  return {
    ...card,
    easeFactor: round2(easeFactor), interval, repetitions, lapses,
    lastReviewedAt: nowIso,
    nextReview: new Date(nowMs + interval * DAY_MS).toISOString(),
    history: [...(Array.isArray(card.history) ? card.history : []), { ts: nowIso, grade: q }].slice(-50),
  };
}

function isDue(card, nowMs) {
  if (!card.nextReview) return true;            // never reviewed → due now
  return Date.parse(card.nextReview) <= nowMs;
}

function isStruggling(card) {
  return (Number(card.lapses) || 0) >= 2 || (Number(card.easeFactor) || 2.5) < 2.0;
}

// Cards to study now: due ones, most-overdue first, and struggling concepts ahead of
// comfortable ones at the same overdue-ness.
function dueCards(cards, nowMs) {
  return (cards || [])
    .filter((c) => isDue(c, nowMs))
    .map((c) => ({ card: c, overdue: c.nextReview ? nowMs - Date.parse(c.nextReview) : Infinity }))
    .sort((a, b) => (b.overdue - a.overdue) || (Number(a.card.easeFactor || 2.5) - Number(b.card.easeFactor || 2.5)))
    .map((x) => x.card);
}

// Retention overview: how much is mature, what you're struggling with, and recent recall
// accuracy. Honest insufficient_data until there are graded reviews.
function retentionStats(cards, nowMs) {
  const all = cards || [];
  const reviewed = all.filter((c) => Array.isArray(c.history) && c.history.length);
  const grades = all.flatMap((c) => (c.history || []).map((h) => h.grade));
  const recent = grades.slice(-30);
  const mature = all.filter((c) => (Number(c.interval) || 0) >= MATURE_DAYS).length;
  const struggling = all.filter(isStruggling);
  const due = dueCards(all, nowMs).length;
  return {
    total: all.length,
    due,
    mature,
    young: all.length - mature,
    strugglingCount: struggling.length,
    struggling: struggling.slice(0, 8).map((c) => ({ id: c.id, front: c.front, lapses: c.lapses || 0, ease: c.easeFactor || 2.5 })),
    recentAccuracy: recent.length ? recent.filter((g) => g >= 3).length / recent.length : null,
    avgEase: reviewed.length ? round2(reviewed.reduce((a, c) => a + (Number(c.easeFactor) || 2.5), 0) / reviewed.length) : null,
    reviews: grades.length,
    status: grades.length ? "ok" : "insufficient_data",
  };
}

// ── thin JSONL persistence ──────────────────────────────────────────────────────
function _file(root) { return path.join(root || DEFAULT_REPO_ROOT, "data", "learn", "cards.jsonl"); }
function readCards(root) {
  try {
    return fs.readFileSync(_file(root), "utf8").split("\n").filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function _writeAll(root, cards) {
  const f = _file(root); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, cards.map((c) => JSON.stringify(c)).join("\n") + (cards.length ? "\n" : ""));
}
function createCard(root, input, nowIso) {
  const front = String(input.front || "").trim();
  const back = String(input.back || "").trim();
  if (!front || !back) throw new Error("front and back are required");
  const card = {
    id: `card:${crypto.randomUUID()}`,
    front: front.slice(0, 500), back: back.slice(0, 4000),
    source: String(input.source || "").slice(0, 300),
    topic: String(input.topic || "general").slice(0, 80),
    createdAt: nowIso, easeFactor: 2.5, interval: 0, repetitions: 0, lapses: 0,
    nextReview: nowIso, lastReviewedAt: null, history: [],
  };
  const all = readCards(root); all.push(card); _writeAll(root, all);
  return card;
}
function gradeCard(root, id, grade, nowMs) {
  const all = readCards(root);
  const idx = all.findIndex((c) => c.id === id);
  if (idx < 0) return null;
  all[idx] = reviewCard(all[idx], grade, nowMs);
  _writeAll(root, all);
  return all[idx];
}

module.exports = {
  MATURE_DAYS, reviewCard, isDue, isStruggling, dueCards, retentionStats,
  readCards, createCard, gradeCard,
};
