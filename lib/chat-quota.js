"use strict";

/**
 * Server-side daily chat-message caps by subscription tier.
 *
 * The chat UI declares per-tier daily limits (Guest 10 / Free 50 / Member 100 / Pro 250 /
 * Pilot ∞) but they were never enforced on the server — every tier could send unlimited
 * paid LLM calls. This module is the enforcement point: a per-actor, per-UTC-day counter.
 *
 * Actor keying:
 *   - authenticated → the session profile id (stable across the account's linked logins)
 *   - anonymous     → the client IP (best-effort soft cap; anon chat is a courtesy)
 *
 * Tiers above Pro (pilot, admin) are unlimited and never touch disk. Caps are
 * env-overridable so a re-pricing is config, not code. Counts live in one small JSON
 * file, pruned to the current day on every write (a new day resets everyone).
 *
 * Concurrency note: read-modify-write on a single JSON file. Under a burst of concurrent
 * requests from the SAME actor a few messages could slip past the cap — acceptable for a
 * soft usage limit; it never UNDER-counts to the point of blocking a legitimate user.
 */

const fs = require("fs");
const path = require("path");
const { getSessionUser } = require("./session-identity");
const { roleLevel } = require("./role-hierarchy");

const DIR = path.resolve(__dirname, "..", "data", "chat-usage");
const FILE = path.join(DIR, "daily-counts.json");

// Daily message caps by role. `anon` = not signed in; `guest` = signed-in Free tier.
const CAPS = {
  anon:         Number(process.env.CHAT_CAP_GUEST  || 10),
  guest:        Number(process.env.CHAT_CAP_FREE   || 50),
  supporter:    Number(process.env.CHAT_CAP_MEMBER || 100), // $5 Member
  deep_dreamer: Number(process.env.CHAT_CAP_PRO    || 250), // $20 Pro
  // pilot ($200) / admin → unlimited
};

function _clientIp(req) {
  const xff = String((req.headers && req.headers["x-forwarded-for"]) || "").split(",")[0].trim();
  return xff || (req.socket && req.socket.remoteAddress) || "unknown";
}
function _dayKey() { return new Date().toISOString().slice(0, 10); } // UTC day

/** Resolve the cap + actor key for a request. Unlimited tiers return cap = Infinity. */
function capFor(req) {
  const user = getSessionUser(req);
  if (!user || !user.id) {
    return { cap: CAPS.anon, tier: "guest", actor: "ip:" + _clientIp(req), authed: false };
  }
  const role = user.role || "guest";
  if (roleLevel(role) >= roleLevel("pilot")) {
    return { cap: Infinity, tier: role, actor: "u:" + user.id, authed: true };
  }
  const cap = CAPS[role] != null ? CAPS[role] : CAPS.guest;
  return { cap, tier: role, actor: "u:" + user.id, authed: true };
}

function _read() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; }
}
function _write(obj) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(obj)); } catch { /* best-effort */ }
}

/**
 * Check-and-consume one message for the request's actor.
 * @returns {{allowed:boolean, cap:number, used:number, remaining:number, tier:string}}
 */
function consume(req) {
  const { cap, tier, actor } = capFor(req);
  if (!Number.isFinite(cap)) return { allowed: true, cap: Infinity, used: 0, remaining: Infinity, tier };

  const day = _dayKey();
  const key = `${day}|${actor}`;
  const store = _read();
  const used = Number(store[key] || 0);
  if (used >= cap) return { allowed: false, cap, used, remaining: 0, tier };

  // Increment, keeping only TODAY's keys so the file self-prunes each day.
  const next = { [key]: used + 1 };
  for (const k of Object.keys(store)) {
    if (k !== key && k.startsWith(day + "|")) next[k] = store[k];
  }
  _write(next);
  return { allowed: true, cap, used: used + 1, remaining: cap - used - 1, tier };
}

module.exports = { consume, capFor, CAPS };
