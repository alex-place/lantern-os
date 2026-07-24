// #2757 — schema-validated structured output. The extract/validate/repair core is
// pure and provider-agnostic; it's locked down here (the model I/O + repair loop
// live one layer up in the chat path).
//
// Run: node test/structured-output.test.js
const assert = require("assert");
const {
  extractJson, validateSchema, parseObject, schemaHint, buildRepairInstruction, wantsStructured,
} = require("../lib/structured-output");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

// ── extractJson ──────────────────────────────────────────────────────────────
check("plain JSON object", () => assert.deepStrictEqual(extractJson('{"a":1}').value, { a: 1 }));
check("JSON inside a ```json fence", () =>
  assert.deepStrictEqual(extractJson("Here you go:\n```json\n{\"a\":1}\n```\nHope that helps").value, { a: 1 }));
check("JSON object embedded in prose", () =>
  assert.deepStrictEqual(extractJson("Sure — {\"name\":\"Ada\",\"n\":2} — done").value, { name: "Ada", n: 2 }));
check("JSON array island", () =>
  assert.deepStrictEqual(extractJson("result: [1,2,3] end").value, [1, 2, 3]));
check("brace inside a string doesn't break balancing", () =>
  assert.deepStrictEqual(extractJson('{"s":"a } b { c"}').value, { s: "a } b { c" }));
check("nested objects balance correctly", () =>
  assert.deepStrictEqual(extractJson('prefix {"a":{"b":[1,{"c":2}]}} suffix').value, { a: { b: [1, { c: 2 }] } }));
check("repairs trailing commas", () =>
  assert.deepStrictEqual(extractJson('{"a":1,"b":2,}').value, { a: 1, b: 2 }));
check("repairs smart quotes", () =>
  assert.deepStrictEqual(extractJson('{“a”:1}').value, { a: 1 }));
check("no JSON → null", () => assert.strictEqual(extractJson("just some prose, no data"), null));
check("empty → null", () => assert.strictEqual(extractJson("   "), null));

// ── validateSchema ───────────────────────────────────────────────────────────
const personSchema = {
  type: "object",
  required: ["name", "age"],
  properties: { name: { type: "string" }, age: { type: "integer" }, tags: { type: "array", items: { type: "string" } } },
};
check("valid object → no errors", () =>
  assert.deepStrictEqual(validateSchema(personSchema, { name: "Ada", age: 36, tags: ["math"] }, ""), []));
check("missing required field → error", () => {
  const e = validateSchema(personSchema, { name: "Ada" }, "");
  assert.ok(e.some((x) => /missing required property 'age'/.test(x)), e.join("|"));
});
check("wrong scalar type → error", () => {
  const e = validateSchema(personSchema, { name: "Ada", age: "old" }, "");
  assert.ok(e.some((x) => /expected integer, got string/.test(x)), e.join("|"));
});
check("integer rejects float", () => {
  const e = validateSchema({ type: "integer" }, 3.5, "");
  assert.ok(e.length === 1 && /expected integer/.test(e[0]));
});
check("nested array item type checked", () => {
  const e = validateSchema(personSchema, { name: "Ada", age: 1, tags: ["ok", 5] }, "");
  assert.ok(e.some((x) => /tags\[1\]: expected string/.test(x)), e.join("|"));
});
check("enum enforced", () => {
  const e = validateSchema({ enum: ["red", "green"] }, "blue", "");
  assert.ok(e.length === 1 && /must be one of/.test(e[0]));
});
check("additionalProperties:false rejects extras", () => {
  const s = { type: "object", additionalProperties: false, properties: { a: { type: "number" } } };
  const e = validateSchema(s, { a: 1, b: 2 }, "");
  assert.ok(e.some((x) => /unexpected property 'b'/.test(x)), e.join("|"));
});
check("number min/max enforced", () => {
  assert.deepStrictEqual(validateSchema({ type: "number", minimum: 0, maximum: 10 }, 5, ""), []);
  assert.ok(validateSchema({ type: "number", minimum: 0 }, -1, "").length === 1);
});
check("null type distinguished from object", () => {
  const e = validateSchema({ type: "object" }, null, "");
  assert.ok(e.some((x) => /expected object, got null/.test(x)));
});

// ── parseObject (end-to-end extract + validate) ──────────────────────────────
check("parseObject: fenced valid JSON → ok", () => {
  const r = parseObject("```json\n{\"name\":\"Ada\",\"age\":36}\n```", personSchema);
  assert.ok(r.ok, r.errors.join("|"));
  assert.deepStrictEqual(r.value, { name: "Ada", age: 36 });
});
check("parseObject: recovered but invalid → ok:false with errors", () => {
  const r = parseObject('{"name":"Ada"}', personSchema);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((x) => /missing required property 'age'/.test(x)));
});
check("parseObject: no JSON at all → ok:false", () => {
  const r = parseObject("I can't do that", personSchema);
  assert.strictEqual(r.ok, false);
  assert.ok(/no JSON/.test(r.errors[0]));
});

// ── prompt helpers ───────────────────────────────────────────────────────────
check("schemaHint embeds the schema + a no-prose instruction", () => {
  const h = schemaHint(personSchema);
  assert.ok(h.includes(JSON.stringify(personSchema)));
  assert.ok(/only/i.test(h) && /json/i.test(h));
});
check("buildRepairInstruction lists errors + schema + prior text", () => {
  const msg = buildRepairInstruction(personSchema, '{"name":"Ada"}', ["(root): missing required property 'age'"]);
  assert.ok(msg.includes("missing required property 'age'"));
  assert.ok(msg.includes(JSON.stringify(personSchema)));
  assert.ok(msg.includes('{"name":"Ada"}'));
});

// ── wantsStructured detection ────────────────────────────────────────────────
check("detects 'return valid JSON'", () => assert.strictEqual(wantsStructured("Return valid JSON with the fields"), true));
check("detects 'as a JSON object'", () => assert.strictEqual(wantsStructured("give me the answer as a JSON object"), true));
check("detects 'strict json'", () => assert.strictEqual(wantsStructured("strictly JSON please"), true));
check("plain prose request → false", () => assert.strictEqual(wantsStructured("what's the capital of France?"), false));
check("mentions json casually but not a shape request → false", () =>
  assert.strictEqual(wantsStructured("i love the movie json bourne"), false));

process.stdout.write(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
