/**
 * site-chrome.js — single source of truth for the shared site header + footer.
 *
 * The canonical design lives on the home page (/). This script injects the same
 * <nav class="site-nav"> and <footer class="site-footer"> markup into every page
 * that includes it, so the chrome can no longer drift per-page.
 *
 * Usage (place near the end of <body>, BEFORE auth-gate.js so the nav exists
 * when auth-gate runs):
 *   <script src="/js/site-chrome.js" defer></script>
 *   <script src="/js/auth-gate.js" defer></script>
 *
 * Responsibilities kept elsewhere (do not duplicate here):
 *   - theme-toggle.js  → defines toggleTheme(); the ☀ button calls it via onclick
 *   - auth-gate.js     → highlights the active nav link (by href), shows/hides
 *                        profile + logout, injects a sign-in button for guests
 */
(function () {
  "use strict";

  var NAV_LINKS = [
    { href: "/chat.html", label: "Chat" },
    { href: "/watch.html", label: "Watch" },
    { href: "/stock-trader.html", label: "Trader" },
    { href: "/options.html", label: "Options" },
    { href: "/contest.html", label: "Contest" },
    { href: "/settings.html", label: "Settings" },
    { href: "/work.html", label: "Work" },
    { href: "/explore.html", label: "Explore" },
  ];

  function navHtml() {
    var links = NAV_LINKS.map(function (l) {
      return '<a href="' + l.href + '">' + l.label + "</a>";
    }).join("\n    ");
    return (
      '<nav class="site-nav">\n' +
      '  <a class="nav-brand" href="/">\n' +
      '    <img src="/mandala.svg" alt="" aria-hidden="true" style="width:24px;height:24px;vertical-align:middle">\n' +
      '    <span style="font-size:18px;font-weight:600">unisona.ai</span>\n' +
      "  </a>\n" +
      '  <div class="nav-links">\n    ' +
      links +
      "\n" +
      "  </div>\n" +
      '  <div class="nav-actions">\n' +
      '    <button class="nav-btn nav-menu-toggle" id="nav-menu-toggle" type="button" aria-label="Menu" aria-expanded="false" title="Menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></button>\n' +
      '    <a href="/settings.html" class="nav-btn" id="profile-btn" title="Account & settings" aria-label="Account and settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></a>\n' +
      '    <button class="nav-btn" id="theme-toggle" onclick="toggleTheme()" title="Toggle light / dark mode" aria-label="Toggle light or dark mode"><svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg><svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg></button>\n' +
      '    <button class="nav-btn" id="screenshot-btn" type="button" onclick="if(window.issueReporter)window.issueReporter.open()" title="Report an issue (screenshot → GitHub)" aria-label="Report an issue with a screenshot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></button>\n' +
      "  </div>\n" +
      "</nav>"
    );
  }

  function footerHtml() {
    var links = NAV_LINKS.map(function (l) {
      return '<a href="' + l.href + '">' + l.label + "</a>";
    }).join("\n    ");
    return (
      '<footer class="site-footer">\n' +
      '  <div class="footer-inner">\n' +
      '    <span class="footer-brand">\n' +
      '      <span class="dot online" id="status-dot" title="Server status"></span>\n' +
      "      unisona.ai\n" +
      "    </span>\n" +
      '    <span class="sep">·</span>\n' +
      '    <a href="/">Home</a>\n    ' +
      links +
      "\n" +
      '    <span class="sep">·</span>\n' +
      '    <a href="https://github.com/alex-place/lantern-os" target="_blank" rel="noopener noreferrer">GitHub</a>\n' +
      '    <span class="visually-hidden" id="status-label">connecting…</span>\n' +
      "  </div>\n" +
      "</footer>"
    );
  }

  function nodeFrom(html) {
    var tpl = document.createElement("template");
    tpl.innerHTML = html.trim();
    return tpl.content.firstElementChild;
  }

  // Reflect real server + local-model health in the injected footer dot/label.
  // Mirrors index.html's loadState() classification (green/gold/red) so the two
  // never disagree. Fails safe: any fetch error → red "server unreachable".
  function startStatusUpdater() {
    var dot = document.getElementById("status-dot");
    var label = document.getElementById("status-label");
    if (!dot || !label) return;

    function getJson(url) {
      return fetch(url, { credentials: "include" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    }

    function apply() {
      Promise.all([getJson("/api/health"), getJson("/api/serving/status")]).then(
        function (res) {
          var health = res[0];
          var serving = res[1];
          var serverOnline = !!(health && health.ok);
          var lm = serving && serving.local_model;
          var ollamaUp = !!(lm && lm.serving);
          var pinnedConfigured = !!(lm && lm.pinned);
          var modelUp = !!(lm && lm.pinned_served);
          var state, text, title;
          if (!serverOnline || !ollamaUp) {
            state = "offline";
            text = serverOnline ? "ollama offline" : "server unreachable";
            title = serverOnline
              ? "Ollama down" + (lm && lm.base ? " (" + lm.base + ")" : "")
              : "Server unreachable";
          } else if (pinnedConfigured && !modelUp) {
            state = "warn";
            text = "ollama online · model not loaded";
            title = "Ollama up · pinned model " + lm.pinned + " not served";
          } else {
            state = "online";
            text = "ollama online";
            var active = (lm && (lm.active_model || lm.pinned)) || "";
            title = "Ollama up" + (active ? " · " + active : "");
          }
          dot.className = "dot " + state;
          dot.title = title;
          label.textContent = text;
        }
      );
    }

    apply();
    setInterval(apply, 30000);
  }

  function injectChrome() {
    var body = document.body;
    if (!body) return;

    // Header — only if the page hasn't already got one (idempotent).
    if (!document.querySelector("nav.site-nav")) {
      var nav = nodeFrom(navHtml());
      // Keep an a11y skip-link (if any) as the first focusable element.
      var skip = body.querySelector("a.skip-link");
      if (skip && skip.parentElement === body) {
        skip.insertAdjacentElement("afterend", nav);
      } else {
        body.insertBefore(nav, body.firstChild);
      }
    }

    // Footer — append as the last layout element.
    var footerInjected = false;
    if (!document.querySelector("footer.site-footer")) {
      body.appendChild(nodeFrom(footerHtml()));
      footerInjected = true;
    }

    // Live footer status (#2482): the injected footer ships a hardcoded green dot
    // + "connecting…" label. Only index.html / dream-chat drove it before, so on
    // every other shared-chrome page the dot stayed misleadingly green forever.
    // Poll /api/health (+ /api/serving/status for the local-model tint) and reflect
    // the real state. A page can opt out by setting window.__ownStatusUpdater; we
    // only touch footers WE injected.
    if (footerInjected && !window.__ownStatusUpdater) {
      startStatusUpdater();
    }

    // Per-page extra action buttons (e.g. trading's settings, the terminal's skin toggle):
    // a page declares them in <template id="nav-extra-actions">; we clone them into the nav's
    // actions (before the theme toggle) so app pages can use the ONE global header and still
    // keep their app-specific controls. A nav with extras also gets `nav-appbar` (compact
    // mobile buttons) since it carries more than the canonical three.
    var extraTpl = document.getElementById("nav-extra-actions");
    var injectedNav = document.querySelector("nav.site-nav");
    if (extraTpl && extraTpl.content && injectedNav) {
      var actions = injectedNav.querySelector(".nav-actions");
      if (actions) {
        injectedNav.classList.add("nav-appbar");
        var anchor = actions.querySelector("#theme-toggle");
        actions.insertBefore(extraTpl.content.cloneNode(true), anchor || null);
      }
    }

    // Highlight the current page's nav link (auth-gate.js doesn't do this).
    var here = location.pathname.replace(/\/index\.html$/, "/");
    document.querySelectorAll("nav.site-nav .nav-links a").forEach(function (a) {
      var href = a.getAttribute("href") || "";
      if (href && href.charAt(0) === "/" && href === here) {
        a.classList.add("active");
        a.setAttribute("aria-current", "page"); // expose the active page to AT
      }
    });

    // Mobile hamburger: on narrow screens the 5 nav links don't fit beside the brand +
    // action buttons (they clipped mid-word). Collapse them into a dropdown behind the ☰.
    // Gated by the `has-menu` class so ONLY this canonical nav gets the dropdown CSS —
    // bespoke app navs (kalshi-terminal, trading, …) keep their own behavior.
    var navEl = document.querySelector("nav.site-nav");
    var menuToggle = document.getElementById("nav-menu-toggle");
    if (navEl && menuToggle && !navEl.classList.contains("has-menu")) {
      navEl.classList.add("has-menu");
      var closeMenu = function () { navEl.classList.remove("menu-open"); menuToggle.setAttribute("aria-expanded", "false"); };
      menuToggle.addEventListener("click", function (e) {
        e.stopPropagation();
        var open = navEl.classList.toggle("menu-open");
        menuToggle.setAttribute("aria-expanded", open ? "true" : "false");
      });
      navEl.querySelectorAll(".nav-links a").forEach(function (a) { a.addEventListener("click", closeMenu); });
      document.addEventListener("click", function (e) { if (navEl.classList.contains("menu-open") && !navEl.contains(e.target)) closeMenu(); });
      document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeMenu(); });
    }

    // theme-toggle.js may have run before this nav existed; sync the glyph.
    // Skip when the button uses SVG icons — CSS drives sun/moon via data-theme.
    var btn = document.getElementById("theme-toggle");
    if (btn && !btn.querySelector("svg")) {
      btn.textContent =
        document.documentElement.getAttribute("data-theme") === "dark" ? "☀️" : "🌙";
    }

    // The 📷 button needs window.issueReporter (modal + capture). It's hardcoded
    // only on the home/chat pages; load it once here so EVERY global-header page
    // (explore, create, trader, …) gets a working screenshot → GitHub reporter.
    // issue-reporter's "Capture this page" depends on html2canvas — load that
    // FIRST (defer preserves insertion order) so auto-capture works instead of
    // erroring "Page capture isn't loaded".
    if (!document.querySelector('script[src*="issue-reporter.js"]')) {
      if (!document.querySelector('script[src*="html2canvas"]')) {
        var h2c = document.createElement("script");
        h2c.src = "/vendor/html2canvas/html2canvas.min.js";
        h2c.defer = true;
        document.body.appendChild(h2c);
      }
      var ir = document.createElement("script");
      ir.src = "/js/issue-reporter.js";
      ir.defer = true;
      document.body.appendChild(ir);
    }
  }

  // Logout used by the injected logout button's onclick.
  if (typeof window.logoutUser !== "function") {
    window.logoutUser = function logoutUser() {
      fetch("/api/auth/logout", { method: "POST", credentials: "include" })
        .then(function (res) {
          if (res.ok) location.href = "/auth.html";
          else alert("Logout failed");
        })
        .catch(function (err) {
          alert("Logout error: " + (err && err.message ? err.message : err));
        });
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectChrome);
  } else {
    injectChrome();
  }
})();
