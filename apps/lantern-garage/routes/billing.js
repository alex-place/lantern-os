"use strict";

/**
 * Stripe subscription billing — HTTP layer (see the pure core in lib/stripe-billing.js
 * and the build spec, issue #2568).
 *
 * BOOT-SAFE by construction:
 *   - the `stripe` SDK is lazy-require()d inside handlers, so the app boots (and every
 *     non-billing route works) even when the package isn't installed;
 *   - every endpoint answers 503 {billing_not_configured} when STRIPE_SECRET_KEY is unset,
 *     so a deploy without keys degrades cleanly instead of throwing.
 *
 * The single webhook is the SOURCE OF TRUTH for entitlements: it verifies Stripe's
 * signature over the EXACT raw bytes (hence its own Buffer reader — the shared
 * collectRequestBody UTF-8-decodes and caps at 64 KB, which would break verification),
 * dedupes by event id, maps the subscription's Price → a whitelisted role, and calls the
 * same applyStripeState() seam Patreon-side role changes use. Effective role is always
 * MAX(patreonRole, stripeRole); a purchase can never mint admin.
 */

const {
  isConfigured, roleForPrice, accessForStatus, tierToRole, priceIdForRole,
  alreadyProcessed, markProcessed, HANDLED_EVENTS,
} = require("../lib/stripe-billing");
const {
  getProfile, applyStripeState, getProfileByStripeCustomer,
} = require("../lib/user-profiles");
const { getEffectiveUserId, getSessionUser, setSessionUser } = require("../lib/session-identity");

// One SDK instance per process, built on first use (never at require-time).
let _stripe = null;
function stripe() {
  if (_stripe) return _stripe;
  const Stripe = require("stripe"); // lazy — absent-package error is caught by callers
  _stripe = Stripe((process.env.STRIPE_SECRET_KEY || "").trim());
  return _stripe;
}

// Test vs live isolation: a live-keyed server must ignore test-mode webhooks (and the
// dual-boot 4177/4178 pair shares the profiles JSONL, so a Stripe CLI test event must
// not mutate prod state). Derived from the secret-key prefix.
function expectLivemode() { return (process.env.STRIPE_SECRET_KEY || "").startsWith("sk_live"); }

// Read the raw request body as a Buffer for signature verification. Own reader (not
// collectRequestBody) so the bytes are byte-exact and uncapped-but-bounded.
function readRawBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error("payload_too_large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function baseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host || "127.0.0.1:4177";
  return `${proto}://${host}`;
}

// Resolve the local profile id a Stripe object belongs to: prefer an explicit hint
// (checkout carries our user id in client_reference_id), else the stored customer link.
function resolveUserId(customerId, hintId) {
  if (hintId && getProfile(hintId)) return hintId;
  const p = getProfileByStripeCustomer(customerId);
  return p ? p.id : null;
}

// Apply a subscription object's price+status to the owning profile. `hintId` is the
// checkout's client_reference_id on the first event (before the customer link exists).
function syncSubscription(sub, hintId) {
  const customerId = typeof sub.customer === "string" ? sub.customer : (sub.customer && sub.customer.id);
  const userId = resolveUserId(customerId, hintId);
  if (!userId) { console.error("[BILLING] no profile for stripe customer", customerId); return; }

  const price = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price;
  const role = roleForPrice(price);
  const decision = accessForStatus(sub.status);
  const common = {
    customerId,
    subscriptionId: sub.id,
    status: sub.status,
    currentPeriodEnd: sub.current_period_end || null,
  };

  if (decision === "revoke") {
    applyStripeState(userId, { ...common, stripeRole: null });
  } else if (decision === "grant") {
    if (!role) { console.error("[BILLING] unmappable price on active sub", price && price.id); applyStripeState(userId, common); return; }
    applyStripeState(userId, { ...common, stripeRole: role });
  } else {
    // "keep" (dunning): record status but leave stripeRole untouched (omitted → preserved)
    // so a transient decline never strips the paid role mid-retry.
    applyStripeState(userId, common);
  }
}

// Revoke by customer for money-reversal events (refund / chargeback) that don't carry a
// subscription object. Keeping access after a dispute would let a chargeback keep the tier.
function revokeByCustomer(customerId, statusLabel) {
  const p = getProfileByStripeCustomer(customerId);
  if (!p) return;
  applyStripeState(p.id, { stripeRole: null, status: statusLabel });
}

async function handleEvent(event) {
  const obj = event.data && event.data.object;
  switch (event.type) {
    case "checkout.session.completed": {
      // obj = Checkout Session: link customer→profile, then sync the new subscription.
      const hintId = obj.client_reference_id || null;
      const customerId = typeof obj.customer === "string" ? obj.customer : (obj.customer && obj.customer.id);
      if (hintId && customerId && getProfile(hintId)) applyStripeState(hintId, { customerId }); // establish the link
      if (obj.subscription) {
        const sub = await stripe().subscriptions.retrieve(
          typeof obj.subscription === "string" ? obj.subscription : obj.subscription.id
        );
        syncSubscription(sub, hintId);
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      syncSubscription(obj, null);
      break;
    case "invoice.paid":
    case "invoice.payment_failed": {
      // Re-sync from the authoritative subscription so status/period stay current.
      if (obj.subscription) {
        const sub = await stripe().subscriptions.retrieve(
          typeof obj.subscription === "string" ? obj.subscription : obj.subscription.id
        );
        syncSubscription(sub, null);
      }
      break;
    }
    case "charge.refunded":
      revokeByCustomer(typeof obj.customer === "string" ? obj.customer : (obj.customer && obj.customer.id), "refunded");
      break;
    case "charge.dispute.created":
      revokeByCustomer(typeof obj.customer === "string" ? obj.customer : (obj.customer && obj.customer.id), "disputed");
      break;
    default:
      break; // acked, ignored
  }
}

module.exports = async function billingRoutes(req, res, url, deps) {
  const { sendJson } = deps;
  if (!url.pathname.startsWith("/api/billing/") && url.pathname !== "/billing/success") return false;

  // ── Webhook: verify signature over raw bytes, dedupe, apply ──────────────────
  if (url.pathname === "/api/billing/webhook" && req.method === "POST") {
    if (!isConfigured() || !process.env.STRIPE_WEBHOOK_SECRET) {
      sendJson(res, { error: "billing_not_configured" }, 503);
      return true;
    }
    let raw;
    try { raw = await readRawBody(req); }
    catch { sendJson(res, { error: "payload_too_large" }, 413); return true; }

    let event;
    try {
      event = stripe().webhooks.constructEvent(raw, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
    } catch (e) {
      // Bad/absent signature (or SDK missing) → 400 so Stripe records the failure.
      sendJson(res, { error: "invalid_signature", detail: e.message }, 400);
      return true;
    }

    // Ignore cross-mode events (test webhook hitting a live server or vice-versa).
    if (event.livemode !== expectLivemode()) { sendJson(res, { received: true, skipped: "livemode_mismatch" }); return true; }
    // Idempotent: Stripe retries for ~3 days with no ordering guarantee.
    if (alreadyProcessed(event.id)) { sendJson(res, { received: true, duplicate: true }); return true; }

    if (HANDLED_EVENTS.has(event.type)) {
      try { await handleEvent(event); }
      catch (e) { console.error("[BILLING] handler error", event.type, e.message); sendJson(res, { error: "handler_error" }, 500); return true; }
    }
    markProcessed(event.id, event.type);
    sendJson(res, { received: true });
    return true;
  }

  // ── Public capability probe: does native checkout work here? (no secrets) ────
  // Lets pricing.html reveal the "Subscribe with card" buttons only when billing is
  // live, and fall back to the Patreon CTA otherwise.
  if (url.pathname === "/api/billing/config" && req.method === "GET") {
    const { priceIdForRole } = require("../lib/stripe-billing");
    sendJson(res, {
      configured: isConfigured(),
      tiers: {
        member: !!priceIdForRole("supporter"),
        pro: !!priceIdForRole("deep_dreamer"),
        pilot: !!priceIdForRole("pilot"),
      },
    });
    return true;
  }

  // Every remaining endpoint needs Stripe configured.
  if (!isConfigured()) { sendJson(res, { error: "billing_not_configured" }, 503); return true; }

  // ── Create a Checkout Session for the requested tier (auth required) ─────────
  if (url.pathname === "/api/billing/checkout" && req.method === "POST") {
    const userId = getEffectiveUserId(req);
    if (!userId) { sendJson(res, { error: "auth_required" }, 401); return true; }
    let body = {};
    try { body = JSON.parse(await deps.collectRequestBody(req) || "{}"); } catch { /* empty body ok */ }

    const role = tierToRole(body.tier || body.role);
    if (!role) { sendJson(res, { error: "unknown_tier", detail: String(body.tier || body.role || "") }, 400); return true; }
    const price = priceIdForRole(role);
    if (!price) { sendJson(res, { error: "price_not_configured", detail: `set STRIPE_PRICE_${role.toUpperCase()}` }, 503); return true; }

    const profile = getProfile(userId);
    try {
      const session = await stripe().checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price, quantity: 1 }],
        client_reference_id: userId,
        // Reuse the stored customer so a returning buyer doesn't get a duplicate.
        ...(profile && profile.stripeCustomerId ? { customer: profile.stripeCustomerId } : (profile && profile.email ? { customer_email: profile.email } : {})),
        allow_promotion_codes: true,
        success_url: `${baseUrl(req)}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl(req)}/pricing.html?checkout=cancel`,
      });
      sendJson(res, { url: session.url });
    } catch (e) {
      console.error("[BILLING] checkout create failed", e.message);
      sendJson(res, { error: "checkout_failed", detail: e.message }, 502);
    }
    return true;
  }

  // ── Open the Stripe Customer Portal (manage/cancel — auth required) ──────────
  if (url.pathname === "/api/billing/portal" && req.method === "POST") {
    const userId = getEffectiveUserId(req);
    if (!userId) { sendJson(res, { error: "auth_required" }, 401); return true; }
    const profile = getProfile(userId);
    if (!profile || !profile.stripeCustomerId) { sendJson(res, { error: "no_subscription" }, 409); return true; }
    try {
      const portal = await stripe().billingPortal.sessions.create({
        customer: profile.stripeCustomerId,
        return_url: `${baseUrl(req)}/pricing.html`,
      });
      sendJson(res, { url: portal.url });
    } catch (e) {
      console.error("[BILLING] portal create failed", e.message);
      sendJson(res, { error: "portal_failed", detail: e.message }, 502);
    }
    return true;
  }

  // ── Post-checkout return: refresh the cached session role from the profile ───
  // The webhook already granted the role on the profile, but the logged-in session
  // still holds the pre-purchase role snapshot; re-read it so the UI reflects the
  // new tier immediately instead of on next login. (The webhook, not this, is the
  // source of truth — this only re-reads what the webhook persisted.)
  if (url.pathname === "/billing/success" && req.method === "GET") {
    const userId = getEffectiveUserId(req);
    if (userId) {
      const fresh = getProfile(userId);
      const sess = getSessionUser(req);
      if (fresh && sess) {
        setSessionUser(req, { ...sess, role: fresh.role, entitlements: fresh.entitlements || {} });
        if (typeof req.session.save === "function") { try { req.session.save(() => {}); } catch { /* non-fatal */ } }
      }
    }
    res.writeHead(302, { Location: "/pricing.html?checkout=success" });
    res.end();
    return true;
  }

  return false;
};
