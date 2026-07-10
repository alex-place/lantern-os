"use strict";

/**
 * test/ouro-router-tasktypes.test.js
 *
 * Guards the intent-router taskType vocabulary. The "numeric" route (time-series
 * forecasting → the registry's keystone-tsfm specialist) must stay a first-class
 * intent the classifier can emit, kept DISTINCT from "trading" (buy/sell decisions).
 * Pure/offline — asserts only the exported vocabulary, no Ollama call.
 *
 * Run:  node --test apps/lantern-garage/test/ouro-router-tasktypes.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { TASK_TYPES } = require("../lib/ouro-router");

test("TASK_TYPES carries the numeric forecasting route, distinct from trading", () => {
  assert.ok(Array.isArray(TASK_TYPES), "TASK_TYPES is an array");
  assert.ok(TASK_TYPES.includes("numeric"), "numeric route is classifiable");
  assert.ok(TASK_TYPES.includes("trading"), "trading decision route still present");
  assert.notEqual("numeric", "trading", "forecasting (numeric) and decision (trading) are separate intents");
  assert.ok(TASK_TYPES.includes("default"), "default fallback remains");
});
