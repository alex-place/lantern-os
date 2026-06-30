// Voice dictation — pure helpers for the chat mic (#1607).
//
// The DOM / SpeechRecognition wiring lives in dream-chat.js; the decision logic that
// is worth testing lives here as side-effect-free functions, exported for both the
// browser (window.VoiceDictation) and Node (module.exports) so it can be unit-tested
// without a browser. Keeping it pure is what makes the "append mode", "preserve typed
// text", "recovery after unexpected stop", and "error handling" requirements testable.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.VoiceDictation = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  // Compose the composer value from the text that was already typed (base), the
  // finalized transcript so far (accumulated), and the in-progress words (interim).
  // Joined with single spaces, empties dropped — so existing typed text is preserved
  // and dictation is APPENDED to it rather than overwriting it.
  function mergeTranscript(base, accumulated, interim) {
    return [base, accumulated, interim]
      .map(function (s) { return (s == null ? "" : String(s)).trim(); })
      .filter(function (s) { return s.length > 0; })
      .join(" ");
  }

  // User-facing messages for the SpeechRecognition error codes. Empty string = stay
  // silent (e.g. a deliberate user abort needs no error banner).
  var VOICE_ERROR_MESSAGES = {
    "not-allowed": "🎙️ Microphone blocked. Allow mic access for this site (lock icon in the address bar), then try again.",
    "service-not-allowed": "🎙️ Microphone blocked by the browser or OS. Allow mic access and retry.",
    "audio-capture": "🎙️ No microphone found — check that one is connected and enabled.",
    "no-speech": "🎙️ Didn't catch any speech. Tap the mic and try again.",
    "network": "🎙️ Speech service unreachable. Check your connection and retry.",
    "aborted": ""
  };

  function voiceErrorMessage(code) {
    if (Object.prototype.hasOwnProperty.call(VOICE_ERROR_MESSAGES, code)) {
      return VOICE_ERROR_MESSAGES[code];
    }
    return "🎙️ Voice input error: " + (code || "unknown");
  }

  // Hard failures must NOT trigger an automatic restart — re-starting on a denied
  // permission or a missing mic would spin forever. Everything else (notably the
  // "no-speech" the engine throws on a natural pause in continuous mode) is safe to
  // recover from, as long as the user didn't tap stop.
  var HARD_STOP = { "not-allowed": 1, "service-not-allowed": 1, "audio-capture": 1, "network": 1 };

  function shouldAutoRecover(code, userStopped) {
    if (userStopped) return false;
    return !HARD_STOP[code];
  }

  // Detection of native support — pure given a window-like object, so it's testable.
  function isSupported(win) {
    return !!(win && (win.SpeechRecognition || win.webkitSpeechRecognition));
  }

  return {
    mergeTranscript: mergeTranscript,
    voiceErrorMessage: voiceErrorMessage,
    shouldAutoRecover: shouldAutoRecover,
    isSupported: isSupported,
    VOICE_ERROR_MESSAGES: VOICE_ERROR_MESSAGES
  };
});
