/**
 * nav-menu.js — mobile hamburger wiring for BESPOKE `<nav class="site-nav">` headers that
 * don't use site-chrome.js (kalshi-terminal, trading, orchestration). site-chrome pages
 * already do this inline. Requires a `.nav-menu-toggle` button in the nav; the dropdown CSS
 * (.site-nav.has-menu …) lives in css/site.css. Idempotent.
 */
(function () {
  "use strict";
  function wire(nav) {
    var mt = nav.querySelector(".nav-menu-toggle");
    if (!mt || nav.classList.contains("has-menu")) return;
    nav.classList.add("has-menu");
    var close = function () { nav.classList.remove("menu-open"); mt.setAttribute("aria-expanded", "false"); };
    mt.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = nav.classList.toggle("menu-open");
      mt.setAttribute("aria-expanded", open ? "true" : "false");
    });
    nav.querySelectorAll(".nav-links a").forEach(function (a) { a.addEventListener("click", close); });
    document.addEventListener("click", function (e) { if (nav.classList.contains("menu-open") && !nav.contains(e.target)) close(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
  }
  function init() { document.querySelectorAll("nav.site-nav").forEach(wire); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
