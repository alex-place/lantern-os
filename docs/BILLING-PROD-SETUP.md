# Stripe billing — production setup checklist (unisona.ai)

The subscription checkout code (native Stripe Checkout, #2568) is complete and prod-correct.
The "Subscribe to Pro/Pilot" buttons on `/pricing.html` and the whole checkout → grant flow are
**switched off in production until the environment is configured** — by design they degrade to
"no button" rather than a broken one.

**Live state (verify anytime):**

```bash
curl -s https://unisona.ai/api/billing/config
```

As of this writing it returns `{"configured": false, "tiers": {"pro": false, "pilot": false}}` —
i.e. **no Stripe env is set on prod**, so the buttons stay hidden and no checkout can start.
When setup is complete this must read `{"configured": true, "tiers": {"pro": true, "pilot": true}}`.

---

## 1. Environment variables (prod deploy — GCE)

Set these on the production `lantern-garage` service. `isConfigured()` keys on `STRIPE_SECRET_KEY`;
each tier's button unhides only when its price id is present (`routes/billing.js` config endpoint).

| Var | Required | What | Notes |
|-----|----------|------|-------|
| `STRIPE_SECRET_KEY` | **yes** | Live secret key `sk_live_…` (or restricted `rk_live_…`) | Drives `configured` **and** live-mode. A test key makes the server treat itself as test mode and **drop real webhooks** (`isLiveKey`/`expectLivemode`). Must be LIVE. |
| `STRIPE_PRICE_DEEP_DREAMER` | **yes** | Live Price id for the **$20 Pro** plan `price_…` | Maps to role `deep_dreamer`. Without it the Pro button never unhides. |
| `STRIPE_PRICE_PILOT` | **yes** | Live Price id for the **$200 Pilot** plan `price_…` | Maps to role `pilot`. |
| `STRIPE_WEBHOOK_SECRET` | **yes** | Signing secret `whsec_…` for the webhook endpoint | The webhook is the **source of truth** for granting the tier. Without it, a paid checkout completes but the tier is **never applied**. |
| `PUBLIC_BASE_URL` | recommended | `https://unisona.ai` | Redirect targets (success/cancel/portal-return). The code derives `https://<host>` from the request otherwise, which is correct behind a normal host header, but setting this explicitly is proxy/CDN-safe. |
| `STRIPE_PRICE_SUPPORTER` | optional | Legacy $5 Member price | Only if the retired Member tier is still sold. |
| `STRIPE_API_HOST` / `_PORT` / `_PROTOCOL` | **leave unset** | Test-only mock-host seam | Must be unset in prod — setting it points the SDK away from Stripe. |

Do **not** commit any of these values — they are secrets set on the deploy, never in the repo.

## 2. Stripe dashboard (live mode)

1. **Products / Prices** — in **live** mode, create (or confirm) a recurring monthly Price for Pro
   ($20) and Pilot ($200); copy their `price_…` ids into the two env vars above. The prices must be
   live-mode — a test-mode price id with a live key will fail checkout.
2. **Webhook endpoint** — add `https://unisona.ai/api/billing/webhook`, subscribed to at least:
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted` (the events in `HANDLED_EVENTS`). Copy its signing secret into
   `STRIPE_WEBHOOK_SECRET`. The endpoint verifies the signature over the raw bytes, so it must be
   the webhook's own secret, live-mode.
3. **Customer portal** — enable the Billing customer portal (used by "Manage subscription" and the
   already-subscribed path) in live mode.

## 3. Deploy

- The buttons' wording change ("Subscribe to Pro/Pilot", PR #3084) is cosmetic — checkout works with
  either label once configured. But it only appears on prod after that PR merges **and the prod
  deploy actually rolls.** Prod is currently reported stalled on v1.12.1 (#3024); the Stripe code
  itself (#2568) is already deployed, so config is the only functional gap.

## 4. Verify end-to-end (operator)

1. `curl -s https://unisona.ai/api/billing/config` → `configured:true`, `pro:true`, `pilot:true`.
2. Signed in on unisona.ai, load `/pricing.html` → "Subscribe to Pro" / "Subscribe to Pilot" appear.
3. Click one → redirects to a Stripe-hosted checkout page for the right amount/interval.
4. Complete a real payment **with a real card** (this step involves live money and must be done by
   the operator, not an automated agent), then confirm the account's tier flips to Pro/Pilot — the
   `/billing/success` eager-sync applies it immediately and the webhook confirms it. A Stripe test
   card will not work against a live key.
5. Cancel from the customer portal → the `customer.subscription.deleted` webhook returns the role to
   the Patreon/Stripe max.

## Bottom line

The code path is done and verified on a Stripe-configured server. To make it work **completely on
unisona.ai**, an operator sets the four required env vars (§1), wires the live prices + webhook in
the Stripe dashboard (§2), and rolls the deploy (§3). No code change is required.
