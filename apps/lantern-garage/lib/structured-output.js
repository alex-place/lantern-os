"use strict";
/**
 * structured-output.js — schema-validated ("generateObject-style") output for the
 * chat path (#2757).
 *
 * THE PROBLEM
 * The chat only ever runs free-form text + `tool_choice:"auto"`. When the user asks
 * for a specific shape — strict JSON, a fixed set of fields, a clean table — it's
 * hit-or-miss whether the model returns exactly that. There is no schema-locked mode.
 *
 * THE APPROACH (provider-agnostic, no new dependency)
 * The reliable, portable path is extract → validate → repair, the same fallback the
 * Vercel AI SDK / Pydantic-AI use when a provider lacks native structured output:
 *   1. schemaHint(schema)       — a compact shape description to steer the FIRST reply.
 *   2. parseObject(text,schema) — pull the JSON out of the reply and validate it
 *                                 against the schema (recursive, hand-rolled — the repo
 *                                 has no ajv and deliberately hand-rolls validation,
 *                                 cf. tool-runner._validateArgs).
 *   3. buildRepairInstruction(…)— on failure, a correction turn the caller feeds back
 *                                 so the model self-corrects to the schema.
 * This works for EVERY provider (Anthropic / OpenAI / xAI / Cohere / Gemini) without
 * touching their transports; a provider's *native* response_schema can layer on top
 * later behind the same boundary without changing callers.
 *
 * Pure + synchronous + dependency-free on purpose: unit-tested in isolation
 * (test/structured-output.test.js). The I/O (calling the model, the repair round-trip)
 * lives one layer up in the chat path.
 */

// ── JSON extraction ──────────────────────────────────────────────────────────
// Models wrap JSON in prose and ```json fences, or emit smart quotes / trailing
// commas. Pull out the first balanced JSON value and repair the common lossy bits.
// Returns { value, raw } or null when no JSON value can be recovered.
function extractJson(text) {
  const s = String(text == null ? "" : text);
  if (!s.trim()) return null;

  // Prefer a fenced ```json … ``` block when present (most reliable island).
  const fence = s.match(/```(?:json|json5)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence && fence[1].trim()) candidates.push(fence[1].trim());

  // Otherwise (or additionally) scan for the first balanced { … } or [ … ] island.
  const island = firstBalancedIsland(s);
  if (island) candidates.push(island);
  candidates.push(s.trim()); // last resort: the whole string

  for (const c of candidates) {
    const parsed = tryParse(c);
    if (parsed !== undefined) return { value: parsed, raw: c };
  }
  return null;
}

// Scan for the first top-level balanced {…} or […] region, respecting strings so a
// brace inside a string literal doesn't throw off the depth count.
function firstBalancedIsland(s) {
  const open = s.search(/[[{]/);
  if (open < 0) return null;
  const openCh = s[open];
  const closeCh = openCh === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return s.slice(open, i + 1);
    }
  }
  return null;
}

function tryParse(raw) {
  try { return JSON.parse(raw); } catch { /* fall through to repair */ }
  const repaired = raw
    .replace(/[“”]/g, '"')   // smart double quotes → "
    .replace(/[‘’]/g, "'")   // smart single quotes → '
    .replace(/,\s*([}\]])/g, "$1");    // trailing commas before } or ]
  try { return JSON.parse(repaired); } catch { return undefined; }
}

// ── Recursive JSON-schema validation ─────────────────────────────────────────
// A pragmatic subset of JSON Schema sufficient for chat extraction shapes: type,
// required, properties, additionalProperties(bool), items, enum, min/max (numbers),
// minLength/maxLength (strings), minItems/maxItems (arrays). Returns string[] of
// human-readable errors ([] === valid). Kept lenient: unknown keywords are ignored
// rather than erroring, so a loose schema still passes real data.
function validateSchema(schema, value, path) {
  const at = path || "(root)";
  const errs = [];
  if (!schema || typeof schema !== "object") return errs;

  if (schema.enum && Array.isArray(schema.enum)) {
    const ok = schema.enum.some((e) => deepEqual(e, value));
    if (!ok) errs.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`);
  }

  const want = schema.type;
  if (want) {
    const actual = jsonType(value);
    const typeOk = want === "integer"
      ? (actual === "number" && Number.isInteger(value))
      : actual === want;
    if (!typeOk) {
      errs.push(`${at}: expected ${want}, got ${actual}`);
      return errs; // shape is wrong — nested checks would be noise
    }
  }

  if (jsonType(value) === "object") {
    const props = schema.properties || {};
    for (const req of (schema.required || [])) {
      if (value[req] === undefined) errs.push(`${at}: missing required property '${req}'`);
    }
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) errs.push(...validateSchema(props[k], v, `${at}.${k}`));
      else if (schema.additionalProperties === false) {
        errs.push(`${at}: unexpected property '${k}'`);
      }
    }
  }

  if (jsonType(value) === "array") {
    if (schema.minItems != null && value.length < schema.minItems) errs.push(`${at}: needs >= ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errs.push(`${at}: needs <= ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errs.push(...validateSchema(schema.items, v, `${at}[${i}]`)));
  }

  if (jsonType(value) === "string") {
    if (schema.minLength != null && value.length < schema.minLength) errs.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) errs.push(`${at}: longer than ${schema.maxLength}`);
  }

  if (jsonType(value) === "number") {
    if (schema.minimum != null && value < schema.minimum) errs.push(`${at}: below minimum ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errs.push(`${at}: above maximum ${schema.maximum}`);
  }

  return errs;
}

function jsonType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // "object" | "string" | "number" | "boolean" | ...
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (jsonType(a) !== jsonType(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (a && typeof a === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

// ── High-level helpers ───────────────────────────────────────────────────────
// Extract + validate a model reply against `schema`.
// → { ok, value, errors, raw }.  ok === true iff JSON was recovered AND valid.
function parseObject(text, schema) {
  const got = extractJson(text);
  if (!got) return { ok: false, value: null, errors: ["no JSON object/array found in the output"], raw: null };
  const errors = validateSchema(schema, got.value, "");
  return { ok: errors.length === 0, value: got.value, errors, raw: got.raw };
}

// A compact, model-facing description of the target shape, injected into the system
// prompt so the FIRST reply is likely already correct (fewer repair round-trips).
function schemaHint(schema) {
  return [
    "Respond with ONLY a single JSON value that conforms to this JSON Schema — no prose,",
    "no markdown, no code fence, no commentary before or after:",
    JSON.stringify(schema),
  ].join("\n");
}

// The correction turn fed back to the model when its output failed validation.
function buildRepairInstruction(schema, prevText, errors) {
  return [
    "Your previous response did not match the required JSON Schema.",
    "Errors:",
    ...errors.map((e) => `  - ${e}`),
    "",
    "Required schema:",
    JSON.stringify(schema),
    "",
    "Previous response:",
    String(prevText == null ? "" : prevText).slice(0, 4000),
    "",
    "Return ONLY the corrected JSON value — no prose, no markdown fence.",
  ].join("\n");
}

// ── Request-side detection ───────────────────────────────────────────────────
// Heuristic: does this user turn *ask* for a fixed shape? Used to auto-engage the
// structured path when no explicit schema was supplied by an API caller. Deliberately
// conservative — a false negative just falls back to today's free-text behaviour.
function wantsStructured(message) {
  const m = String(message || "").toLowerCase();
  return /\b(as|in|return|give me|output|respond with|reply with|format(?:ted)? as)\b[^.]*\b(json|a json object|valid json|json array)\b/.test(m)
    || /\bjson (only|format|object|array|schema)\b/.test(m)
    || /\bstrict(?:ly)? json\b/.test(m);
}

module.exports = {
  extractJson,
  validateSchema,
  parseObject,
  schemaHint,
  buildRepairInstruction,
  wantsStructured,
  // exported for reuse/testing
  firstBalancedIsland,
  deepEqual,
};
