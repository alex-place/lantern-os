"use strict";

/**
 * lib/active-user-metric.js — the composite "active user" instrument (#2547).
 *
 * Product plan v5 §05.6 ("Count only what's real") defines ACTIVE as a composite:
 *   set up a watchlist  AND  had ten real chats  AND  made one practice trade.
 * §02's Level-1 clear-condition is judged against it: 50 active · 15 paying ·
 * 40% month-1 retention. Level 1 cannot be "cleared" without this instrument.
 *
 * Σ₀ rules this module lives by:
 *   - MEASURED only: every count is machine-checked from an in-repo artifact
 *     (per-user watchlist files, per-user conversation logs, broker-accepted
 *     paper_trade traction events, the profiles store, daily_active events).
 *     OPERATOR_REPORTED events are never counted — the acceptance criterion.
 *   - Per-user evidence: each counted user carries the artifact paths/counts
 *     that made them count, so every headline number is auditable.
 *   - Operator excluded: lib/traction.js classifyActor() gates every count, so
 *     dogfooding can't inflate adoption.
 *   - Honest zeros: thin stores produce 0s and null rates, never invented data.
 *
 * LOOP STAGE: Converge (grounds the Level-1 gate in measured evidence).
 */

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");

const DEFAULTS = {
  watchlistsDir: path.join(repoRoot, "data", "lantern-garage", "trading", "watchlists"),
  conversationsUsersRoot: path.join(repoRoot, "data", "conversations", "users"),
  tractionFile: path.join(repoRoot, "data", "traction", "events.jsonl"),
  // Level-1 clear-condition (product plan v5 §02).
  targets: { active: 50, paying: 15, m1Retention: 0.4 },
  chatThreshold: 10,
  tradeThreshold: 1,
};

// Paying tiers: role level ≥ 2 is the $20 Pro tier (deep_dreamer; founder is its
// legacy alias). `supporter` is the retired $5 tier shown as Free (#2470) — NOT
// paying. Staff roles are operator-side and never count.
const PAYING_ROLES = new Set(["deep_dreamer", "founder"]);

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/)
      .filter((l) => l && !l.trimStart().startsWith("#"))
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function listDirSafe(dir, opts = {}) {
  try { return fs.readdirSync(dir, opts); } catch { return []; }
}

/** Per-user watchlist evidence: the store writes data/…/watchlists/<uid>.json the
 *  moment a user personalizes their list — existence IS the setup artifact. */
function watchlistUsers(dir) {
  const out = new Map();
  for (const f of listDirSafe(dir)) {
    if (!f.endsWith(".json")) continue;
    const uid = decodeURIComponent(f.slice(0, -5));
    if (uid === "default") continue; // the shared/server list is nobody's setup
    out.set(uid, path.relative(repoRoot, path.join(dir, f)));
  }
  return out;
}

/** Count real chat turns (role "operator" = the human's own messages) per user. */
function chatCounts(usersRoot) {
  const out = new Map();
  for (const ent of listDirSafe(usersRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const file = path.join(usersRoot, ent.name, "conversations.jsonl");
    let n = 0;
    for (const rec of readJsonl(file)) if (rec && rec.role === "operator") n++;
    if (n > 0) out.set(ent.name, { count: n, file: path.relative(repoRoot, file) });
  }
  return out;
}

/** Broker-accepted paper trades per actor, from MEASURED traction events only. */
function paperTradeCounts(events) {
  const out = new Map();
  for (const e of events) {
    if (e.kind !== "paper_trade" || e.verified !== true) continue;
    const cur = out.get(e.actor) || { count: 0, lastTs: null };
    cur.count++; cur.lastTs = e.ts || cur.lastTs;
    out.set(e.actor, cur);
  }
  return out;
}

/**
 * The composite evaluator. Returns every known non-operator user with their
 * three signals + per-user evidence; `active` = all three thresholds met.
 */
function evaluateActiveUsers(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { classifyActor } = require("./traction");
  const events = readJsonl(o.tractionFile);
  const wl = watchlistUsers(o.watchlistsDir);
  const chats = chatCounts(o.conversationsUsersRoot);
  const trades = paperTradeCounts(events);

  const userIds = new Set([...wl.keys(), ...chats.keys(), ...trades.keys()]);
  const users = [];
  for (const uid of userIds) {
    if (classifyActor(uid) !== "external") continue; // operator/unknown never count
    const c = chats.get(uid) || { count: 0, file: null };
    const t = trades.get(uid) || { count: 0, lastTs: null };
    const hasWl = wl.has(uid);
    users.push({
      userId: uid,
      watchlistSetup: hasWl,
      chatCount: c.count,
      paperTrades: t.count,
      active: hasWl && c.count >= o.chatThreshold && t.count >= o.tradeThreshold,
      evidence: {
        watchlist: wl.get(uid) || null,
        conversations: c.file,
        paperTradeEvents: t.count ? `${o.tractionFile.includes("data") ? "data/traction/events.jsonl" : o.tractionFile} kind=paper_trade actor=${uid}` : null,
      },
    });
  }
  users.sort((a, b) => Number(b.active) - Number(a.active) || b.chatCount - a.chatCount);
  return { users, actives: users.filter((u) => u.active) };
}

/** Paying users, MEASURED from the profiles store's role field. */
function payingUsers(opts = {}) {
  const { classifyActor } = require("./traction");
  let profiles = [];
  try {
    profiles = (opts.listProfiles ? opts.listProfiles() : require("./user-profiles").listProfiles()) || [];
  } catch { profiles = []; }
  return profiles
    .filter((p) => p && PAYING_ROLES.has(String(p.role || "").toLowerCase()))
    // Operator exclusion: the id must be external; the email check only applies when
    // an email EXISTS — classifyActor("") is "unknown", so requiring external-email
    // silently dropped paying users with no email on file (LlamaPReview P2 on #2660).
    .filter((p) => classifyActor(p.id) === "external" && (!p.email || classifyActor(p.email) === "external"))
    .map((p) => ({ userId: p.id, role: p.role, evidence: "data/profiles/index.jsonl role=" + p.role }));
}

/**
 * Month-1 retention over MEASURED daily_active events: cohort = external actors
 * whose FIRST active day is ≥ 28 days old; retained = any activity on days 28–35
 * after that first day. rate is null (not 0) when the cohort is empty — an
 * unmeasurable rate is not a zero rate.
 */
function m1Retention(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { classifyActor } = require("./traction");
  const now = opts.now ? new Date(opts.now) : new Date();
  const first = new Map();
  const days = new Map(); // actor → Set of epoch-days
  for (const e of readJsonl(o.tractionFile)) {
    if (e.kind !== "daily_active" || e.verified !== true) continue;
    if (classifyActor(e.actor) !== "external") continue;
    const d = Math.floor(new Date(e.ts).getTime() / 86400000);
    if (!Number.isFinite(d)) continue;
    if (!first.has(e.actor) || d < first.get(e.actor)) first.set(e.actor, d);
    if (!days.has(e.actor)) days.set(e.actor, new Set());
    days.get(e.actor).add(d);
  }
  const today = Math.floor(now.getTime() / 86400000);
  const cohort = [];
  let retained = 0;
  for (const [actor, f] of first) {
    if (today - f < 28) continue; // too young to judge M1
    const win = [...days.get(actor)].some((d) => d - f >= 28 && d - f <= 35);
    cohort.push({ userId: actor, firstDay: f, retained: win });
    if (win) retained++;
  }
  return { cohortSize: cohort.length, retained, rate: cohort.length ? retained / cohort.length : null, cohort };
}

/** ISO week key (e.g. 2026-W29) — rollup idempotency unit. */
function isoWeek(d = new Date()) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const y = date.getUTCFullYear();
  const week = Math.ceil(((date - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(week).padStart(2, "0")}`;
}

/** The full Level-1 snapshot (pure read — no side effects). */
function level1Snapshot(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { users, actives } = evaluateActiveUsers(o);
  const paying = payingUsers();
  const retention = m1Retention(o);
  // Level-2 gate rides along (#2551): the Sean Ellis fit-check vs the 40% bar.
  let pmf = null;
  try { pmf = require("./pmf-survey").tally({ tractionFile: o.tractionFile }); } catch { pmf = null; }
  let referrals = null;
  try { const c = require("./referrals").conversions(o); referrals = { signups: c.totalSignups, converted: c.totalConverted }; } catch { referrals = null; }
  return {
    generatedAt: new Date().toISOString(),
    provenance: "MEASURED", // every number below is machine-checked; see per-user evidence
    targets: o.targets,
    actives: { count: actives.length, target: o.targets.active, users: actives },
    paying: { count: paying.length, target: o.targets.paying, users: paying },
    m1Retention: { ...retention, target: o.targets.m1Retention, cohort: retention.cohort.slice(0, 50) },
    pmf,
    referrals,
    knownUsers: users.length,
    definition: `active = watchlist setup AND >=${o.chatThreshold} chats AND >=${o.tradeThreshold} paper trade (composite, product plan v5 §05.6)`,
  };
}

/**
 * Weekly rollup — appends ONE weekly_rollup event per ISO week to the traction
 * ledger (provenance MEASURED, verified:true). Re-runs in the same week no-op.
 */
async function runWeeklyRollup(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const week = isoWeek(opts.now ? new Date(opts.now) : new Date());
  const existing = readJsonl(o.tractionFile).some(
    (e) => e.kind === "weekly_rollup" && e.evidence && String(e.evidence.week) === week
  );
  if (existing) return { skipped: true, week };
  const snap = level1Snapshot(o);
  const { recordTractionEvent } = require("./traction");
  const rec = await recordTractionEvent({
    kind: "weekly_rollup",
    actor: "active-user-metric",
    actorType: "external", // machine snapshot about external adoption; excluded from usage counts by kind
    verified: true,
    confidence: "high",
    source: "lib/active-user-metric.js runWeeklyRollup",
    evidence: {
      week,
      actives: snap.actives.count,
      paying: snap.paying.count,
      m1Retention: snap.m1Retention.rate,
      m1Cohort: snap.m1Retention.cohortSize,
      pmf: snap.pmf ? { n: snap.pmf.n, pctVeryDisappointed: snap.pmf.pctVeryDisappointed, pass: snap.pmf.pass } : null, // #2551 weekly review vs the 40% bar
      referrals: snap.referrals, // #2554 signups + conversions for the weekly review
      knownUsers: snap.knownUsers,
      targets: snap.targets,
    },
  }, { file: o.tractionFile });
  return { skipped: false, week, event: rec };
}

/** Boot + daily scheduler: run the rollup when the current ISO week lacks one. */
function startWeeklyRollupScheduler(opts = {}) {
  const tick = () => runWeeklyRollup(opts).then(
    (r) => { if (!r.skipped) console.info(`[traction] weekly Level-1 rollup appended (${r.week})`); },
    (e) => console.warn(`[traction] weekly rollup failed: ${e.message}`)
  );
  tick(); // catch up on boot if this week's rollup is missing
  const t = setInterval(tick, 24 * 60 * 60 * 1000);
  if (t.unref) t.unref(); // never keep the process alive for this
  return t;
}

module.exports = {
  evaluateActiveUsers,
  payingUsers,
  m1Retention,
  level1Snapshot,
  runWeeklyRollup,
  startWeeklyRollupScheduler,
  isoWeek,
  DEFAULTS,
};
