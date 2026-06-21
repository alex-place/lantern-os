/**
 * Auth gate + nav wiring.
 * Include on every page. Handles:
 * - Redirect to /auth.html if page requires login and user is not authenticated
 * - Updates nav to show profile/logout (authed) or sign-in button (guest)
 */
(function () {
  // dream-chat.html is public so first-time visitors can reach the chat without an
  // account, honoring the "no account needed" promise (#739). Guests get a limited
  // read-only experience; premium models/limits are still enforced by role.
  // Keep in lock-step with PUBLIC_PAGES in routes/pages.js. '/' and '/index.html'
  // are served publicly there, so they must not bounce here either — a missing '/'
  // is why a guest landing on the home page got redirected to /auth.html?returnTo=%2F.
  const PUBLIC = ['/', '/index.html', '/auth.html', '/auth', '/explore.html', '/knowledgecenter.html', '/dream-chat.html'];
  // Pages that require the "trade" entitlement (kept in sync with routes/pages.js).
  const TRADE_PAGES = ['/trading.html', '/trading-news.html', '/trader-dashboard.html', '/kalshi-terminal.html'];
  const pathname = window.location.pathname;
  const isPublic = PUBLIC.includes(pathname);

  // Hide nav links to trade-only pages for accounts without trade access, so a
  // non-entitled user (e.g. Deep Dreamer) never sees a link that would 403.
  function hideTradeNav() {
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = (a.getAttribute('href') || '').split('?')[0];
      if (TRADE_PAGES.includes(href)) a.style.display = 'none';
    });
  }

  // ── Admin feature-flags + per-page nav visibility ────────────────────────
  // The admin control surface (admin-flags.html) writes to data/admin/
  // feature-flags.json; these public endpoints expose it. This is the canonical
  // wiring — it runs on every page (auth-gate.js is included site-wide) and
  // matches links by href, so it covers each page's inline .site-nav, not just
  // one header component. Server-side enforcement lives in routes/pages.js.
  function hrefPath(href) {
    try { return new URL(href, location.origin).pathname; }
    catch (e) { return (href || '').split('?')[0]; }
  }

  // Apply { path: { hidden, disabled } } overrides to every nav link.
  function applyNavVisibility(navigation) {
    if (!navigation) return;
    document.querySelectorAll('nav a[href]').forEach((a) => {
      const cfg = navigation[hrefPath(a.getAttribute('href'))];
      if (!cfg) return;
      if (cfg.hidden) { a.style.display = 'none'; return; }
      if (cfg.disabled) {
        a.setAttribute('aria-disabled', 'true');
        a.removeAttribute('href');
        a.style.setProperty('pointer-events', 'none', 'important');
        a.style.setProperty('opacity', '0.4', 'important');
        a.style.setProperty('cursor', 'not-allowed', 'important');
        a.title = 'Temporarily disabled by an administrator';
      }
    });
  }

  // Expose flags + gate [data-flag]/[data-flag-off] elements anywhere on the page.
  function applyFlags(flags) {
    if (!flags) return;
    window.LanternFlags = { map: flags, enabled: (k) => !!flags[k] };
    document.querySelectorAll('[data-flag]').forEach((el) => {
      if (!flags[el.getAttribute('data-flag')]) el.style.display = 'none';
    });
    document.querySelectorAll('[data-flag-off]').forEach((el) => {
      if (flags[el.getAttribute('data-flag-off')]) el.style.display = 'none';
    });
    document.dispatchEvent(new CustomEvent('lantern-flags-ready', { detail: { flags } }));
  }

  // Admins get an Admin link into the page's primary nav (and any opt-in
  // [data-admin-only] elements revealed). Reuses the session we already fetched
  // — no second /api/auth/session round-trip.
  function injectAdminLink(session) {
    if (!session || session.role !== 'admin') return;
    document.querySelectorAll('[data-admin-only]').forEach((el) => { el.style.display = ''; });
    const links = document.querySelector('.nav-links') || document.querySelector('nav');
    if (links && !links.querySelector('a[href="/admin-flags.html"]')) {
      const a = document.createElement('a');
      a.href = '/admin-flags.html';
      a.textContent = 'Admin';
      a.className = 'nav-admin-link';
      const anchor = links.querySelector('.sep') || links.querySelector('.nav-support');
      if (anchor) links.insertBefore(a, anchor); else links.appendChild(a);
    }
  }

  // Best-effort: a fetch failure leaves the nav fully visible (fail-open for UX;
  // the server still gates disabled pages and protected routes).
  function applyAdminControls(session) {
    Promise.all([
      fetch('/api/nav-config', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/flags', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([nav, fl]) => {
      applyNavVisibility(nav && nav.navigation);
      applyFlags(fl && fl.flags);
      injectAdminLink(session);
    }).catch(() => {});
  }

  function updateNav(session) {
    // Profile button
    const profileBtn = document.getElementById('profile-btn');
    // Logout button
    const logoutBtn = document.getElementById('logout-btn');
    // Generic sign-in button (if page has one)
    const signinBtn = document.getElementById('signin-btn');

    if (session && session.authenticated) {
      if (profileBtn) profileBtn.style.display = '';
      if (logoutBtn) logoutBtn.style.display = '';
      if (signinBtn) signinBtn.style.display = 'none';
    } else {
      if (profileBtn) profileBtn.style.display = 'none';
      if (logoutBtn) logoutBtn.style.display = 'none';
      if (signinBtn) signinBtn.style.display = '';
      // Inject sign-in button into nav-actions if neither profile-btn nor signin-btn exist
      if (!profileBtn && !signinBtn) {
        const navActions = document.querySelector('.nav-actions');
        if (navActions && !navActions.querySelector('.nav-signin')) {
          const btn = document.createElement('a');
          btn.href = '/auth.html?returnTo=' + encodeURIComponent(pathname);
          btn.className = 'nav-btn nav-signin';
          btn.title = 'Sign in';
          btn.setAttribute('aria-label', 'Sign in');
          btn.textContent = '👤';
          navActions.prepend(btn);
        }
      }
    }
  }

  function wireLogout() {
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn && !logoutBtn.dataset.wired) {
      logoutBtn.dataset.wired = '1';
      logoutBtn.addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
        location.href = '/auth.html';
      });
    }
  }

  fetch('/api/auth/session', {
    credentials: 'include',
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  })
    .then(r => (r.ok ? r.json() : null))
    .then(session => {
      updateNav(session);
      wireLogout();
      applyAdminControls(session);
      const canTrade = !!(session && session.entitlements && session.entitlements.trade);
      if (!canTrade) hideTradeNav();
      // When an admin disables the Patreon gate (server reports authRequired:false),
      // guests browse freely — don't bounce them to /auth.html.
      const gateOff = session && session.authRequired === false;
      if (!isPublic && !gateOff && (!session || !session.authenticated)) {
        location.href = '/auth.html?returnTo=' + encodeURIComponent(pathname);
      } else if (TRADE_PAGES.includes(pathname) && session && session.authenticated && !canTrade) {
        // Direct navigation to a trade page without entitlement → bounce home.
        location.href = '/';
      }
    })
    .catch(() => {
      // Session lookup failed — still apply public nav-config/flags (no admin link).
      // Fail open: do NOT client-redirect to /auth.html on a transient error. The
      // server is authoritative and serves its own 302 for genuinely protected
      // pages when the gate is on, so a client bounce here is redundant and, while
      // the login flow is being disabled, actively harmful.
      applyAdminControls(null);
    });
})();
