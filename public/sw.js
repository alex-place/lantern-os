/* Service worker — self-cleanup.
   A previously installed SW was intercepting fetches and crashing (non-Response
   rejection) and serving STALE cached pages that survived hard refresh. This
   replacement activates immediately, wipes all caches, unregisters itself, and —
   crucially — force-reloads EVERY open tab (not just index.html, which was the
   only page with inline cleanup code). That way a user sitting directly on
   /stock-trader.html self-heals to the fresh page without manual cache clearing.
   Served no-store, so the browser always fetches this version on its update
   check even while a stale SW is active. */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.map((k) => caches.delete(k)));
  await self.registration.unregister();
  // Reload every controlled window now that caches are gone + we're unregistered,
  // so open pages (any page) pick up the current server HTML/JS immediately.
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of clients) { try { c.navigate(c.url); } catch (_e) { /* ignore */ } }
})()));

/* Passthrough: while this SW is active (the one brief load before it
   unregisters), forward every fetch straight to the network so nothing hangs. */
self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));
