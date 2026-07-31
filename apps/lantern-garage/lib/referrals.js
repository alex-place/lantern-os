"use strict";

/**
 * lib/referrals.js — refer-a-friend attribution + conversion (#2554).
 *
 * Product plan v5 §02 Level-3 unlock. A user shares a signed referral link; a
 * referred signup is attributed in the traction ledger; a referral "converts"
 * only when the referee crosses the composite ACTIVE bar (watchlist + ≥10 chats
 * + ≥1 paper trade — #2547), which is the anti-gaming gate: no reward-eligibility
 * for an account that never became real. The exact REWARD (e.g. a free month of
 * Pro) is a founder call and is NOT auto-issued here — this module measures
 * attribution + conversion; issuing comp stays the operator's decision, same as
 * the founding-member override. Level-3 activation is likewise deferred by the
 * plan; the mechanism ships now, measurable.
 *
 * The referral CODE is a keyed HMAC of the userId (no storage, unforgeable,
 * verifiable), so a link is valid iff it was minted by this server.
 *
 * LOOP STAGE: Converge (grounds referral growth in measured, gamed-proof events).
 */

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { resolveSessionSecret } = require("./session-secret");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_FILE = path.join(repoRoot, "data", "traction", "events.jsonl");

function secret() {
  // An explicit REFERRAL_SECRET wins (lets referral codes survive a session-secret
  // rotation); otherwise defer to the fail-closed session secret. NOT a literal
  // fallback: this file's own contract is an "unforgeable" share code, and a constant
  // published in this repo makes every user's code computable by anyone — enough to
  // misattribute signups to an account you don't own. Same class as #2619.
  return process.env.REFERRAL_SECRET || resolveSessionSecret();
}

// base32-ish, url-safe, no padding — short enough to share, long enough not to guess.
function b32(buf) {
  return buf.toString("base64").replace(/\+/g, "").replace(/\//g, "").replace(/=/g, "").slice(0, 12).toLowerCase();
}

/**
 * Deterministic signed referral code for a user (stable across sessions).
 *
 * This is a keyed MAC over a PUBLIC identifier (the userId), NOT password storage:
 * the code is meant to be shared in a link, and it must be recomputable to be
 * verified — so a deliberately-slow password hash (bcrypt/scrypt) would be the
 * WRONG primitive. HMAC-SHA256 with a server secret is the correct construction
 * for an unforgeable, verifiable share code. CodeQL's js/insufficient-password-hash
 * mis-classifies the session-derived userId as a password; suppressed accordingly.
 */
function codeFor(userId) {
  const uid = String(userId || "").trim();
  if (!uid) return null;
  const mac = crypto.createHmac("sha256", secret()).update("ref:" + uid).digest(); // codeql[js/insufficient-password-hash]
  return b32(mac);
}

/** The full share link (host provided by the caller, no PII in the query). */
function linkFor(userId, origin) {
  const code = codeFor(userId);
  if (!code) return null;
  const base = (origin || "https://www.unisona.ai").replace(/\/$/, "");
  return `${base}/?ref=${code}`;
}

/**
 * Which userId (if any) minted this code? O(n) over known profiles — codes are a
 * keyed HMAC, so we can't invert; we recompute each profile's code and match.
 * n = signed-up users, run once per referred signup — cheap.
 */
function resolveCode(code, opts = {}) {
  const c = String(code || "").trim().toLowerCase();
  if (!c) return null;
  let profiles = [];
  try { profiles = (opts.listProfiles ? opts.listProfiles() : require("./user-profiles").listProfiles()) || []; }
  catch { profiles = []; }
  for (const p of profiles) {
    if (p && p.id && codeFor(p.id) === c) return p.id;
  }
  return null;
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/)
      .filter((l) => l && !l.trimStart().startsWith("#"))
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function referralEvents(file) {
  return readJsonl(file || DEFAULT_FILE).filter((e) => e.kind === "referral_signup" && e.verified === true);
}

/**
 * Attribute a referred signup. Records a MEASURED referral_signup event keyed by
 * (referrer, referee). No-ops on self-referral, an unresolvable code, or a
 * referee already attributed (one referrer per referee, first wins).
 */
async function attributeSignup({ code, refereeId }, opts = {}) {
  const referee = String(refereeId || "").trim();
  if (!referee) return { ok: false, reason: "no_referee" };
  const referrer = resolveCode(code, opts);
  if (!referrer) return { ok: false, reason: "bad_code" };
  if (referrer === referee) return { ok: false, reason: "self_referral" };
  const already = referralEvents(opts.tractionFile).some((e) => e.evidence && e.evidence.referee === referee);
  if (already) return { ok: false, reason: "already_attributed" };
  const { recordTractionEvent } = require("./traction");
  const rec = await recordTractionEvent({
    kind: "referral_signup",
    actor: referrer,
    verified: true,
    confidence: "high",
    source: opts.source || "signup",
    evidence: { referrer, referee },
  }, { file: opts.tractionFile });
  return { ok: true, event: rec };
}

/**
 * Per-referrer conversion tally. A referee "converts" when they are composite-ACTIVE
 * (#2547). Reward-eligibility === converted (anti-gaming: never issue for an account
 * that didn't become active). Reward ISSUANCE is the founder's call — not done here.
 */
function conversions(opts = {}) {
  const events = referralEvents(opts.tractionFile);
  let activeIds = new Set();
  try {
    const { evaluateActiveUsers } = require("./active-user-metric");
    activeIds = new Set(evaluateActiveUsers(opts).actives.map((u) => u.userId));
  } catch { activeIds = new Set(); }

  const byReferrer = new Map();
  for (const e of events) {
    const { referrer, referee } = e.evidence || {};
    if (!referrer || !referee) continue;
    if (!byReferrer.has(referrer)) byReferrer.set(referrer, { referrer, signups: [], converted: [] });
    const r = byReferrer.get(referrer);
    r.signups.push(referee);
    if (activeIds.has(referee)) r.converted.push(referee); // reward-eligible
  }
  const referrers = [...byReferrer.values()].map((r) => ({
    referrer: r.referrer,
    signups: r.signups.length,
    converted: r.converted.length,       // === reward-eligible count
    convertedReferees: r.converted,
  })).sort((a, b) => b.converted - a.converted || b.signups - a.signups);

  return {
    provenance: "MEASURED",
    totalSignups: events.length,
    totalConverted: referrers.reduce((s, r) => s + r.converted, 0),
    rewardIssuance: "founder_decision", // this module never auto-issues comp
    referrers,
  };
}

module.exports = { codeFor, linkFor, resolveCode, attributeSignup, conversions };
