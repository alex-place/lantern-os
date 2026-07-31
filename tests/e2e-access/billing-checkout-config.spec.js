// @ts-check
/**
 * billing-checkout-config.spec.js — a deploy must be able to take payments with
 * ONLY STRIPE_SECRET_KEY set.
 *
 * Checkout used to hard-require a per-tier Price id and 503 "price_not_configured"
 * without one, which left pricing.html rendering a priced plan with no buy button.
 * lib/stripe-billing now falls back to an inline price built from the canonical
 * AMOUNT_CENTS ladder. These are pure-function checks — no Stripe network call.
 */
const { test, expect } = require('@playwright/test');
const billing = require('../../apps/lantern-garage/lib/stripe-billing');

test.describe('billing checkout configuration', () => {
  test.afterEach(() => {
    delete process.env.STRIPE_PRICE_DEEP_DREAMER;
    delete process.env.STRIPE_PRICE_PILOT;
  });

  test('every sold tier is buyable with no Price ids configured', () => {
    delete process.env.STRIPE_PRICE_DEEP_DREAMER;
    delete process.env.STRIPE_PRICE_PILOT;
    for (const role of ['deep_dreamer', 'pilot']) {
      expect(billing.canCheckout(role), `${role} must be buyable on an api-key-only deploy`).toBe(true);
    }
  });

  test('the fallback prices match the sold ladder, monthly and in USD', () => {
    const pro = billing.lineItemForRole('deep_dreamer');
    expect(pro.price_data.unit_amount).toBe(2000);   // $20
    expect(pro.price_data.currency).toBe('usd');
    expect(pro.price_data.recurring.interval).toBe('month');

    const pilot = billing.lineItemForRole('pilot');
    expect(pilot.price_data.unit_amount).toBe(20000); // $200
  });

  test('a configured Price id wins over the fallback', () => {
    process.env.STRIPE_PRICE_DEEP_DREAMER = 'price_test_123';
    const item = billing.lineItemForRole('deep_dreamer');
    expect(item.price).toBe('price_test_123');
    expect(item.price_data, 'a real Price id must not be shadowed by an inline price').toBeUndefined();
  });

  test('an unknown tier is refused rather than invented', () => {
    expect(billing.lineItemForRole('not_a_tier')).toBeNull();
    expect(billing.canCheckout('not_a_tier')).toBe(false);
  });
});
