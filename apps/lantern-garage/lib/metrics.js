/**
 * metrics.js — product-adoption instrumentation for the traction admin surface.
 *
 * WHY this shape (validated against 2026 OSS product-analytics best practice):
 *   - "Invest in the analytics discipline first, then pick the tool." We adopt the OSS
 *     event MODEL (PostHog/Umami-style { event, actor, ts, props }) and the AARRR stage
 *     definitions — NOT a 4-service ClickHouse/Kafka cluster this 12GB box can't hold and
 *     the surface-boundary gate would (rightly) reject as sprawl.
 *   - Events are just the loop's Observe stage pointed at our own usage, so they live where
 *     every other memory does: one append-only JSONL log (North Star object #1, "Memory").
 *   - Local-first / cookieless by construction: we log server-side identity + coarse events,
 *     never a tracking cookie, so there is no consent-banner surface to bolt on.
 *
 * Refs: https://posthog.com/product-engineers/aarrr-pirate-funnel (stage definitions),
 *       https://openpanel.dev/articles/self-hosted-product-analytics (model over infra),
 *       https://fatgraphs.com/blogs/aarrr-framework/ (validate activation→retention).
 *
 * The event vocabulary is deliberately tiny and stable (consistent naming is the #1 schema
 * rule). Add an event by adding a constant here, not by inventing ad-hoc strings at callsites.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { appendJsonlQueued } = require("./file-queue");
const { listProfiles } = require("./user-profiles");

const DATA_ROOT = path.join(__dirname, "..", "..", "..", "data");
const EVENTS_PATH = path.join(DATA_ROOT, "metrics", "events.jsonl");

// ── Event vocabulary (consistent naming — the schema's load-bearing rule) ────────────
const EVENTS = {
  AUTH_VIEW: "auth_view",   // hit the signup/login surface — intent-to-use (activation, per spec)
  SIGNUP: "signup",         // profile created — Acquisition
  LOGIN: "login",           // returning session — Retention signal
  CHAT: "chat",             // sent a chat message — activation + core-loop usage
  EMAIL_VERIFIED: "email_verified",
};

// Paid roles/tiers count as Revenue regardless of which ladder granted them.
const PAID_ROLES = new Set(["supporter", "deep_dreamer", "founder", "patron"]);

// Accounts we must NOT count as real adoption. QE/browser-test fixtures inflate the funnel;
// honesty (Σ₀) means separating them, not hiding them.
function isTestActor(profile) {
  const email = String(profile.email || "").toLowerCase();
  const name = String(profile.name || "").toLowerCase();
  return (
    email.includes("example.com") ||
    email.includes("browsertest") ||
    email.includes("+test") ||
    name === "bt" ||
    name.startsWith("browsertest")
  );
}

/**
 * Record a product event. Fire-and-forget: instrumentation must NEVER break a hot path,
 * so every failure is swallowed. actorId is a stable session/profile id (or "anon").
 */
function track(event, { actorId = "anon", actorType = "user", props = {} } = {}) {
  try {
    const record = { event, actor: String(actorId), actorType, ts: new Date().toISOString(), props };
    // best-effort async append; do not await in callers
    Promise.resolve(appendJsonlQueued(EVENTS_PATH, record)).catch(() => {});
    return record;
  } catch {
    return null;
  }
}

/** Read the full event log (small append-only file; full fold is fine at this scale). */
function readEvents() {
  try {
    if (!fs.existsSync(EVENTS_PATH)) return [];
    return fs
      .readFileSync(EVENTS_PATH, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

const DAY = 24 * 60 * 60 * 1000;

function daysAgo(iso, now) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return (now - t) / DAY;
}

/**
 * Fold profiles + events into an AARRR snapshot. Real accounts and test fixtures are
 * reported separately so the headline numbers are honest.
 */
function computeTraction() {
  const now = Date.now();
  const allProfiles = listProfiles();
  const real = allProfiles.filter((p) => !isTestActor(p));
  const test = allProfiles.filter((p) => isTestActor(p));
  const events = readEvents();

  // actors seen in the event log, and their most recent activity
  const lastEventByActor = new Map();
  const activatedActors = new Set(); // chat OR auth_view — activation per spec
  for (const e of events) {
    const prev = lastEventByActor.get(e.actor);
    if (!prev || e.ts > prev) lastEventByActor.set(e.actor, e.ts);
    if (e.event === EVENTS.CHAT || e.event === EVENTS.AUTH_VIEW) activatedActors.add(e.actor);
  }

  const realIds = new Set(real.map((p) => p.id));
  const activatedReal = [...activatedActors].filter((a) => realIds.has(a));

  // Chat actors keyed by session that map to no profile = anonymous/guest usage. This is
  // the strongest raw signal that a human used the product even without an account.
  const chatSessions = new Set(events.filter((e) => e.event === EVENTS.CHAT).map((e) => e.actor));
  const anonymousChatSessions = [...chatSessions].filter((a) => a !== "anon" && !realIds.has(a)).length;

  // ── ACQUISITION ─────────────────────────────────────────────────────────────
  const bySource = {};
  for (const p of real) {
    const s = (p.metadata && p.metadata.source) || "local";
    bySource[s] = (bySource[s] || 0) + 1;
  }
  const signups7d = real.filter((p) => daysAgo(p.metadata?.createdAt, now) <= 7).length;
  const signups30d = real.filter((p) => daysAgo(p.metadata?.createdAt, now) <= 30).length;

  // ── ACTIVATION ── first chat OR reached the signup/auth surface (usage intent) ──
  const verified = real.filter((p) => p.emailVerified === true).length;
  const activationCount = new Set([
    ...activatedReal,
    ...real.filter((p) => p.metadata?.lastLoginAt).map((p) => p.id), // logged in ⇒ used it
  ]).size;

  // ── RETENTION ── active in the last 7 / 30 days (event or login) ───────────────
  function lastActivity(p) {
    const login = p.metadata?.lastLoginAt;
    const ev = lastEventByActor.get(p.id);
    const candidates = [login, ev].filter(Boolean);
    if (!candidates.length) return Infinity;
    return Math.min(...candidates.map((c) => daysAgo(c, now)));
  }
  const active7d = real.filter((p) => lastActivity(p) <= 7).length;
  const active30d = real.filter((p) => lastActivity(p) <= 30).length;

  // ── REVENUE ── paid role/tier or an explicit paid entitlement ──────────────────
  const paying = real.filter(
    (p) => PAID_ROLES.has(p.role) || (p.tier && p.tier !== "guest") || p.entitlements?.trade === true
  );

  // ── FUNNEL (unambiguous stage definitions, per PostHog AARRR guidance) ──────────
  const totalReal = real.length;
  const funnel = [
    { stage: "Acquisition — profile created", n: totalReal },
    { stage: "Activation — verified OR used (chat/login/auth)", n: activationCount },
    { stage: "Retention — active in last 30d", n: active30d },
    { stage: "Revenue — paying role/tier", n: paying.length },
  ];

  function pct(n, d) { return d > 0 ? +((100 * n) / d).toFixed(1) : 0; }

  return {
    generatedAt: new Date().toISOString(),
    definitions: {
      acquisition: "A real (non-test) profile exists.",
      activation: "Sent a chat OR reached the signup/auth surface OR has logged in.",
      retention: "Had a login or tracked event within the window.",
      revenue: "role ∈ {supporter, deep_dreamer, founder, patron}, a non-guest tier, or trade entitlement.",
      referral: "NOT INSTRUMENTED — no referral event exists yet (honest gap).",
    },
    totals: {
      realProfiles: totalReal,
      testProfiles: test.length,
      events: events.length,
    },
    acquisition: { total: totalReal, bySource, signups7d, signups30d },
    activation: {
      count: activationCount,
      rate: pct(activationCount, totalReal),
      emailVerified: verified,
      verifiedRate: pct(verified, totalReal),
      anonymousChatSessions,
    },
    retention: {
      active7d, active30d,
      rate30d: pct(active30d, totalReal),
    },
    revenue: {
      payingUsers: paying.length,
      rate: pct(paying.length, totalReal),
      byTier: paying.reduce((acc, p) => {
        const k = p.tier || p.role;
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {}),
    },
    referral: { instrumented: false },
    funnel: funnel.map((f) => ({ ...f, pctOfTop: pct(f.n, totalReal) })),
    // per-user table (real accounts only; test fixtures listed separately)
    users: real
      .map((p) => ({
        id: p.id,
        name: p.name,
        email: p.email,
        role: p.role,
        tier: p.tier,
        source: p.metadata?.source || "local",
        emailVerified: p.emailVerified === true,
        createdAt: p.metadata?.createdAt || null,
        lastActiveDays: (() => { const d = lastActivity(p); return d === Infinity ? null : +d.toFixed(1); })(),
        activated: activatedReal.includes(p.id) || !!p.metadata?.lastLoginAt,
        paying: PAID_ROLES.has(p.role) || (p.tier && p.tier !== "guest") || p.entitlements?.trade === true,
      }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    testUsers: test.map((p) => ({ id: p.id, name: p.name, email: p.email, source: p.metadata?.source || "local" })),
  };
}

module.exports = { EVENTS, track, readEvents, computeTraction, isTestActor };
