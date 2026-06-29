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
    { href: "/dream-chat.html", label: "Chat" },
    { href: "/stock-trader.html", label: "Trader" },
    { href: "/create.html", label: "Create" },
    { href: "/explore.html", label: "Explore" },
    { href: "/knowledgecenter.html", label: "Help" },
  ];

  function navHtml() {
    var links = NAV_LINKS.map(function (l) {
      return '<a href="' + l.href + '">' + l.label + "</a>";
    }).join("\n    ");
    return (
      '<nav class="site-nav">\n' +
      '  <a class="nav-brand" href="/">\n' +
      '    <img src="/mandala.svg" alt="" aria-hidden="true" style="width:24px;height:24px;vertical-align:middle">\n' +
      '    <span style="font-size:18px;font-weight:600">Keystone OS</span>\n' +
      "  </a>\n" +
      '  <div class="nav-links">\n    ' +
      links +
      "\n" +
      '    <a href="https://www.patreon.com/c/lanterndreamjournal" class="nav-support" target="_blank" rel="noopener noreferrer">♥ Patreon ♥</a>\n' +
      "  </div>\n" +
      '  <div class="nav-actions">\n' +
      '    <a href="/profile.html" class="nav-btn" id="profile-btn" title="Your profile" aria-label="View your profile">👤</a>\n' +
      '    <button class="nav-btn" id="logout-btn" onclick="logoutUser()" title="Logout" aria-label="Logout" style="display:none;">🚪</button>\n' +
      '    <button class="nav-btn" id="theme-toggle" onclick="toggleTheme()" title="Toggle light / dark mode" aria-label="Toggle light or dark mode">☀</button>\n' +
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
      "      Keystone OS\n" +
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
    if (!document.querySelector("footer.site-footer")) {
      body.appendChild(nodeFrom(footerHtml()));
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

    // theme-toggle.js may have run before this nav existed; sync the glyph.
    var btn = document.getElementById("theme-toggle");
    if (btn) {
      btn.textContent =
        document.documentElement.getAttribute("data-theme") === "dark" ? "☀️" : "🌙";
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
