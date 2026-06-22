/* Service worker — self-cleanup.
   A previously installed SW was intercepting fetches and crashing (non-Response
   rejection), causing page hangs. This replacement activates immediately,
   wipes all caches, and unregisters itself. The page's own inline script
   detects the unregistration and reloads cleanly — no navigate() call here,
   which avoids a second load cycle that can look like another hang. */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', async () => {
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
  await self.registration.unregister();
});

/* Passthrough: while this SW is active (the one brief load before it
   unregisters), forward every fetch straight to the network so nothing hangs. */
self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));
