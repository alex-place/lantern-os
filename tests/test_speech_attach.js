// Tests for the A3→job-worker wiring helper: maybeAttachSpeech must be a strict
// no-op when disabled or when transcription fails/yields nothing, and attach only
// real measured features. Standalone: `node tests/test_speech_attach.js`.

"use strict";

const assert = require("assert");
const { maybeAttachSpeech } = require("../apps/lantern-garage/lib/speech-features");

let passed = 0;
function test(name, fn) {
  const run = fn();
  return Promise.resolve(run)
    .then(() => { passed++; console.log(`  ok  - ${name}`); })
    .catch((err) => { console.error(`  FAIL - ${name}\n        ${err.message}`); process.exitCode = 1; });
}

const fakeTimeline = () => ({ metadata: { version: "8.0" } });
const measured = { measured: true, hookStyle: "question", wordsPerSec: 1.2, ctaPresent: true };

(async () => {
  await test("disabled (default) → no-op, timeline untouched", async () => {
    const tl = fakeTimeline();
    const out = await maybeAttachSpeech(tl, "v.mp4", 20, { enabled: false });
    assert.strictEqual(out, null);
    assert.strictEqual(tl.metadata.speech, undefined);
  });

  await test("enabled + measured transcript → attaches to metadata.speech", async () => {
    const tl = fakeTimeline();
    const out = await maybeAttachSpeech(tl, "v.mp4", 20, { enabled: true, transcribe: async () => measured });
    assert.deepStrictEqual(out, measured);
    assert.deepStrictEqual(tl.metadata.speech, measured);
  });

  await test("enabled but transcriber THROWS → non-fatal, timeline untouched", async () => {
    const tl = fakeTimeline();
    const out = await maybeAttachSpeech(tl, "v.mp4", 20, {
      enabled: true, transcribe: async () => { throw new Error("whisper missing"); },
    });
    assert.strictEqual(out, null);
    assert.strictEqual(tl.metadata.speech, undefined);
  });

  await test("enabled but transcript not measured → not attached", async () => {
    const tl = fakeTimeline();
    const out = await maybeAttachSpeech(tl, "v.mp4", 20, {
      enabled: true, transcribe: async () => ({ measured: false }),
    });
    assert.strictEqual(out, null);
    assert.strictEqual(tl.metadata.speech, undefined);
  });

  console.log(`\n${passed} checks passed.`);
})();
