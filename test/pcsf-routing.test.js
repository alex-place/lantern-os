/**
 * test/pcsf-routing.test.js
 *
 * The provider router reorders the static chain by the live PCSF ranking
 * (data/pcsf/provider.pcsf.json -> routing.by_task_type). PCSF is the source of
 * truth for order; the static chain is the candidate set + cold fallback.
 *
 * Run with: npx jest test/pcsf-routing.test.js
 */

const { orderChainByPcsf } = require("../lib/provider-router");

const CHAIN = [
  { provider: "ollama", models: ["x"] },
  { provider: "mistral", models: ["x"] },
  { provider: "anthropic", models: ["x"] },
  { provider: "openai", models: ["x"] },
];

describe("orderChainByPcsf", () => {
  test("reorders the chain to follow the PCSF ranking for the task type", () => {
    const byTask = { coding: ["anthropic", "openai", "ollama"] };
    const { chain, ranked } = orderChainByPcsf(CHAIN, "coding", byTask);
    expect(ranked).toBe(true);
    // anthropic/openai/ollama ranked; mistral (absent from PCSF) keeps position after ranked ones
    expect(chain.map((s) => s.provider)).toEqual(["anthropic", "openai", "ollama", "mistral"]);
  });

  test("falls back to byTask.default when the task type has no entry", () => {
    const byTask = { default: ["openai", "anthropic"] };
    const { chain, ranked } = orderChainByPcsf(CHAIN, "creative", byTask);
    expect(ranked).toBe(true);
    expect(chain[0].provider).toBe("openai");
    expect(chain[1].provider).toBe("anthropic");
  });

  test("returns the chain unchanged (ranked=false) when no ranking is present", () => {
    const { chain, ranked } = orderChainByPcsf(CHAIN, "coding", null);
    expect(ranked).toBe(false);
    expect(chain).toBe(CHAIN);
  });

  test("does not mutate the input chain", () => {
    const before = CHAIN.map((s) => s.provider);
    orderChainByPcsf(CHAIN, "coding", { coding: ["openai"] });
    expect(CHAIN.map((s) => s.provider)).toEqual(before);
  });
});
