/**
 * test/provider-pin-backstop.test.js
 *
 * A pinned provider must LEAD but BACKSTOP through the rest of the chain, so one
 * provider being rate-limited / down doesn't dead-end the turn. Auto mode and the
 * no-key case are unchanged.
 *
 * Run with: npx jest test/provider-pin-backstop.test.js
 */
const { buildBrainOrder } = require("../lib/stream-chat/provider-order");

const ALL = () => { process.env.ANTHROPIC_API_KEY = "x"; process.env.GEMINI_API_KEY = "x"; process.env.OPENAI_API_KEY = "x"; process.env.XAI_API_KEY = "x"; };
beforeEach(ALL);
afterEach(() => { delete process.env.GEMINI_API_KEY; });

describe("buildBrainOrder pinned-provider backstop", () => {
  test("pinned provider leads, rest of the chain backstops", () => {
    expect(buildBrainOrder({ requestedProvider: "gemini" })).toEqual(["gemini", "anthropic", "openai", "xai", "ollama"]);
  });
  test("explicit gemini-<model> normalizes to gemini and still backstops", () => {
    expect(buildBrainOrder({ requestedProvider: "gemini-3.1-flash-lite" })[0]).toBe("gemini");
    expect(buildBrainOrder({ requestedProvider: "gemini-3.1-flash-lite" })).toContain("anthropic");
  });
  test("a pinned provider with no key is dropped; backstop remains", () => {
    delete process.env.GEMINI_API_KEY;
    const order = buildBrainOrder({ requestedProvider: "gemini" });
    expect(order).not.toContain("gemini");
    expect(order[0]).toBe("anthropic");
  });
  test("auto mode still leads with the brain hint", () => {
    expect(buildBrainOrder({ hintProvider: "anthropic" })[0]).toBe("anthropic");
  });
});

describe("KEYSTONE_PREFERRED_PROVIDER (Auto-mode lead bias)", () => {
  afterEach(() => { delete process.env.KEYSTONE_PREFERRED_PROVIDER; });
  test("preferred provider leads Auto mode, brain hint + chain backstop", () => {
    process.env.KEYSTONE_PREFERRED_PROVIDER = "gemini";
    expect(buildBrainOrder({ hintProvider: "anthropic" })).toEqual(["gemini", "anthropic", "openai", "xai", "ollama"]);
  });
  test("an explicit pin still overrides the preference", () => {
    process.env.KEYSTONE_PREFERRED_PROVIDER = "gemini";
    expect(buildBrainOrder({ requestedProvider: "claude" })[0]).toBe("anthropic");
  });
  test("preferred provider with no key is dropped, chain still answers", () => {
    process.env.KEYSTONE_PREFERRED_PROVIDER = "gemini";
    delete process.env.GEMINI_API_KEY;
    expect(buildBrainOrder({ hintProvider: "anthropic" })[0]).toBe("anthropic");
  });
});
