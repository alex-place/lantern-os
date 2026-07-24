// #1607 — voice dictation core logic. The DOM / SpeechRecognition wiring lives in
// dream-chat.js; the testable decisions (append/preserve, error mapping, recovery,
// support detection) live in public/js/voice-dictation.js and are exercised here.
//
// Run: node test/voice-dictation.test.js
const assert = require("assert");
const VD = require("../public/js/voice-dictation.js");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

// ── mergeTranscript: preserve typed text + append mode ──────────────────────────
check("dictation appends to existing typed text", () =>
  assert.strictEqual(VD.mergeTranscript("Hello world", "how are you", ""), "Hello world how are you"));

check("empty base → just the transcript", () =>
  assert.strictEqual(VD.mergeTranscript("", "testing one two", ""), "testing one two"));

check("interim words are shown live after finalized", () =>
  assert.strictEqual(VD.mergeTranscript("note:", "first part", "second pa"), "note: first part second pa"));

check("no double spaces / no leading space when segments empty", () =>
  assert.strictEqual(VD.mergeTranscript("", "", "hi"), "hi"));

check("whitespace-only segments are dropped", () =>
  assert.strictEqual(VD.mergeTranscript("base", "   ", "  "), "base"));

check("null / undefined segments are safe", () =>
  assert.strictEqual(VD.mergeTranscript(null, undefined, "ok"), "ok"));

check("multiple sessions append (base already holds prior dictation)", () => {
  const afterFirst = VD.mergeTranscript("", "first session", "");
  const afterSecond = VD.mergeTranscript(afterFirst, "second session", "");
  assert.strictEqual(afterSecond, "first session second session");
});

// ── voiceErrorMessage: meaningful messages, silent on deliberate abort ──────────
check("not-allowed → permission message", () =>
  assert.ok(/Microphone blocked/.test(VD.voiceErrorMessage("not-allowed"))));

check("audio-capture → no-mic message", () =>
  assert.ok(/No microphone found/.test(VD.voiceErrorMessage("audio-capture"))));

check("aborted → empty (no banner for a deliberate stop)", () =>
  assert.strictEqual(VD.voiceErrorMessage("aborted"), ""));

check("unknown code → generic fallback, never throws", () =>
  assert.ok(/Voice input error/.test(VD.voiceErrorMessage("some-weird-code"))));

// ── shouldAutoRecover: recover from soft stops, never loop on hard failures ─────
check("no-speech (pause) is recoverable", () =>
  assert.strictEqual(VD.shouldAutoRecover("no-speech", false), true));

check("clean end (no error) is recoverable in continuous mode", () =>
  assert.strictEqual(VD.shouldAutoRecover("", false), true));

check("user stop is never auto-recovered", () =>
  assert.strictEqual(VD.shouldAutoRecover("no-speech", true), false));

for (const hard of ["not-allowed", "service-not-allowed", "audio-capture", "network"]) {
  check(`hard failure '${hard}' is NOT auto-recovered`, () =>
    assert.strictEqual(VD.shouldAutoRecover(hard, false), false));
}

// ── isSupported: native API detection ──────────────────────────────────────────
check("isSupported true when SpeechRecognition present", () =>
  assert.strictEqual(VD.isSupported({ SpeechRecognition: function () {} }), true));

check("isSupported true for webkit-prefixed API", () =>
  assert.strictEqual(VD.isSupported({ webkitSpeechRecognition: function () {} }), true));

check("isSupported false on an unsupported browser", () =>
  assert.strictEqual(VD.isSupported({}), false));

check("isSupported false / safe on null window", () =>
  assert.strictEqual(VD.isSupported(null), false));

if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
process.stdout.write("\nall voice-dictation checks passed\n");
