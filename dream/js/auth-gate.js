/**
 * Global Patreon auth gate
 * Include this in pages that require authentication
 * Redirects to /auth.html if user is not authenticated
 */

(function() {
  // Don't gate auth.html itself
  if (window.location.pathname === '/auth.html' || window.location.pathname === '/auth') {
    return;
  }

  // Check session and redirect if not authenticated
  fetch('/api/auth/session', {
    credentials: 'include',
    cache: 'no-store',
    signal: AbortSignal.timeout(5000)
  })
    .then(r => {
      if (!r.ok) throw new Error(`Session check failed: ${r.status}`);
      return r.json();
    })
    .then(session => {
      // If not authenticated, redirect to auth page
      if (!session.authenticated) {
        window.location.href = '/auth.html';
      }
    })
    .catch(err => {
      // On any error, redirect to auth
      console.warn('Auth gate check failed:', err.message);
      window.location.href = '/auth.html';
    });
})();
