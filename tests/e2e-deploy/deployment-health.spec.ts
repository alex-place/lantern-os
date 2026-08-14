import { test, expect, APIRequestContext } from '@playwright/test';

/**
 * deployment-health.spec.ts — does the product actually WORK where it is deployed?
 *
 * Written after a live outage in which the GCE host ran with zero providers
 * configured: chat had no model, answered every question with the offline
 * fallback, and no test could have caught it — because every other suite boots
 * a fresh local server whose environment is correct by construction.
 *
 * The rule this suite encodes: a release is not "verified" because the code is
 * green. It is verified when the KEY FEATURES answer on the machine that serves
 * them. Two tiers:
 *
 *   ALWAYS      structural + self-consistency checks. Safe in CI with no keys.
 *   EXPECT_LIVE assertions that only mean something against a real deployment
 *               (set DEPLOY_EXPECT_LIVE=1).
 */

const EXPECT_LIVE = process.env.DEPLOY_EXPECT_LIVE === '1';
const liveOnly = EXPECT_LIVE ? test : test.skip;

async function getJson(request: APIRequestContext, path: string) {
  const res = await request.get(path);
  expect(res.status(), `${path} should answer 200`).toBe(200);
  return res.json();
}

test.describe('deployment identity', () => {
  test('reports a semver build it is actually running', async ({ request }) => {
    const body = await getJson(request, '/api/version');
    expect(body.ok).toBe(true);
    // A deployment that cannot name its own build cannot be reasoned about
    // during an incident — this is the first question asked every time.
    expect(body.version?.semver, 'version.semver must be present').toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.version?.commit, 'version.commit must be a full sha').toMatch(/^[0-9a-f]{40}$/);
    if (process.env.DEPLOY_EXPECT_VERSION) {
      expect(body.version.semver).toBe(process.env.DEPLOY_EXPECT_VERSION);
    }
  });
});

test.describe('providers — the outage this suite exists for', () => {
  test('the registry never reports a configured provider as unconfigured', async ({ request }) => {
    // Guards the SHAPE of the v1.15.3 bug rather than that exact instance.
    //
    // There, two registries disagreed: lib/provider-cache.js counted Vertex
    // config as a credential (so dispatch worked) while routes/providers.js
    // checked one env name and reported health "no_key". From outside the
    // process only one of those is visible, so no HTTP assertion could have
    // seen the disagreement itself — the check that actually catches that
    // outage is the availability one below.
    //
    // What IS externally checkable is self-consistency: a provider the server
    // calls `available` must not simultaneously claim it has no credential.
    // The two fields have to tell the same story, whichever wire is in use.
    const body = await getJson(request, '/api/providers/status');
    const providers: Record<string, any> = body.providers || {};
    expect(Object.keys(providers).length, 'providers must be enumerated').toBeGreaterThan(0);

    const contradictions = Object.entries(providers)
      .filter(([, p]) => p.available === true && (p.hasKey === false || p.health === 'no_key'))
      .map(([name, p]) => `${name}: available=${p.available} hasKey=${p.hasKey} health=${p.health}`);
    expect(contradictions, 'available providers must not report themselves credential-less').toEqual([]);
  });

  test('the summary agrees with the per-provider detail', async ({ request }) => {
    // A summary that drifts from the rows is how "everything is fine" gets
    // reported during an outage.
    const body = await getJson(request, '/api/providers/status');
    const providers: Record<string, any> = body.providers || {};
    const countedAvailable = Object.values(providers).filter((p: any) => p.available === true).length;
    expect(body.summary?.available, 'summary.available must match the rows').toBe(countedAvailable);
    expect(body.summary?.total).toBe(Object.keys(providers).length);
  });

  liveOnly('at least one provider is actually usable — chat has a model', async ({ request }) => {
    // The outage in one assertion. Zero available providers means every chat
    // turn falls through to the offline reply, which is indistinguishable to a
    // user from the product being broken.
    const body = await getJson(request, '/api/providers/status');
    const usable = Object.entries(body.providers || {})
      .filter(([, p]: [string, any]) => p.available === true)
      .map(([name]) => name);
    expect(usable.length, `no provider is available — chat cannot answer. summary=${JSON.stringify(body.summary)}`).toBeGreaterThan(0);
  });
});

test.describe('key surfaces answer', () => {
  // The pages a visitor or paying member actually lands on. A 200 plus real
  // markup — not a blank shell, not an error page rendered with status 200.
  const SURFACES = [
    { path: '/', mustContain: 'unisona' },
    { path: '/stock-trader.html', mustContain: 'Trade' },
    { path: '/pricing.html', mustContain: 'Pro' },
    { path: '/chat.html', mustContain: 'Unisona' },
  ];

  for (const s of SURFACES) {
    test(`${s.path} serves real content`, async ({ page }) => {
      const res = await page.goto(s.path, { waitUntil: 'domcontentloaded' });
      expect(res?.status(), `${s.path} should be reachable`).toBeLessThan(400);
      const html = await page.content();
      expect(html.length, `${s.path} should not be an empty shell`).toBeGreaterThan(1000);
      expect(html).toContain(s.mustContain);
    });
  }

  test('the trading market-data API answers', async ({ request }) => {
    // Public read — no auth, no account. If this is down the trader renders
    // empty for everyone, signed in or not.
    const body = await getJson(request, '/api/trading/market-status');
    expect(body, 'market-status should return an object').toBeTruthy();
  });
});

test.describe('gated surfaces stay gated', () => {
  test('per-account trading data is not readable anonymously', async ({ request }) => {
    // A deployment check must also confirm the LOCKS survived the deploy —
    // "it works" and "it leaks" can both be true at once.
    for (const path of ['/api/trading/scorecard', '/api/trading/track-record', '/api/trading/alerts/rules']) {
      const res = await request.get(path);
      expect([401, 403], `${path} must refuse an anonymous caller (got ${res.status()})`).toContain(res.status());
    }
  });
});
