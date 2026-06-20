/**
 * Dream Chat UX Playwright tests — dream-chat.html (the primary Keystone OS chat)
 *
 * Drives the real chat surface as a user would:
 *   - page load, starter chips, input + send affordances
 *   - SSE streaming render (tokens → bubble), route signature, Σ₀ badge
 *   - error / truncation / degraded-mode handling
 *   - local command routing (!ask, work-intent, !explore navigation)
 *   - settings modal, sessions drawer, new chat, provider selection, responsive
 *
 * fetch() is mocked at the JS level (addInitScript) before page scripts run —
 * page.route() can't stream ReadableStream bodies, which breaks SSE parsing.
 *
 * Usage:
 *   npx playwright test tests/test_dream_chat_ux.spec.js
 *   npx playwright test tests/test_dream_chat_ux.spec.js --ui
 *
 * Requires: server running at BASE_URL (node apps/lantern-garage/server.js)
 */

const { test, expect } = require("@playwright/test");
const { baseUrl: BASE_URL } = require("./lantern-test-base");

const PAGE = `${BASE_URL}/dream-chat.html`;

// Matches every entry in dream-chat-ui.js's FALLBACKS pool (offline/error text).
const FALLBACK_RE = /No AI providers are set up|All providers offline|Connection quiet|No provider answered|AI unavailable/i;

// The happy-path SSE script: route → 2 tokens → done (with routeLabel + cleanText).
const HAPPY_STREAM = [
  { type: "route", label: "Keystone · auto" },
  { type: "token", text: "Hello " },
  { type: "token", text: "from Keystone." },
  { type: "done", source: "claude", routeLabel: "Keystone · Claude", cleanText: "Hello from Keystone." },
];

/**
 * Install a fetch() override before the page loads. Everything not explicitly
 * mocked falls through to the real network (auth/session, status polls, etc.).
 *
 * cfg = {
 *   streamEvents: SSE event objects to emit (default HAPPY_STREAM),
 *   streamStatus: HTTP status for the stream endpoint (default 200),
 *   convergence:  JSON returned by /api/convergence/agent (!ask + work-intent),
 * }
 */
async function mockDreamChat(page, cfg = {}) {
  await page.addInitScript((cfg) => {
    const orig = window.fetch.bind(window);
    window.__chatRequests = [];
    window.__convRequests = [];
    const events = (cfg.streamEvents || [
      { type: "route", label: "Keystone · auto" },
      { type: "token", text: "Hello " },
      { type: "token", text: "from Keystone." },
      { type: "done", source: "claude", routeLabel: "Keystone · Claude", cleanText: "Hello from Keystone." },
    ]);

    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      const method = (init && init.method) || "GET";

      if (url.includes("/api/dream/chat/stream")) {
        let body = {};
        try { body = JSON.parse((init && init.body) || "{}"); } catch (_) {}
        window.__chatRequests.push(body);

        if (cfg.streamStatus && cfg.streamStatus >= 400) {
          return new Response("Internal Server Error", { status: cfg.streamStatus });
        }

        const payload = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(payload));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }

      if (url.includes("/api/convergence/agent") && method === "POST") {
        let body = {};
        try { body = JSON.parse((init && init.body) || "{}"); } catch (_) {}
        window.__convRequests.push(body);
        return new Response(
          JSON.stringify(cfg.convergence || { answer: "Instant local answer.", grounded: true, actions: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return orig(input, init);
    };
  }, cfg);
}

// Send `text` through the real (gated) sendMessage and let the stream settle.
async function send(page, text) {
  await page.fill("#input", text);
  await page.click("#send-btn");
}

const lastAgent = (page) => page.locator(".message.agent").last();

test.describe("Dream Chat — page load", () => {
  test("loads with the Keystone OS title", async ({ page }) => {
    await page.goto(PAGE);
    await expect(page).toHaveTitle(/Dream Chat|Keystone OS/i);
  });

  test("nav brand reads Keystone OS", async ({ page }) => {
    await page.goto(PAGE);
    await expect(page.locator(".nav-brand")).toContainText("Keystone OS");
  });

  test("empty state shows the Keystone Desk welcome", async ({ page }) => {
    await page.goto(PAGE);
    await expect(page.locator("#empty-state")).toBeVisible();
    await expect(page.locator("#empty-state")).toContainText("Keystone Desk");
  });

  test("renders six starter chips", async ({ page }) => {
    await page.goto(PAGE);
    await expect(page.locator(".starter-chip")).toHaveCount(6);
  });

  test("input and send button are present and enabled for guests", async ({ page }) => {
    await page.goto(PAGE);
    await expect(page.locator("#input")).toBeEnabled();
    await expect(page.locator("#send-btn")).toBeEnabled();
  });
});

test.describe("Dream Chat — input behaviour", () => {
  test("textarea accepts typed input", async ({ page }) => {
    await page.goto(PAGE);
    await page.fill("#input", "what is the convergence loop");
    await expect(page.locator("#input")).toHaveValue("what is the convergence loop");
  });

  test("empty input does not create a message", async ({ page }) => {
    await page.goto(PAGE);
    await page.click("#send-btn");
    await expect(page.locator(".message")).toHaveCount(0);
  });

  test("Shift+Enter inserts a newline and does not send", async ({ page }) => {
    await page.goto(PAGE);
    await page.locator("#input").click();
    await page.keyboard.type("line one");
    await page.keyboard.down("Shift");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Shift");
    await page.keyboard.type("line two");
    await expect(page.locator("#input")).toHaveValue("line one\nline two");
    await expect(page.locator(".message.user")).toHaveCount(0);
  });

  test("Enter (no shift) sends the message", async ({ page }) => {
    await mockDreamChat(page);
    await page.goto(PAGE);
    await page.fill("#input", "ping via enter");
    await page.locator("#input").press("Enter");
    await expect(page.locator(".message.user")).toContainText("ping via enter");
  });
});

test.describe("Dream Chat — streaming render", () => {
  test.beforeEach(async ({ page }) => {
    await mockDreamChat(page);
  });

  test("typed message appears as a user bubble", async ({ page }) => {
    await page.goto(PAGE);
    await send(page, "render my message");
    await expect(page.locator(".message.user")).toContainText("render my message");
  });

  test("streamed tokens render in the agent bubble (regression: thinking ReferenceError)", async ({ page }) => {
    await page.goto(PAGE);
    await send(page, "stream tokens");
    await expect(lastAgent(page)).toContainText("Hello from Keystone.", { timeout: 8000 });
    await expect(lastAgent(page)).not.toHaveClass(/error/);
    await expect(lastAgent(page)).not.toContainText(FALLBACK_RE);
  });

  test("tokens with no cleanText still render (exact regression case)", async ({ page }) => {
    // Reinstall the mock for a done event WITHOUT cleanText — the path that
    // previously surfaced a false "No provider answered" error.
    await mockDreamChat(page, {
      streamEvents: [
        { type: "token", text: "Streamed " },
        { type: "token", text: "tokens, no cleanText." },
        { type: "done", source: "ollama" },
      ],
    });
    await page.goto(PAGE);
    await send(page, "tokens only");
    await expect(lastAgent(page)).toContainText("Streamed tokens, no cleanText.", { timeout: 8000 });
    await expect(lastAgent(page)).not.toContainText(FALLBACK_RE);
  });

  test("the thinking mandala is removed once tokens arrive", async ({ page }) => {
    await page.goto(PAGE);
    await send(page, "no spinner left behind");
    await expect(lastAgent(page)).toContainText("Hello from Keystone.", { timeout: 8000 });
    await expect(page.locator(".thinking-mandala")).toHaveCount(0);
  });

  test("route signature is shown when the done event carries a routeLabel", async ({ page }) => {
    await page.goto(PAGE);
    await send(page, "show route");
    await expect(page.locator(".msg-route-sig").last()).toContainText("Keystone · Claude", { timeout: 8000 });
  });

  test("send button re-enables after the stream completes", async ({ page }) => {
    await page.goto(PAGE);
    await send(page, "re-enable me");
    await expect(lastAgent(page)).toContainText("Hello from Keystone.", { timeout: 8000 });
    await expect(page.locator("#send-btn")).toBeEnabled();
  });

  test("two sequential sends produce two user and two agent bubbles", async ({ page }) => {
    await page.goto(PAGE);
    await send(page, "first message");
    await expect(lastAgent(page)).toContainText("Hello from Keystone.", { timeout: 8000 });
    await send(page, "second message");
    await expect(page.locator(".message.user")).toHaveCount(2);
    await expect(page.locator(".message.agent")).toHaveCount(2);
  });
});

test.describe("Dream Chat — error & edge handling", () => {
  test("HTTP 500 on the stream surfaces an error bubble with a fallback", async ({ page }) => {
    await mockDreamChat(page, { streamStatus: 500 });
    await page.goto(PAGE);
    await send(page, "trigger 500");
    await expect(lastAgent(page)).toHaveClass(/error/, { timeout: 8000 });
    await expect(lastAgent(page)).toContainText(FALLBACK_RE);
  });

  test("a server error event with no tokens shows the error text", async ({ page }) => {
    await mockDreamChat(page, {
      streamEvents: [
        { type: "error", text: "The streaming engine hit an internal error." },
        { type: "done", source: "offline", online: false },
      ],
    });
    await page.goto(PAGE);
    await send(page, "server error event");
    await expect(lastAgent(page)).toContainText("internal error", { timeout: 8000 });
  });

  test("a stream that ends without a done event flags truncation", async ({ page }) => {
    await mockDreamChat(page, {
      streamEvents: [
        { type: "token", text: "This answer was cut o" },
      ],
    });
    await page.goto(PAGE);
    await send(page, "truncate me");
    await expect(lastAgent(page)).toContainText("⚠ truncated", { timeout: 8000 });
  });

  test("a Σ₀-corrected reply shows the verification badge", async ({ page }) => {
    await mockDreamChat(page, {
      streamEvents: [
        { type: "token", text: "Verified answer." },
        { type: "sigma0", corrected: true, claims: 2 },
        { type: "done", source: "claude", cleanText: "Verified answer." },
      ],
    });
    await page.goto(PAGE);
    await send(page, "verify this");
    await expect(lastAgent(page)).toContainText("✓ Σ₀", { timeout: 8000 });
  });
});

test.describe("Dream Chat — local command routing", () => {
  test("work-intent queries route to the instant convergence agent (no LLM)", async ({ page }) => {
    await mockDreamChat(page, {
      convergence: { answer: "Top issue: fix the streaming bug.", grounded: true, actions: [] },
    });
    await page.goto(PAGE);
    await send(page, "what work needs to be done?");
    await expect(page.locator(".msg-row.agent").last()).toContainText("Top issue: fix the streaming bug.", { timeout: 8000 });
    await expect(page.locator(".msg-row.agent").last()).toContainText("Instant answer");
    // It must NOT have hit the streaming LLM endpoint.
    expect(await page.evaluate(() => window.__chatRequests.length)).toBe(0);
    expect(await page.evaluate(() => window.__convRequests.length)).toBe(1);
  });

  test("!ask routes to the convergence agent", async ({ page }) => {
    await mockDreamChat(page, {
      convergence: { answer: "The router caches 120 Keystone routes.", grounded: true, actions: [] },
    });
    await page.goto(PAGE);
    await send(page, "!ask explain the convergence router");
    await expect(page.locator(".msg-row.agent").last()).toContainText("120 Keystone routes", { timeout: 8000 });
    expect(await page.evaluate(() => window.__convRequests.length)).toBe(1);
  });

  test("!explore leaves chat for the Three Doors game route", async ({ page }) => {
    // The command sets location.href to /three-doors-game.html. That page is not
    // in auth-gate's PUBLIC list, so a guest is bounced on to /auth.html — either
    // destination proves the command fired the redirect away from chat.
    await page.goto(PAGE);
    await page.fill("#input", "!explore");
    await page.click("#send-btn");
    await page.waitForURL(/three-doors-game\.html|auth\.html/, { timeout: 8000 });
    expect(page.url()).toMatch(/three-doors-game\.html|auth\.html/);
  });
});

test.describe("Dream Chat — settings, sessions, new chat", () => {
  test("settings modal opens, exposes providers, and closes", async ({ page }) => {
    await page.goto(PAGE);
    await page.click("#settings-btn");
    await expect(page.locator("#settings-modal")).toHaveClass(/open/);
    await expect(page.locator("#provider-select")).toBeVisible();
    await expect(page.locator("#provider-select option[value='claude']")).toHaveCount(1);
    await page.locator("#settings-modal .modal-close").click();
    await expect(page.locator("#settings-modal")).not.toHaveClass(/open/);
  });

  test("sessions drawer opens and closes", async ({ page }) => {
    await page.goto(PAGE);
    await page.click("#sessions-btn");
    await expect(page.locator("#sessions-overlay")).toHaveClass(/open/);
    await page.locator(".sessions-close").click();
    await expect(page.locator("#sessions-overlay")).not.toHaveClass(/open/);
  });

  test("new chat clears the conversation and restores the empty state", async ({ page }) => {
    await mockDreamChat(page);
    await page.goto(PAGE);
    await send(page, "this should be cleared");
    await expect(lastAgent(page)).toContainText("Hello from Keystone.", { timeout: 8000 });
    await page.click("#new-chat-btn");
    await expect(page.locator(".message")).toHaveCount(0);
    await expect(page.locator("#empty-state")).toBeVisible();
  });
});

test.describe("Dream Chat — provider selection & responsive", () => {
  test("the chosen provider is sent to the stream endpoint", async ({ page }) => {
    // Premium providers (claude/openai/grok) are role-gated off for guests; the
    // local Σ₀ loop (ollama) is always selectable, so it's the portable choice here.
    await mockDreamChat(page);
    await page.goto(PAGE);
    await page.click("#settings-btn");
    await page.selectOption("#provider-select", "ollama");
    await page.locator("#settings-modal .modal-close").click();
    await send(page, "use the local loop please");
    await expect(lastAgent(page)).toContainText("Hello from Keystone.", { timeout: 8000 });
    expect(await page.evaluate(() => window.__chatRequests[0].provider)).toBe("ollama");
  });

  test("guests cannot select premium providers, but can pick auto and local", async ({ page }) => {
    await page.goto(PAGE);
    await page.click("#settings-btn");
    await expect(page.locator("#provider-select option[value='claude']")).toBeDisabled();
    await expect(page.locator("#provider-select option[value='']")).toBeEnabled();
    await expect(page.locator("#provider-select option[value='ollama']")).toBeEnabled();
  });

  test("input and send stay usable on a mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(PAGE);
    await expect(page.locator("#input")).toBeVisible();
    await expect(page.locator("#send-btn")).toBeVisible();
  });
});
