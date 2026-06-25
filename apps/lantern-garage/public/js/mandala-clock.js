/**
 * Real-time mandala clock.
 *
 * Turns the site's mandalas into a clock whose rings are hands, phase-synced to
 * the actual wall-clock time:
 *
 *   minute hand → one full turn per minute
 *   hour   hand → one full turn per hour
 *   day    hand → one full turn per 24h
 *
 * Because each angle is derived from Date() (not a CSS animation that resets to
 * 0° on load), every instance and every reload shows the true current time, the
 * way real clock hands do.
 *
 * Two kinds of mandala are upgraded:
 *   1. <img src=".../mandala.svg">  — inlined; rings .inner/.mid/.outer-*.
 *   2. .ambient__mandala (the large CSS-background sigma0 mandala on the home
 *      hero) — the background is replaced with an inline SVG; rings .ring3/2/1.
 *
 * The source SVGs are left untouched, so any plain <img>/background use that
 * doesn't load this script keeps its original CSS spin as a graceful fallback.
 */
(function () {
  "use strict";

  const hands = []; // [{ el, period }]  period in seconds for one full turn
  let uid = 0;

  const PERIOD = { minute: 60, hour: 3600, day: 86400 };

  // Suffix every internal id (and #-reference) so multiple inlined copies in
  // one document don't collide on shared gradient/filter ids.
  function namespaceIds(text, sfx) {
    return text
      .replace(/\bid="([^"]+)"/g, (_m, id) => 'id="' + id + "_" + sfx + '"')
      .replace(/url\(#([^)]+)\)/g, (_m, id) => "url(#" + id + "_" + sfx + ")")
      .replace(/(\bhref=")#([^"]+)(")/g, (_m, a, id, b) => a + "#" + id + "_" + sfx + b);
  }

  function parseSvg(text) {
    const tpl = document.createElement("template");
    tpl.innerHTML = namespaceIds(text.trim(), uid++);
    return tpl.content.querySelector("svg");
  }

  // Register each ring with the period of the hand it plays.
  function register(svg, sel) {
    const add = (s, period) => {
      const el = s && svg.querySelector(s);
      if (el) hands.push({ el, period });
    };
    add(sel.minute, PERIOD.minute);
    add(sel.hour, PERIOD.hour);
    (sel.day || []).forEach((s) => add(s, PERIOD.day));
  }

  // 1. <img src=".../mandala.svg">
  function upgradeImg(img, text) {
    const svg = parseSvg(text);
    if (!svg) return;
    const w = img.getAttribute("width");
    const h = img.getAttribute("height");
    if (w) svg.setAttribute("width", w);
    if (h) svg.setAttribute("height", h);
    if (img.getAttribute("style")) svg.setAttribute("style", img.getAttribute("style"));
    if (img.className) svg.setAttribute("class", img.className);
    const alt = (img.getAttribute("alt") || "").trim();
    if (alt) { svg.setAttribute("role", "img"); svg.setAttribute("aria-label", alt); }
    else { svg.setAttribute("aria-hidden", "true"); }
    img.replaceWith(svg);
    register(svg, { minute: ".inner", hour: ".mid", day: [".outer-a", ".outer-b"] });
  }

  // Seconds elapsed into the current period (the negative animation-delay that
  // phase-aligns a `period`-second linear spin to the real wall-clock).
  function phaseInto(period, now) {
    const ms = now.getMilliseconds() / 1000;
    if (period === PERIOD.minute) return now.getSeconds() + ms;
    if (period === PERIOD.hour) return now.getMinutes() * 60 + now.getSeconds() + ms;
    return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + ms;
  }

  function ensureKeyframes() {
    if (document.getElementById("mandala-clock-kf")) return;
    const st = document.createElement("style");
    st.id = "mandala-clock-kf";
    // transform-origin (100px 100px) comes from each ring's own class rule.
    st.textContent = "@keyframes mandala-cw{to{transform:rotate(360deg)}}";
    document.head.appendChild(st);
  }

  function start() {
    if (!hands.length) return;
    const now = new Date();
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduce) {
      // Reduced motion: show the correct time statically, no continuous spin.
      for (const { el, period } of hands) {
        el.style.animation = "none";
        el.style.transform = "rotate(" + (phaseInto(period, now) / period) * 360 + "deg)";
      }
      return;
    }

    // Smooth path: one compositor-driven linear spin per ring, started partway
    // through via a negative delay so it reads the true current time.
    ensureKeyframes();
    for (const { el, period } of hands) {
      el.style.animation = "mandala-cw " + period + "s linear infinite";
      el.style.animationDelay = "-" + phaseInto(period, now) + "s";
    }
  }

  // Fetch an SVG once, cache the text, then run a callback for each consumer.
  const cache = {};
  function withSvg(url, fn) {
    if (cache[url]) { fn(cache[url]); return Promise.resolve(); }
    return fetch(url, { cache: "force-cache" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status))))
      .then((text) => { cache[url] = text; fn(text); });
  }

  function init() {
    const jobs = [];

    const imgs = [...document.querySelectorAll("img")].filter((img) =>
      /(^|\/)mandala\.svg(?:[?#]|$)/.test(img.getAttribute("src") || "")
    );
    if (imgs.length) {
      jobs.push(withSvg("/mandala.svg", (text) => imgs.forEach((img) => upgradeImg(img, text))));
    }

    Promise.all(jobs).then(start).catch(() => { /* leave originals as fallback */ });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
