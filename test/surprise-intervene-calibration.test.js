"use strict";
// #1940 (ADR-0017 "+ calibration") — the intervene trigger threshold is now PER-MODEL
// (derived from token-surprise.calibrationFor().center) instead of a fixed 5 bits, so the
// controller actually fires on small local models whose per-token surprise runs < 1 bit.
// Pure JS, no model/torch needed — runs on any box.
const assert = require("assert");
const si = require("../lib/surprise-intervene");

let pass = 0;
function ok(desc, cond) { assert.ok(cond, desc); console.log("  ok  - " + desc); pass++; }

// isolate calibration: preserve + clear the env override that would otherwise win
const _envBits = process.env.SURPRISE_INTERVENE_BITS;
delete process.env.SURPRISE_INTERVENE_BITS;

// ── calibratedThresholdBits ─────────────────────────────────────────────────
ok("unknown model → default center 5 (backward-compatible)",
   si.calibratedThresholdBits(undefined) === 5);
ok("qwen2.5-coder:1.5b → its calibrated midpoint (~1.09 bits)",
   Math.abs(si.calibratedThresholdBits("qwen2.5-coder:1.5b") - 1.092) < 1e-6);
ok("mistral → its calibrated midpoint (~0.34 bits)",
   Math.abs(si.calibratedThresholdBits("mistral") - 0.336) < 1e-6);
ok("model family base resolves (mistral:latest → mistral)",
   si.calibratedThresholdBits("mistral:latest") === si.calibratedThresholdBits("mistral"));

// ── the core fix: a small-model stream the fixed-5 threshold would MISS ──────
const stream = Array.from({ length: 16 }, (_, i) => ({ token: "x" + i, bits: 1.5 })); // window mean 1.5 bits
ok("fixed default (no model) → a 1.5-bit stream does NOT trigger (the bug)",
   si.findTriggerSpans(stream).length === 0);
ok("calibrated (qwen) → the SAME 1.5-bit stream DOES trigger (the fix)",
   si.findTriggerSpans(stream, { model: "qwen2.5-coder:1.5b" }).length === 1);

// ── override precedence ─────────────────────────────────────────────────────
process.env.SURPRISE_INTERVENE_BITS = "2";
ok("explicit env SURPRISE_INTERVENE_BITS wins over calibration",
   si.findTriggerSpans(stream, { model: "qwen2.5-coder:1.5b" }).length === 0);
delete process.env.SURPRISE_INTERVENE_BITS;
ok("explicit opts.thresholdBits still overrides (existing contract preserved)",
   si.findTriggerSpans(stream, { thresholdBits: 1.0 }).length === 1);

// restore env exactly
if (_envBits === undefined) delete process.env.SURPRISE_INTERVENE_BITS;
else process.env.SURPRISE_INTERVENE_BITS = _envBits;

console.log("\nall surprise-intervene calibration checks passed (" + pass + ")");
