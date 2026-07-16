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
  isConfigured, isLiveKey, roleForPrice, accessForStatus, tierToRole, priceIdForRole,
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
  // Test-only seam: point the SDK at a local mock host so the outbound API calls
  // (checkout/subscriptions/portal) can be exercised end-to-end without a Stripe
  // account. No-op in prod (env unset). Webhook signature verification is unaffected —
  // it only uses STRIPE_WEBHOOK_SECRET, never reaches the network.
  const host = (process.env.STRIPE_API_HOST || "").trim();
  const opts = host
    ? { host, port: Number(process.env.STRIPE_API_PORT) || 443, protocol: process.env.STRIPE_API_PROTOCOL || "https" }
    : undefined;
  _stripe = Stripe((process.env.STRIPE_SECRET_KEY || "").trim(), opts);
  return _stripe;
}

// Test vs live isolation: a live-keyed server must ignore test-mode webhooks (and the
// dual-boot 4177/4178 pair shares the profiles JSONL, so a Stripe CLI test event must
// not mutate prod state). isLiveKey() trims + matches sk_/rk_ so a stray space or a
// restricted key can't misclassify a live server as test and silently drop real events.
function expectLivemode() { return isLiveKey(process.env.STRIPE_SECRET_KEY); }

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

// Base URL for Stripe redirect targets (success/cancel/portal-return). These are baked
// into the Checkout Session, so they must NOT be attacker-controllable: prefer the
// operator-configured PUBLIC_BASE_URL, and only fall back to request headers for local
// dev. This closes a host-header / open-redirect hole in the money path (a forged
// X-Forwarded-Host would otherwise point the post-payment redirect off-domain).
function baseUrl(req) {
  const configured = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const host = req.headers.host || "127.0.0.1:4177";
  // Only trust request headers for loopback dev; anything else needs PUBLIC_BASE_URL.
  const proto = /^(127\.0\.0\.1|localhost)(:|$)/.test(host) ? "http" : "https";
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

  const item = sub.items && sub.items.data && sub.items.data[0];
  const price = item && item.price;
  const role = roleForPrice(price);
  const decision = accessForStatus(sub.status);
  const common = {
    customerId,
    subscriptionId: sub.id,
    status: sub.status,
    // Stripe Basil (2025-04+) moved current_period_end off the subscription onto the
    // item; read the item first with a legacy fallback so the period end isn't null.
    currentPeriodEnd: (item && item.current_period_end) || sub.current_period_end || null,
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

// The subscription id on an invoice, across API versions: legacy invoice.subscription,
// or Basil's invoice.parent.subscription_details.subscription / the first line's parent.
function invoiceSubscriptionId(inv) {
  if (!inv) return null;
  if (inv.subscription) return typeof inv.subscription === "string" ? inv.subscription : inv.subscription.id;
  const psd = inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription;
  if (psd) return typeof psd === "string" ? psd : psd.id;
  const line = inv.lines && inv.lines.data && inv.lines.data[0];
  const lsub = line && line.parent && line.parent.subscription_item_details && line.parent.subscription_item_details.subscription;
  return lsub ? (typeof lsub === "string" ? lsub : lsub.id) : null;
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
      // Basil (2025-04+) removed invoice.subscription → it now lives under
      // invoice.parent.subscription_details.subscription (fall back for both shapes).
      const subId = invoiceSubscriptionId(obj);
      if (subId) {
        const sub = await stripe().subscriptions.retrieve(subId);
        syncSubscription(sub, null);
      }
      break;
    }
    case "charge.refunded": {
      // Only a FULL refund revokes — a partial/goodwill refund leaves the sub active and
      // must not strip a paying subscriber's tier. `refunded` is true only when fully
      // refunded; otherwise compare amounts.
      const fully = obj.refunded === true || (Number(obj.amount_refunded) >= Number(obj.amount) && Number(obj.amount) > 0);
      if (fully) revokeByCustomer(typeof obj.customer === "string" ? obj.customer : (obj.customer && obj.customer.id), "refunded");
      break;
    }
    case "charge.dispute.created": {
      // event.data.object is a DISPUTE, which has NO .customer — resolve it from the
      // disputed charge, else a chargeback silently keeps access.
      const chargeId = typeof obj.charge === "string" ? obj.charge : (obj.charge && obj.charge.id);
      let customerId = null;
      if (chargeId) {
        try {
          const ch = await stripe().charges.retrieve(chargeId);
          customerId = typeof ch.customer === "string" ? ch.customer : (ch.customer && ch.customer.id);
        } catch (e) { console.error("[BILLING] dispute charge lookup failed", e.message); }
      }
      revokeByCustomer(customerId, "disputed");
      break;
    }
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
    const uid = getEffectiveUserId(req);
    const prof = uid ? getProfile(uid) : null;
    // Only an ACTIVE Stripe sub means "manage in portal" — a Patreon-only patron has no
    // Stripe customer and should still see the Subscribe buttons.
    const subscribed = !!(prof && prof.stripeCustomerId && accessForStatus(prof.stripeStatus) === "grant");
    sendJson(res, {
      configured: isConfigured(),
      tiers: {
        member: !!priceIdForRole("supporter"),
        pro: !!priceIdForRole("deep_dreamer"),
        pilot: !!priceIdForRole("pilot"),
      },
      subscribed,                                  // has a live Stripe subscription
      stripeStatus: (prof && prof.stripeStatus) || null,
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
    // Guard against a SECOND concurrent subscription: a user with an active Stripe sub who
    // clicks another tier would otherwise be billed twice (subscription-mode Checkout does
    // not dedupe). Tier changes must go through the Customer Portal, not a new checkout.
    if (profile && profile.stripeCustomerId && accessForStatus(profile.stripeStatus) === "grant") {
      sendJson(res, { error: "already_subscribed", detail: "Manage or change your plan from the customer portal.", portal: "/api/billing/portal" }, 409);
      return true;
    }
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

  // ── Post-checkout return: eager-sync the grant, then refresh the session role ──
  // Stripe redirects the browser here BEFORE it delivers checkout.session.completed, so
  // the profile role is still pre-purchase at this moment. We use the session_id to
  // retrieve the Checkout Session and apply the grant NOW (idempotent — the later webhook
  // re-applies the same absolute state), so the user sees their new tier immediately
  // instead of only after the webhook lands / a re-login. The webhook remains the source
  // of truth; this is a best-effort eager mirror gated to THIS user's own session.
  if (url.pathname === "/billing/success" && req.method === "GET") {
    const userId = getEffectiveUserId(req);
    if (userId) {
      const sessionId = url.searchParams.get("session_id");
      if (sessionId) {
        try {
          const cs = await stripe().checkout.sessions.retrieve(sessionId);
          if (cs && cs.client_reference_id === userId) { // only sync the caller's own checkout
            const customerId = typeof cs.customer === "string" ? cs.customer : (cs.customer && cs.customer.id);
            if (customerId) applyStripeState(userId, { customerId });
            if (cs.subscription) {
              const sub = await stripe().subscriptions.retrieve(
                typeof cs.subscription === "string" ? cs.subscription : cs.subscription.id
              );
              syncSubscription(sub, userId);
            }
          }
        } catch (e) { console.error("[BILLING] success eager-sync failed", e.message); }
      }
      const fresh = getProfile(userId);
      const sess = getSessionUser(req);
      if (fresh && sess) {
        setSessionUser(req, { ...sess, role: fresh.role, entitlements: fresh.entitlements || {} });
      }
    }
    // Persist the session BEFORE redirecting so the next page load reads the fresh role
    // (avoids a redirect-vs-save race). Fall back to an immediate redirect if no store.
    const go = () => { res.writeHead(302, { Location: "/pricing.html?checkout=success" }); res.end(); };
    if (req.session && typeof req.session.save === "function") { try { req.session.save(go); } catch { go(); } }
    else go();
    return true;
  }

  return false;
};
