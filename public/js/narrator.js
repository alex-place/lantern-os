/**
 * narrator.js — drop-in "read this page aloud" widget.
 *
 * Self-contained, no dependencies. Uses the browser Web Speech API
 * (window.speechSynthesis). Renders a floating control bar plus an
 * on-screen caption that shows the sentence currently being read.
 *
 * Usage: just include <script src="/js/narrator.js" defer></script>.
 * By default it narrates the first match of:
 *   [data-narrate] → main → .md-page → article → .content → body
 * Override by adding the attribute  data-narrate  to the element you
 * want read, or set  window.NARRATOR_TARGET = "#some-selector"  before load.
 *
 * Why sentence chunking: Chrome silently truncates a single utterance past
 * ~32k chars and can stall on very long text. We split into sentences and
 * queue them so any length works and we can highlight progress.
 */
(function () {
  "use strict";

  var synth = window.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
    // No support → do nothing (graceful degradation).
    console.info("[narrator] speechSynthesis unavailable — narrator disabled.");
    return;
  }

  var LS_RATE = "narrator.rate";
  var LS_VOICE = "narrator.voice";

  var state = {
    chunks: [],
    index: 0,
    playing: false,
    paused: false,
    voices: [],
    voiceURI: localStorage.getItem(LS_VOICE) || "",
    rate: parseFloat(localStorage.getItem(LS_RATE) || "1") || 1,
  };

  // ── Pick the element to read ──────────────────────────────────────────
  function findTarget() {
    var override = window.NARRATOR_TARGET;
    var order = override
      ? [override]
      : ["[data-narrate]", "main", ".md-page", "article", ".content", "body"];
    for (var i = 0; i < order.length; i++) {
      var el = document.querySelector(order[i]);
      if (el && el.innerText && el.innerText.trim().length > 0) return el;
    }
    return document.body;
  }

  // ── Split readable text into sentence-sized chunks ────────────────────
  function buildChunks(el) {
    // Clone so we can strip things we should not read aloud.
    var clone = el.cloneNode(true);
    clone
      .querySelectorAll("script,style,noscript,.narrator-bar,.narrator-caption,nav,footer,.site-nav,.site-footer")
      .forEach(function (n) {
        n.remove();
      });
    var text = clone.innerText || "";
    // Normalise whitespace.
    text = text.replace(/ /g, " ").replace(/[ \t]+/g, " ");
    // Split on sentence enders and hard line breaks, keep it readable.
    var raw = text
      .split(/(?<=[.!?…])\s+|\n{1,}/)
      .map(function (s) {
        return s.trim();
      })
      .filter(function (s) {
        return s.length > 0;
      });
    // Merge very short fragments (e.g. "1.") into the next chunk and cap length.
    var out = [];
    var buf = "";
    raw.forEach(function (s) {
      if ((buf + " " + s).trim().length > 240) {
        if (buf) out.push(buf.trim());
        buf = s;
      } else {
        buf = (buf ? buf + " " : "") + s;
      }
    });
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  // ── Voices (loads async on some browsers) ─────────────────────────────
  function loadVoices() {
    state.voices = synth.getVoices() || [];
    // Prefer an English voice if no saved preference.
    if (!state.voiceURI && state.voices.length) {
      var en = state.voices.filter(function (v) {
        return /^en(-|_|$)/i.test(v.lang);
      });
      state.voiceURI = (en[0] || state.voices[0]).voiceURI;
    }
    renderVoiceOptions();
  }

  function currentVoice() {
    return (
      state.voices.filter(function (v) {
        return v.voiceURI === state.voiceURI;
      })[0] || null
    );
  }

  // ── Speak one chunk, then advance ─────────────────────────────────────
  function speakCurrent() {
    if (state.index >= state.chunks.length) {
      stop();
      return;
    }
    var u = new SpeechSynthesisUtterance(state.chunks[state.index]);
    u.rate = state.rate;
    var v = currentVoice();
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
    u.onend = function () {
      if (!state.playing) return; // stopped/paused externally
      state.index += 1;
      updateProgress();
      speakCurrent();
    };
    u.onerror = function (e) {
      // "interrupted"/"canceled" fire on stop — ignore those.
      if (e && (e.error === "interrupted" || e.error === "canceled")) return;
      console.warn("[narrator] utterance error:", e && e.error);
    };
    setCaption(state.chunks[state.index]);
    synth.speak(u);
  }

  // ── Controls ──────────────────────────────────────────────────────────
  function play() {
    if (state.paused) {
      synth.resume();
      state.paused = false;
      state.playing = true;
      updateButtons();
      return;
    }
    if (state.playing) return;
    if (!state.chunks.length) state.chunks = buildChunks(findTarget());
    if (!state.chunks.length) return;
    state.playing = true;
    state.paused = false;
    synth.cancel(); // clear any stale queue
    speakCurrent();
    updateButtons();
    updateProgress();
    showCaption(true);
  }

  function pause() {
    if (!state.playing) return;
    // Chrome's pause() is unreliable mid-utterance; it works well enough
    // between queued chunks. resume() picks back up.
    synth.pause();
    state.paused = true;
    state.playing = false;
    updateButtons();
  }

  function stop() {
    synth.cancel();
    state.playing = false;
    state.paused = false;
    state.index = 0;
    updateButtons();
    updateProgress();
    showCaption(false);
  }

  function restartIfPlaying() {
    if (state.playing || state.paused) {
      var wasIndex = state.index;
      synth.cancel();
      state.paused = false;
      state.playing = true;
      state.index = wasIndex;
      speakCurrent();
      updateButtons();
    }
  }

  // ── UI ────────────────────────────────────────────────────────────────
  var ui = {};

  function buildUI() {
    var bar = document.createElement("div");
    bar.className = "narrator-bar";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Page narrator");
    bar.innerHTML = [
      '<button class="narrator-btn narrator-play" type="button" title="Play / Pause" aria-label="Play">',
      "  <span class=\"narrator-ico-play\">▶</span><span class=\"narrator-ico-pause\" hidden>⏸</span>",
      "</button>",
      '<button class="narrator-btn narrator-stop" type="button" title="Stop" aria-label="Stop">⏹</button>',
      '<span class="narrator-label">Listen</span>',
      '<span class="narrator-progress" aria-live="off">0%</span>',
      '<label class="narrator-rate" title="Reading speed">',
      '  <input type="range" min="0.6" max="1.8" step="0.1" class="narrator-rate-input" aria-label="Reading speed">',
      '  <span class="narrator-rate-val">1.0×</span>',
      "</label>",
      '<select class="narrator-voice" aria-label="Voice" title="Voice"></select>',
    ].join("");

    var caption = document.createElement("div");
    caption.className = "narrator-caption";
    caption.setAttribute("aria-live", "polite");
    caption.hidden = true;

    document.body.appendChild(caption);
    document.body.appendChild(bar);

    ui.bar = bar;
    ui.caption = caption;
    ui.play = bar.querySelector(".narrator-play");
    ui.icoPlay = bar.querySelector(".narrator-ico-play");
    ui.icoPause = bar.querySelector(".narrator-ico-pause");
    ui.stop = bar.querySelector(".narrator-stop");
    ui.progress = bar.querySelector(".narrator-progress");
    ui.rate = bar.querySelector(".narrator-rate-input");
    ui.rateVal = bar.querySelector(".narrator-rate-val");
    ui.voice = bar.querySelector(".narrator-voice");

    ui.rate.value = String(state.rate);
    ui.rateVal.textContent = state.rate.toFixed(1) + "×";

    ui.play.addEventListener("click", function () {
      state.playing ? pause() : play();
    });
    ui.stop.addEventListener("click", stop);
    ui.rate.addEventListener("input", function () {
      state.rate = parseFloat(ui.rate.value) || 1;
      ui.rateVal.textContent = state.rate.toFixed(1) + "×";
      localStorage.setItem(LS_RATE, String(state.rate));
      restartIfPlaying();
    });
    ui.voice.addEventListener("change", function () {
      state.voiceURI = ui.voice.value;
      localStorage.setItem(LS_VOICE, state.voiceURI);
      restartIfPlaying();
    });

    // Stop narration when the page is hidden/unloaded.
    document.addEventListener("visibilitychange", function () {
      if (document.hidden && state.playing) pause();
    });
    window.addEventListener("beforeunload", function () {
      synth.cancel();
    });
  }

  function renderVoiceOptions() {
    if (!ui.voice) return;
    ui.voice.innerHTML = state.voices
      .map(function (v) {
        var sel = v.voiceURI === state.voiceURI ? " selected" : "";
        return (
          '<option value="' +
          v.voiceURI +
          '"' +
          sel +
          ">" +
          v.name +
          " (" +
          v.lang +
          ")</option>"
        );
      })
      .join("");
    if (!state.voices.length) {
      ui.voice.style.display = "none";
    }
  }

  function updateButtons() {
    if (!ui.play) return;
    var active = state.playing;
    ui.icoPlay.hidden = active;
    ui.icoPause.hidden = !active;
    ui.play.setAttribute("aria-label", active ? "Pause" : "Play");
    ui.bar.classList.toggle("is-playing", active || state.paused);
  }

  function updateProgress() {
    if (!ui.progress) return;
    var total = state.chunks.length || 1;
    var pct = Math.min(100, Math.round((state.index / total) * 100));
    ui.progress.textContent = pct + "%";
  }

  function setCaption(text) {
    if (!ui.caption) return;
    ui.caption.textContent = text;
  }
  function showCaption(on) {
    if (!ui.caption) return;
    ui.caption.hidden = !on;
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  function init() {
    buildUI();
    loadVoices();
    if (typeof synth.onvoiceschanged !== "undefined") {
      synth.onvoiceschanged = loadVoices;
    }
    // Expose a tiny API for other scripts/pages.
    window.LanternNarrator = { play: play, pause: pause, stop: stop };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
