"use strict";

/**
 * test/route-contract.test.js
 *
 * The one routing contract (ADR-0009): coding is cloud-primary when a cloud key
 * is reachable; local is the offline backstop; explicit user choice wins; the
 * escape hatch CODING_LOCAL_FIRST=1 restores local-first. These assertions also
 * pin the behavior-preserving extraction from lib/stream-chat.js.
 *
 * Zero-dep — run with:  node --test apps/lantern-garage/test/route-contract.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { resolveCodingRoute, prefersAnthropic, kernelCodingLocalFirst } = require("../lib/route-contract");

const ENV_ANTHROPIC = { ANTHROPIC_API_KEY: "k" };
const ENV_OPENAI = { OPENAI_API_KEY: "k" };
const ENV_BOTH = { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" };
const ENV_NONE = {};

test("rule 1: explicit user provider is never overridden", () => {
  const out = resolveCodingRoute({
    requestedProvider: "ollama",
    isCodingIntent: true,
    autoHintProvider: "ollama",
    env: ENV_ANTHROPIC,
  });
  assert.equal(out, "ollama");
});

test("rule 3: coding intent leads with Anthropic when key present", () => {
  const out = resolveCodingRoute({
    requestedProvider: null,
    isCodingIntent: true,
    autoHintProvider: "ollama",
    env: ENV_ANTHROPIC,
  });
  assert.equal(out, "anthropic");
});

test("rule 3: falls back to OpenAI when only OpenAI key present", () => {
  const out = resolveCodingRoute({
    requestedProvider: null,
    isCodingIntent: true,
    autoHintProvider: null,
    env: ENV_OPENAI,
  });
  assert.equal(out, "openai");
});

test("rule 3: Anthropic preferred over OpenAI when both present", () => {
  const out = resolveCodingRoute({
    requestedProvider: null,
    isCodingIntent: true,
    autoHintProvider: "local",
    env: ENV_BOTH,
  });
  assert.equal(out, "anthropic");
});

test("rule 4: no cloud key -> local hint preserved (offline backstop)", () => {
  const out = resolveCodingRoute({
    requestedProvider: null,
    isCodingIntent: true,
    autoHintProvider: "ollama",
    env: ENV_NONE,
  });
  assert.equal(out, "ollama");
});

test("does not override an existing cloud hint", () => {
  const out = resolveCodingRoute({
    requestedProvider: null,
    isCodingIntent: true,
    autoHintProvider: "gemini",
    env: ENV_ANTHROPIC,
  });
  assert.equal(out, "gemini");
});

test("non-coding turn is untouched", () => {
  const out = resolveCodingRoute({
    requestedProvider: null,
    isCodingIntent: false,
    autoHintProvider: "ollama",
    env: ENV_ANTHROPIC,
  });
  assert.equal(out, "ollama");
});

test("escape hatch: CODING_LOCAL_FIRST=1 keeps local for coding", () => {
  const out = resolveCodingRoute({
    requestedProvider: null,
    isCodingIntent: true,
    autoHintProvider: "ollama",
    env: { ANTHROPIC_API_KEY: "k", CODING_LOCAL_FIRST: "1" },
  });
  assert.equal(out, "ollama");
});

test("null hint with no key resolves to null (not undefined)", () => {
  const out = resolveCodingRoute({
    requestedProvider: null,
    isCodingIntent: true,
    autoHintProvider: null,
    env: ENV_NONE,
  });
  assert.equal(out, null);
});

test("kernelCodingLocalFirst: default true (local-first verify-gated)", () => {
  assert.equal(kernelCodingLocalFirst({ env: {} }), true);
});

test("kernelCodingLocalFirst: KEYSTONE_LOCAL_FIRST=0 forces cloud", () => {
  assert.equal(kernelCodingLocalFirst({ env: { KEYSTONE_LOCAL_FIRST: "0" } }), false);
});

test("kernelCodingLocalFirst: rolloverMode 'default' forces local-first even with =0", () => {
  assert.equal(
    kernelCodingLocalFirst({ rolloverMode: "default", env: { KEYSTONE_LOCAL_FIRST: "0" } }),
    true,
  );
});

test("prefersAnthropic mirrors the resolved route", () => {
  assert.equal(
    prefersAnthropic({ requestedProvider: null, isCodingIntent: true, autoHintProvider: "ollama", env: ENV_ANTHROPIC }),
    true,
  );
  assert.equal(
    prefersAnthropic({ requestedProvider: null, isCodingIntent: true, autoHintProvider: "ollama", env: ENV_NONE }),
    false,
  );
});
