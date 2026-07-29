/**
 * test/model-escalation.test.js
 *
 * Auto mode resolved every turn to the provider's cheap default (gemini-2.5-flash,
 * gpt-4.1-mini, claude-haiku, grok-3-mini). Right for the bulk of chat, but it silently
 * capped quality on the turns that most need reasoning — a design/proof/tradeoff question
 * got Flash. escalatedModelFor() lifts THOSE turns to the provider's deep model.
 *
 * The contract worth pinning: escalation is conservative (it costs real money), it never
 * overrides an explicit human choice, and it can only ever return an allowlisted model.
 *
 * Run with: npx jest test/model-escalation.test.js
 */
const {
  isDeepTurn, escalatedModelFor, modelFor, isAllowedModel, DEEP_MODELS,
} = require("../lib/provider-models");

const CLEAN = ["KEYSTONE_MODEL_ESCALATION", "GEMINI_MODEL", "OPENAI_MODEL", "ANTHROPIC_MODEL", "XAI_MODEL"];
beforeEach(() => { for (const k of CLEAN) delete process.env[k]; });
afterEach(() => { for (const k of CLEAN) delete process.env[k]; });

describe("isDeepTurn — fires on reasoning work", () => {
  test.each([
    "Analyze the tradeoffs between Postgres and DynamoDB for this workload",
    "Why does the tool loop hang when a provider times out?",
    "Design an architecture for multi-tenant billing",
    "Compare these two approaches and evaluate which is better",
    "Debug this stack trace and find the root cause",
    "Think carefully about the implications of flipping this default",
  ])("deep: %s", (m) => expect(isDeepTurn(m)).toBe(true));

  test("a coding-change turn is always deep", () => {
    expect(isDeepTurn("update the readme", { codingIntent: true })).toBe(true);
  });
});

describe("isDeepTurn — stays cheap for ordinary chat", () => {
  test.each([
    "hi",
    "what's the weather in Tokyo?",
    "latest news about NASA",
    "what time is it in London",
    "summarize this article",
    "what is the capital of France",
  ])("cheap: %s", (m) => expect(isDeepTurn(m)).toBe(false));

  test("empty / null input is never deep", () => {
    expect(isDeepTurn("")).toBe(false);
    expect(isDeepTurn(null)).toBe(false);
  });

  test("merely LONG is not deep — length alone must not burn the expensive tier", () => {
    expect(isDeepTurn("please summarize the following notes. " + "lorem ipsum ".repeat(80))).toBe(false);
  });
});

describe("escalatedModelFor", () => {
  test("a deep turn gets the provider's deep model", () => {
    expect(escalatedModelFor("gemini", "Analyze the tradeoffs here")).toBe("gemini-2.5-pro");
    expect(escalatedModelFor("openai", "Analyze the tradeoffs here")).toBe("gpt-4.1");
    expect(escalatedModelFor("anthropic", "Analyze the tradeoffs here")).toBe("claude-sonnet-4-6");
    expect(escalatedModelFor("xai", "Analyze the tradeoffs here")).toBe("grok-3");
  });

  test("an ordinary turn stays on the default (cheap) model", () => {
    expect(escalatedModelFor("gemini", "hi there")).toBe(modelFor("gemini"));
    expect(escalatedModelFor("openai", "hi there")).toBe(modelFor("openai"));
  });

  test("KEYSTONE_MODEL_ESCALATION=0 pins everything to the default tier", () => {
    process.env.KEYSTONE_MODEL_ESCALATION = "0";
    expect(escalatedModelFor("gemini", "Analyze the tradeoffs here")).toBe(modelFor("gemini"));
  });

  test("an operator's env-pinned model is never overridden", () => {
    process.env.GEMINI_MODEL = "gemini-2.5-flash-lite";
    expect(escalatedModelFor("gemini", "Analyze the tradeoffs here")).toBe("gemini-2.5-flash-lite");
  });

  test("a provider with no deep model defined falls back to its default", () => {
    expect(escalatedModelFor("cohere", "Analyze the tradeoffs here")).toBe(modelFor("cohere"));
  });

  test("EVERY deep model is on the verified allowlist (never route to an unchecked id)", () => {
    for (const [provider, deep] of Object.entries(DEEP_MODELS)) {
      expect(isAllowedModel(provider, deep)).toBe(true);
    }
  });
});
