/**
 * Auth gate + nav wiring.
 * Include on every page. Handles:
 * - Redirect to /auth.html if page requires login and user is not authenticated
 * - Updates nav to show profile/logout (authed) or sign-in button (guest)
 */
(function () {
  // chat.html is public so first-time visitors can reach the chat without an
  // account, honoring the "no account needed" promise (#739). Guests get a limited
  // read-only experience; premium models/limits are still enforced by role.
  // Keep in lock-step with PUBLIC_PAGES in routes/pages.js. '/' and '/index.html'
  // are served publicly there, so they must not bounce here either — a missing '/'
  // is why a guest landing on the home page got redirected to /auth.html?returnTo=%2F.
  // /stock-trader.html is public: guests (and paid tiers without "trade") get the
  // SAME terminal in read-only "guest mode" — charts + watchlist + market data, no
  // trading actions. So it must NOT bounce here, and is NOT a TRADE_PAGE (a
  // logged-in non-trade user should see the read-only view, not be sent home).
  // /orchestration.html is public read-only too: guests/non-admins see the fleet
  // STATUS panels; the control panels (keys, training, auto-pull) are hidden via
  // body.is-guest and their endpoints are admin-gated server-side. So it must not
  // bounce here either.
  const PUBLIC = ['/', '/index.html', '/auth.html', '/auth', '/explore.html', '/knowledgecenter.html', '/chat.html', '/dream-chat.html', '/stock-trader.html', '/watch.html', '/options.html', '/orchestration.html', '/pricing.html', '/demo.html', '/contest.html'];
  // Pages that require the "trade" entitlement (kept in sync with routes/pages.js).
  const TRADE_PAGES = ['/kalshi-terminal.html']; // /trading.html retired → redirects to /stock-trader.html (#2488)
  // Operator surfaces hidden from the header tabs + footer links for the guest
  // role — the pages themselves stay reachable by URL (orchestration is public
  // read-only, work is server-gated); this only trims links guests can't use.
  const GUEST_HIDDEN_PAGES = ['/orchestration.html', '/work.html'];
  const pathname = window.location.pathname;
  const isPublic = PUBLIC.includes(pathname);

  // Hide nav links to trade-only pages for accounts without trade access, so a
  // non-entitled user (e.g. Pro) never sees a link that would 403.
  function hideTradeNav() {
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = (a.getAttribute('href') || '').split('?')[0];
      if (TRADE_PAGES.includes(href)) a.style.display = 'none';
    });
  }

  // Hide the Settings (orchestration) + Work links for guests — header tabs AND
  // the footer sitemap (same nav+footer coverage as applyNavVisibility), across
  // both the site-chrome.js chrome and any page's inline .site-nav/footer.
  function hideGuestNav() {
    document.querySelectorAll('nav a[href], .site-footer a[href]').forEach((a) => {
      const href = (a.getAttribute('href') || '').split('?')[0];
      if (GUEST_HIDDEN_PAGES.includes(href)) a.style.display = 'none';
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
    // Covers the header <nav> AND the site footer, so an extension hidden from the
    // loop-foregrounded default (e.g. Trader/Create when their flag is off) doesn't
    // reappear in the footer. Links not in the nav-config map are left untouched.
    document.querySelectorAll('nav a[href], .site-footer a[href]').forEach((a) => {
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

  // Admins reveal any opt-in [data-admin-only] elements on the page. The Admin
  // control-surface entry point (admin-flags.html) intentionally lives ONLY on
  // the profile page now — it is no longer injected into every page's top nav.
  // Reuses the session we already fetched — no second /api/auth/session round-trip.
  function injectAdminLink(session) {
    if (!session || session.role !== 'admin') return;
    document.querySelectorAll('[data-admin-only]').forEach((el) => { el.style.display = ''; });
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

  // Role → plan badge shown beside the profile button. Roles collapse to the
  // three sold plans (the supporter role survives from retired $5 patrons and
  // reads as Free); staff roles show their staff label instead of a plan.
  const TIER_BADGE = {
    guest: ['Free', 'free'], supporter: ['Free', 'free'],
    deep_dreamer: ['Pro', 'pro'], founder: ['Pro', 'pro'],
    pilot: ['Pilot', 'pilot'],
    tech_support: ['Staff', 'admin'], admin: ['Admin', 'admin'],
  };

  // Show the signed-in user's plan to the LEFT of the profile button. The badge
  // links to /pricing.html — for a Free user that's the upgrade path, for a paid
  // user it's where Manage subscription lives. Removed entirely for guests (their
  // profile slot is a sign-in link; a plan label there would be noise).
  function updateTierBadge(session) {
    const profileBtn = document.getElementById('profile-btn');
    let badge = document.getElementById('nav-tier');
    if (!(session && session.authenticated) || !profileBtn) {
      if (badge) badge.remove();
      return;
    }
    const [label, kind] = TIER_BADGE[session.role] || ['Free', 'free'];
    if (!badge) {
      badge = document.createElement('a');
      badge.id = 'nav-tier';
      badge.className = 'nav-tier';
      badge.href = '/pricing.html';
      // Lead the actions cluster (leftmost) — sitting between the icon buttons
      // broke the group up visually (operator, 2026-07-25). flex order pins it
      // first even when other buttons are reordered/hidden responsively.
      badge.style.order = '-2';  // beats .nav-menu-toggle's order:-1 on narrow screens
      profileBtn.parentElement.insertBefore(badge, profileBtn.parentElement.firstChild);
    }
    badge.textContent = label;
    badge.dataset.tier = kind;
    badge.title = kind === 'free' ? 'Your plan: Free — see upgrade options' : 'Your plan: ' + label;
  }

  function updateNav(session) {
    updateTierBadge(session);
    // Profile button
    const profileBtn = document.getElementById('profile-btn');
    // Logout button
    const logoutBtn = document.getElementById('logout-btn');
    // Generic sign-in button (if page has one)
    const signinBtn = document.getElementById('signin-btn');

    if (session && session.authenticated) {
      // Restore the profile button to its canonical destination in case a prior
      // guest render repurposed it into a sign-in link (SPA-style re-check).
      if (profileBtn) {
        profileBtn.style.display = '';
        profileBtn.href = '/settings.html';
        profileBtn.title = 'Account & settings';
        profileBtn.setAttribute('aria-label', 'Account and settings');
        profileBtn.classList.remove('nav-signin');
      }
      if (logoutBtn) logoutBtn.style.display = '';
      if (signinBtn) signinBtn.style.display = 'none';
    } else {
      if (logoutBtn) logoutBtn.style.display = 'none';
      if (signinBtn) signinBtn.style.display = '';
      // Guests get a login icon in the SAME slot as the profile icon. The nav
      // (injected by site-chrome.js) always ships a #profile-btn, so rather than
      // hiding it and leaving no affordance, repurpose it into a sign-in link.
      if (profileBtn) {
        profileBtn.style.display = '';
        profileBtn.href = '/auth.html?returnTo=' + encodeURIComponent(pathname);
        profileBtn.title = 'Sign in';
        profileBtn.setAttribute('aria-label', 'Sign in');
        profileBtn.classList.add('nav-signin');
      } else if (!signinBtn) {
        // Fallback for pages that ship neither a profile button nor a sign-in button.
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
      // Expose auth state to page CSS. `is-admin` reveals admin-only control
      // panels (e.g. orchestration keys/training/auto-pull); `is-guest` marks a
      // logged-out visitor so pages can show a read-only banner. Both default to
      // the safe (locked-down) state until the session resolves.
      const isAdminUser = !!(session && session.authenticated && session.role === 'admin');
      document.body.classList.toggle('is-admin', isAdminUser);
      document.body.classList.toggle('is-guest', !(session && session.authenticated));
      const canTrade = !!(session && session.entitlements && session.entitlements.trade);
      if (!canTrade) hideTradeNav();
      // Guest role = not signed in (server reports role:"guest") OR an account
      // explicitly assigned the guest role. Mirrors hideTradeNav's fail posture:
      // a transient session error (catch below) leaves the nav fully visible.
      const isGuestRole = !(session && session.authenticated) || session.role === 'guest';
      if (isGuestRole) hideGuestNav();
      // When an admin disables the Patreon gate (server reports authRequired:false),
      // guests browse freely — don't bounce them to /auth.html.
      const gateOff = session && session.authRequired === false;
      const authed = !!(session && session.authenticated);
      // #2652: card-subscription auto-link is provider-agnostic. auth.html fires it after an
      // email/password login, but OAuth (Google/Discord) sign-ins redirect server-side and
      // skip it — so a customer who bought by card and then signs in with OAuth on the same
      // verified email would land as Free. Fire it here once per browser session for ANY
      // authenticated user; the server is guarded (verified-email + cooldown) and no-ops
      // fast when billing is off or there's nothing to link. Reload only on a fresh link so
      // the newly-unlocked tier shows immediately (the session flag prevents a loop).
      if (authed) {
        try {
          if (!sessionStorage.getItem('billing-link-tried')) {
            sessionStorage.setItem('billing-link-tried', '1');
            fetch('/api/billing/link', { method: 'POST', credentials: 'same-origin' })
              .then(function (r) { return r && r.ok ? r.json() : null; })
              .then(function (d) { if (d && d.linked && !d.already) location.reload(); })
              .catch(function () { /* best-effort */ });
          }
        } catch (e) { /* no sessionStorage — skip */ }
      }
      // First-visit gate: a not-signed-in visitor who hasn't made an entry choice yet is
      // sent to /auth.html ONCE to decide. Signing in creates a session; "Continue without
      // an account" sets ln_guest=1. Either way they're not prompted again — so the default
      // is signed-OUT-and-asked, never silently signed in.
      const guestChoice = document.cookie.split(/;\s*/).some((c) => c === 'ln_guest=1');
      const onAuthPage = pathname === '/auth.html' || pathname === '/auth';
      if (!gateOff && !authed && !guestChoice && !onAuthPage) {
        location.href = '/auth.html?returnTo=' + encodeURIComponent(pathname);
        return;
      }
      if (!isPublic && !gateOff && !authed) {
        location.href = '/auth.html?returnTo=' + encodeURIComponent(pathname);
      } else if (TRADE_PAGES.includes(pathname) && authed && !canTrade) {
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
