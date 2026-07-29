/**
 * test/tool-arg-repair.test.js
 *
 * #3068 — tool-call argument repair. _validateArgs (#2753) already REJECTS a malformed call,
 * but that costs the model a whole step to learn about a mistake that is usually mechanical:
 * arguments sent as a JSON string, "5" instead of 5, a key cased differently than the schema,
 * a lone value where a list is wanted. _repairArgs fixes those deterministically (no second
 * model round-trip, unlike AI SDK's experimental_repairToolCall).
 *
 * The contract these tests pin down:
 *   - repairs are UNAMBIGUOUS only; anything guessy is left for validation to reject,
 *   - a repair is never silent (it is always reported in `repairs`),
 *   - semantics are never changed (no clobbering real values, no resolving ambiguity).
 *
 * Run with: npx jest test/tool-arg-repair.test.js
 */
const { _repairArgs, _validateArgs } = require("../lib/tool-runner");

const schema = {
  type: "object",
  properties: {
    query: { type: "string" },
    maxResults: { type: "integer" },
    ratio: { type: "number" },
    deep: { type: "boolean" },
    tags: { type: "array" },
    options: { type: "object" },
  },
  required: ["query"],
};
// A repair is only worth anything if the result actually passes validation.
const repairAndValidate = (input) => {
  const { input: out, repairs } = _repairArgs(schema, input);
  return { out, repairs, valid: _validateArgs(schema, out) === null };
};

describe("mechanical repairs that make an invalid call valid", () => {
  test("arguments arriving as a JSON string are parsed", () => {
    const { out, repairs, valid } = repairAndValidate('{"query":"kyoto","maxResults":3}');
    expect(valid).toBe(true);
    expect(out).toEqual({ query: "kyoto", maxResults: 3 });
    expect(repairs.join()).toMatch(/JSON-string/);
  });

  test("stringified numbers/booleans are coerced to their schema type", () => {
    const { out, valid } = repairAndValidate({ query: "x", maxResults: "5", ratio: "0.25", deep: "true" });
    expect(valid).toBe(true);
    expect(out.maxResults).toBe(5);
    expect(out.ratio).toBe(0.25);
    expect(out.deep).toBe(true);
  });

  test("key casing / snake-vs-camel is mapped onto the schema's key", () => {
    const { out, repairs, valid } = repairAndValidate({ Query: "x", max_results: "2" });
    expect(valid).toBe(true);
    expect(out).toEqual({ query: "x", maxResults: 2 });
    expect(repairs.join()).toMatch(/renamed/);
  });

  test("a lone value where an array is wanted is wrapped", () => {
    const { out, valid } = repairAndValidate({ query: "x", tags: "news" });
    expect(valid).toBe(true);
    expect(out.tags).toEqual(["news"]);
  });

  test("a JSON string for an array/object property is parsed", () => {
    const { out, valid } = repairAndValidate({ query: "x", tags: '["a","b"]', options: '{"k":1}' });
    expect(valid).toBe(true);
    expect(out.tags).toEqual(["a", "b"]);
    expect(out.options).toEqual({ k: 1 });
  });

  test("a redundant {input:{…}} envelope is unwrapped", () => {
    const { out, repairs, valid } = repairAndValidate({ input: { query: "x" } });
    expect(valid).toBe(true);
    expect(out).toEqual({ query: "x" });
    expect(repairs.join()).toMatch(/unwrapped/);
  });
});

describe("refuses to guess", () => {
  test("a genuinely missing required arg is NOT invented", () => {
    const { out, valid } = repairAndValidate({ maxResults: 3 });
    expect(valid).toBe(false);              // still rejected, as it should be
    expect(out.query).toBeUndefined();
  });

  test("a non-numeric string is not forced into a number", () => {
    const { valid } = repairAndValidate({ query: "x", maxResults: "many" });
    expect(valid).toBe(false);
  });

  test("an ambiguous alias pair is left alone rather than picking one", () => {
    // Both normalize to "maxresults" — choosing either could silently drop the other.
    const { out } = repairAndValidate({ query: "x", max_results: 1, MaxResults: 2 });
    expect(out.maxResults).toBeUndefined();
  });

  test("an alias never clobbers an explicitly-provided correct key", () => {
    const { out } = repairAndValidate({ query: "real", Query: "alias" });
    expect(out.query).toBe("real");
  });

  test("an envelope key that doesn't hold this tool's args is not unwrapped", () => {
    const { out } = repairAndValidate({ input: { unrelated: 1 } });
    expect(out).toEqual({ input: { unrelated: 1 } });
  });
});

describe("no-op safety", () => {
  test("an already-valid call is returned unchanged with no repairs", () => {
    const good = { query: "x", maxResults: 2, tags: ["a"] };
    const { out, repairs, valid } = repairAndValidate(good);
    expect(valid).toBe(true);
    expect(out).toEqual(good);
    expect(repairs).toEqual([]);
  });

  test("unknown properties are passed through untouched (loose schemas still work)", () => {
    const { out } = repairAndValidate({ query: "x", somethingElse: 42 });
    expect(out.somethingElse).toBe(42);
  });

  test("null / undefined / non-object input never throws", () => {
    expect(() => _repairArgs(schema, null)).not.toThrow();
    expect(() => _repairArgs(schema, undefined)).not.toThrow();
    expect(() => _repairArgs(schema, "not json")).not.toThrow();
    expect(() => _repairArgs(null, { a: 1 })).not.toThrow();
  });
});
