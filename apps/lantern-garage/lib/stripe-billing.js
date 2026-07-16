"use strict";

/**
 * Stripe billing — PURE logic (no Stripe SDK, no HTTP, no boot-time side effects).
 *
 * The money-mapping decisions live here so they're unit-testable and so the server
 * boots fine with Stripe unconfigured: the SDK is lazy-required in routes/billing.js
 * only when STRIPE_SECRET_KEY is set. See the build spec (issue #2568).
 *
 * A Stripe subscription is a SECOND entitlement source feeding the SAME role model as
 * Patreon: the webhook maps a subscription's Price → a whitelisted role, and the
 * effective role is higherRole(patreonRole, stripeRole). A purchase can NEVER grant
 * admin (mirrors the auth-providers "no purchasable admin" invariant).
 */

const fs = require("fs");
const path = require("path");
const { higherRole } = require("./role-hierarchy");

// The ONLY roles a Stripe purchase may resolve to. Never admin / tech_support / founder.
const PURCHASABLE = new Set(["supporter", "deep_dreamer", "pilot"]);

// USD-cent thresholds — mirror auth-providers TIER_CENTS so Stripe and Patreon agree.
const AMOUNT_CENTS = { supporter: 500, deep_dreamer: 2000, pilot: 20000 };

// Env-configured Price ids per tier (read lazily so tests can set them).
function tierPrices() {
  return {
    supporter:    process.env.STRIPE_PRICE_SUPPORTER || "",
    deep_dreamer: process.env.STRIPE_PRICE_DEEP_DREAMER || "",
    pilot:        process.env.STRIPE_PRICE_PILOT || "",
  };
}

/** Is Stripe billing turned on for this deploy? */
function isConfigured() { return !!(process.env.STRIPE_SECRET_KEY || "").trim(); }

/**
 * Is this a LIVE-mode secret key? Drives the webhook livemode gate. Matches BOTH standard
 * (`sk_live_`) and restricted (`rk_live_`) keys, and trims — a stray space or a restricted
 * key must not make a live server misclassify itself as test and silently drop every real
 * webhook. A non-live (test / empty / malformed) key is treated as test mode.
 */
function isLiveKey(key) { return /^(sk|rk)_live_/.test(String(key || "").trim()); }

/** The UI sends a tier keyword ("member"/"pro"/"pilot"); resolve it to a role. */
function tierToRole(tier) {
  const t = String(tier || "").toLowerCase().trim();
  if (t === "member" || t === "supporter") return "supporter";
  if (t === "pro" || t === "deep_dreamer") return "deep_dreamer";
  if (t === "pilot") return "pilot";
  return null;
}

/** The Stripe Price id to charge for a given role (from env). */
function priceIdForRole(role) { return tierPrices()[role] || ""; }

/**
 * Map a Stripe Price object → a WHITELISTED role, or null if it can't be resolved safely.
 * Resolution order (most-trusted first):
 *   1. exact Price-id match against the env-configured ids
 *   2. price.metadata.role — operator config, so it MUST be whitelisted (a Dashboard
 *      "admin" typo can never elevate)
 *   3. USD-only unit_amount fallback (unit_amount is minor units of the price's OWN
 *      currency, so a €5 price is 500 too — never map a non-USD amount)
 */
function roleForPrice(price) {
  if (!price) return null;
  const ids = tierPrices();
  for (const role of Object.keys(ids)) {
    if (ids[role] && price.id === ids[role]) return role;
  }
  const meta = price.metadata && price.metadata.role;
  if (meta && PURCHASABLE.has(meta)) return meta;
  if (price.currency === "usd" && Number.isFinite(Number(price.unit_amount))) {
    const c = Number(price.unit_amount);
    if (c >= AMOUNT_CENTS.pilot) return "pilot";
    if (c >= AMOUNT_CENTS.deep_dreamer) return "deep_dreamer";
    if (c >= AMOUNT_CENTS.supporter) return "supporter";
  }
  return null;
}

/**
 * Subscription status → access decision:
 *   grant  — active/trialing
 *   keep   — the dunning states (past_due/incomplete): DON'T demote mid-retry, so a
 *            transient decline never strips a paid role while Smart Retries run
 *   revoke — the terminal states (canceled/unpaid/incomplete_expired/paused)
 * Unknown → keep (fail-closed against stripping access on an unrecognized status).
 */
function accessForStatus(status) {
  switch (String(status || "")) {
    case "active":
    case "trialing":
      return "grant";
    case "past_due":
    case "incomplete":
      return "keep";
    case "canceled":
    case "unpaid":
    case "incomplete_expired":
    case "paused":
      return "revoke";
    default:
      return "keep";
  }
}

// Webhook events the handler acts on; everything else is acked (2xx) and ignored.
const HANDLED_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
]);

// ── Idempotency ledger — Stripe retries for ~3 days with no ordering guarantee ──
// Lives under the cwd-relative data store (same root as data/profiles), so it shares the
// deployment's data dir and is correctly isolated per checkout — NOT module-relative.
function ledgerPath() {
  return path.resolve(process.cwd(), "data", "billing", "processed-events.jsonl");
}
function alreadyProcessed(eventId, ledger = ledgerPath()) {
  if (!eventId) return false;
  try {
    return fs.readFileSync(ledger, "utf8").split("\n").some((l) => l.includes(`"id":"${eventId}"`));
  } catch { return false; }
}
function markProcessed(eventId, type, ledger = ledgerPath()) {
  try {
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.appendFileSync(ledger, JSON.stringify({ id: eventId, type: type || "", at: new Date().toISOString() }) + "\n");
  } catch { /* best-effort telemetry — never fail a webhook on the ledger */ }
}

/**
 * Effective role across paid sources. Never below either source; a non-whitelisted
 * stripeRole is clamped to guest before it can reach the MAX (defends the no-buy-admin
 * invariant even if a bad snapshot is persisted).
 */
function effectiveRole(patreonRole, stripeRole) {
  const s = PURCHASABLE.has(stripeRole) ? stripeRole : "guest";
  return higherRole(patreonRole || "guest", s || "guest");
}

/**
 * From a customer's subscription list, the one worth linking to an account —
 * an active/trialing sub first, else a dunning one (past_due/incomplete: the
 * webhook keeps access through Smart Retries, so linking it is consistent), and
 * never a terminal one. A sub with NO status is skipped outright: accessForStatus
 * maps unknown → "keep" as a fail-closed default for webhooks, but for LINKING the
 * conservative direction is the opposite — don't claim what we can't classify.
 */
function pickLinkableSubscription(subs) {
  let dunning = null;
  for (const s of subs || []) {
    if (!s || !s.status) continue;
    const decision = accessForStatus(s.status);
    if (decision === "grant") return s;
    if (decision === "keep" && !dunning) dunning = s;
  }
  return dunning;
}

module.exports = {
  isConfigured, isLiveKey, tierToRole, priceIdForRole, roleForPrice, accessForStatus,
  effectiveRole, pickLinkableSubscription, alreadyProcessed, markProcessed, ledgerPath,
  HANDLED_EVENTS, PURCHASABLE, AMOUNT_CENTS, tierPrices,
};
