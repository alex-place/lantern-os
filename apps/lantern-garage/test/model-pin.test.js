/**
 * test/model-pin.test.js
 *
 * Model pin (#1127 work item 1): the chat UI may request a specific model, but
 * the server only honours an allowlisted id for the pinned provider. The
 * effective default (env override included) is always accepted.
 *
 * Run with: npx jest test/model-pin.test.js
 */
const { CHAT_MODEL_OPTIONS, isAllowedModel, modelFor } = require("../lib/provider-models");

describe("isAllowedModel", () => {
  test("allowlisted ids are accepted for their provider", () => {
    for (const [provider, options] of Object.entries(CHAT_MODEL_OPTIONS)) {
      for (const m of options) expect(isAllowedModel(provider, m.id)).toBe(true);
    }
  });

  test("the effective default is always accepted", () => {
    expect(isAllowedModel("anthropic", modelFor("anthropic"))).toBe(true);
  });

  test("env-overridden default is accepted even off-list", () => {
    process.env.GEMINI_MODEL = "gemini-x-custom";
    try {
      expect(isAllowedModel("gemini", "gemini-x-custom")).toBe(true);
    } finally {
      delete process.env.GEMINI_MODEL;
    }
  });

  test("arbitrary / retired ids are rejected", () => {
    expect(isAllowedModel("anthropic", "claude-1")).toBe(false);
    expect(isAllowedModel("openai", "gpt-3.5-turbo")).toBe(false);
    expect(isAllowedModel("xai", "grok-2-1212")).toBe(false);
  });

  test("cross-provider ids are rejected", () => {
    expect(isAllowedModel("openai", "claude-sonnet-4-6")).toBe(false);
  });

  test("missing provider or model is rejected", () => {
    expect(isAllowedModel("", "gpt-4.1")).toBe(false);
    expect(isAllowedModel("openai", "")).toBe(false);
    expect(isAllowedModel("nosuch", "gpt-4.1")).toBe(false);
  });
});

describe("stream request parsing carries the model", () => {
  const { parseStreamChatRequest } = require("../lib/stream-chat/request");

  test("POST body.model lands in parsed.requestedModel (trimmed, capped)", async () => {
    const parsed = await parseStreamChatRequest(
      { method: "POST" },
      new URL("http://x/api/dream/chat/stream"),
      {
        collectRequestBody: async () =>
          JSON.stringify({ message: "hi", provider: "claude", model: "  claude-sonnet-4-6  " }),
      },
    );
    expect(parsed.requestedModel).toBe("claude-sonnet-4-6");
    expect(parsed.requestedProvider).toBe("claude");
  });

  test("absent model parses to empty string", async () => {
    const parsed = await parseStreamChatRequest(
      { method: "POST" },
      new URL("http://x/api/dream/chat/stream"),
      { collectRequestBody: async () => JSON.stringify({ message: "hi" }) },
    );
    expect(parsed.requestedModel).toBe("");
  });
});
