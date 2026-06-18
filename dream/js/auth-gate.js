/**
 * Auth gate + nav wiring.
 * Include on every page. Handles:
 * - Redirect to /auth.html if page requires login and user is not authenticated
 * - Updates nav to show profile/logout (authed) or sign-in button (guest)
 */
(function () {
  const PUBLIC = ['/auth.html', '/auth', '/explore.html', '/knowledgecenter.html'];
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
      const canTrade = !!(session && session.entitlements && session.entitlements.trade);
      if (!canTrade) hideTradeNav();
      if (!isPublic && (!session || !session.authenticated)) {
        location.href = '/auth.html?returnTo=' + encodeURIComponent(pathname);
      } else if (TRADE_PAGES.includes(pathname) && session && session.authenticated && !canTrade) {
        // Direct navigation to a trade page without entitlement → bounce home.
        location.href = '/';
      }
    })
    .catch(() => {
      if (!isPublic) {
        location.href = '/auth.html?returnTo=' + encodeURIComponent(pathname);
      }
    });
})();
