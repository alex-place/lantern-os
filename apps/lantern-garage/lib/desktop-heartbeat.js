// desktop-heartbeat.js — window-lifecycle for the packaged desktop app.
//
// The desktop launcher opens the UI as a chromeless Edge/Chrome "--app" window. There
// is no reliable, console-free way for the SEPARATE launcher process to know when that
// window closes (the browser daemonizes; process-polling flashes command prompts). So
// instead the WINDOW tells us: the served page pings /__unisona/beat while it's open
// and fires a sendBeacon on unload. When the beats stop, the Core exits — and the
// launcher, which watches the Core child, quits with it. Clean, native, flash-free.
//
// Entirely gated on UNISONA_DESKTOP=1 — a no-op for the normal servers.
"use strict";

const enabled = process.env.UNISONA_DESKTOP === "1";
const BEAT_PATH = "/__unisona/beat";

// Generous idle timeout: a MINIMIZED app window has its timers throttled (~1/min), so
// the fallback must tolerate sparse beats. A real close fires the beacon for an
// immediate quit, so this only matters if the browser crashed without unloading.
const IDLE_TIMEOUT_MS = 90_000;

let lastBeat = Date.now();
let seenBeat = false;
let watchdog = null;

// Tiny client injected into every served HTML page (desktop only).
const SCRIPT =
  "<script>(function(){try{" +
  "var b=function(q){try{fetch('" + BEAT_PATH + "'+(q||''),{cache:'no-store',keepalive:true}).catch(function(){})}catch(e){}};" +
  "b();var t=setInterval(b,8000);" +
  "addEventListener('pagehide',function(){clearInterval(t);try{navigator.sendBeacon&&navigator.sendBeacon('" + BEAT_PATH + "?close=1')}catch(e){}});" +
  "}catch(e){}})();</script>";

/** Append the heartbeat script to an HTML string (before </body> when present). */
function injectHeartbeat(html) {
  if (!enabled || typeof html !== "string") return html;
  const i = html.lastIndexOf("</body>");
  return i >= 0 ? html.slice(0, i) + SCRIPT + html.slice(i) : html + SCRIPT;
}

/** Route hook — handle the beat endpoint. Returns true iff it handled the request. */
function handleBeat(req, res, url) {
  if (!enabled || !url || url.pathname !== BEAT_PATH) return false;
  lastBeat = Date.now();
  seenBeat = true;
  const closing = url.searchParams && url.searchParams.get("close") === "1";
  res.writeHead(204, { "Cache-Control": "no-store" });
  res.end();
  if (closing) setTimeout(() => process.exit(0), 150); // window closed → quit
  return true;
}

/** Fallback watchdog: if beats were flowing and then stopped, the window is gone. */
function startWatchdog() {
  if (!enabled || watchdog) return;
  watchdog = setInterval(() => {
    if (seenBeat && Date.now() - lastBeat > IDLE_TIMEOUT_MS) process.exit(0);
  }, 5_000);
  if (watchdog.unref) watchdog.unref();
}

module.exports = { enabled, injectHeartbeat, handleBeat, startWatchdog, BEAT_PATH };
