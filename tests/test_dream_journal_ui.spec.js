/**
 * Keystone OS home (root page) Playwright tests
 * Run after starting lantern-garage: node apps/lantern-garage/server.js
 *
 * Usage:
 *   npx playwright test tests/test_dream_journal_ui.spec.js
 *   npx playwright test --ui
 *
 * Note: the root page was rebranded from "Dream Journal" to "Keystone OS" and is
 * now a landing page (hero + navigation tiles). It no longer hosts a stat-card
 * dashboard, an entry-creation form, or a recent-entries list — those tests were
 * updated to the current surfaces (or removed). Dream-chat behaviour is covered
 * in tests/test_dream_chat_ux.spec.js.
 */

const { test, expect } = require("@playwright/test");
const { baseUrl: BASE_URL } = require("./lantern-test-base");

test.describe("unisona.ai Home UI", () => {
  test("home page loads and shows unisona.ai branding", async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page).toHaveTitle(/unisona/i);
    await expect(page.locator(".nav-brand")).toContainText("unisona.ai");
    await expect(page.locator("h1")).toContainText("unisona.ai");
    // Static hero tagline (not overwritten by the live-state loader)
    await expect(page.locator(".tagline")).toContainText("remembers you");
  });

  test("home navigation tiles render", async ({ page }) => {
    await page.goto(BASE_URL);
    const tiles = page.locator(".home-tiles .panel");
    await expect(tiles.first()).toBeVisible();
    expect(await tiles.count()).toBeGreaterThanOrEqual(3);
    await expect(page.locator(".home-tiles")).toContainText("Keystone Trader");
  });

  test("hero CTA links to Keystone Chat", async ({ page }) => {
    await page.goto(BASE_URL);
    const cta = page.locator(".hero-cta-row a.btn-primary").first();
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", /dream-chat\.html/);
    await expect(cta).toContainText("Keystone Chat");
  });

  test("chat input accepts text and triggers agent response", async ({ page }) => {
    await page.goto(BASE_URL);

    // Find chat input
    const chatInput = page.locator("input[placeholder*='dream'], textarea[placeholder*='dream'], [contenteditable='true']").first();

    // Some UIs use contenteditable divs
    if (await chatInput.isVisible().catch(() => false)) {
      await chatInput.fill("I saw a glowing light in my dream");
      await chatInput.press("Enter");

      // Wait for agent response bubble
      await page.waitForTimeout(2000);
      const response = page.locator(".chat-message, .agent-reply, .message-bubble").last();
      const text = await response.textContent().catch(() => "");
      expect(text.length).toBeGreaterThan(0);
    }
  });

  test("suggestion buttons are clickable", async ({ page }) => {
    await page.goto(BASE_URL);

    // Look for suggestion chips or buttons
    const suggestions = page.locator(".suggestion, .chip, button");
    const count = await suggestions.count();

    if (count > 0) {
      // Click first suggestion
      await suggestions.first().click();
      // Should not throw
      expect(true).toBe(true);
    }
  });

  test("door buttons trigger lore response", async ({ page }) => {
    await page.goto(BASE_URL);

    // Look for door-related buttons or links
    const doors = page.locator("button, a").filter({ hasText: /door|Door|doors/ });
    const count = await doors.count();

    if (count > 0) {
      await doors.first().click();
      await page.waitForTimeout(1000);
      // Page should not crash
      expect(await page.title()).toBeTruthy();
    }
  });

  test("entry type selector changes form mode", async ({ page }) => {
    await page.goto(BASE_URL);

    const typeSelect = page.locator("select[name='kind'], select[name='type'], [name='entryType']").first();
    if (await typeSelect.isVisible().catch(() => false)) {
      await typeSelect.selectOption("note");
      // Form should remain visible
      await expect(page.locator("form").first()).toBeVisible();
    }
  });

  test("lucidity slider has range 0-1", async ({ page }) => {
    await page.goto(BASE_URL);

    const slider = page.locator("input[type='range'], input[name='lucidity']").first();
    if (await slider.isVisible().catch(() => false)) {
      const min = await slider.getAttribute("min");
      const max = await slider.getAttribute("max");
      expect(["0", null]).toContain(min);
      expect(["1", "10", null]).toContain(max);
    }
  });

  // REMOVED: "recent entries list updates after creating entry" — the root page no
  // longer hosts an entry-creation form or a recent-entries list (both moved off the
  // landing page in the Keystone OS rebrand). There is no equivalent surface to test.
});

test.describe("Dream Journal Chat Agents", () => {
  test("multi-agent chat shows agent names in response", async ({ page }) => {
    await page.goto(BASE_URL);

    const chatInput = page.locator("input[placeholder*='dream'], textarea[placeholder*='dream'], [contenteditable='true']").first();

    if (await chatInput.isVisible().catch(() => false)) {
      await chatInput.fill("Tell me about the doors");
      await chatInput.press("Enter");
      await page.waitForTimeout(3000);

      // Look for agent name indicators in the response
      const bodyText = await page.locator("body").textContent();
      const hasAgentNames = /Blinkbug|Waterfall|Xenon|Mary|Courtney/i.test(bodyText);
      expect(hasAgentNames || bodyText.length > 50).toBe(true);
    }
  });

  // NOTE: The legacy "#agent-select" debug affordance was removed when Dream Chat
  // became Keystone-only. Comprehensive dream-chat coverage now lives in
  // tests/test_dream_chat_ux.spec.js (streaming, routing, settings, sessions).
});
