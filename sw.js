/* Service worker for installability + basic repeat-visit speed. Deliberately
   simple: no pre-baked file manifest to keep in sync (this project has no
   build step and the view-file list has grown a lot), just an opportunistic
   "network first, cache as you go, fall back to cache when offline" policy
   for this app's OWN static files.

   Never touches anything cross-origin - Supabase API calls (auth/data) and
   CDN scripts always go straight to the network, untouched by this file.
   Caching a stale Supabase response would mean showing old financial data
   as if it were current, which is worse than no offline support at all. */

const CACHE_NAME = 'investment-os-shell-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Web Push (023_web_push.sql / send-web-push Edge Function). A push payload
// is always plain JSON here (never HTML/script) - showNotification() is the
// only thing done with it, no eval, no innerHTML.
self.addEventListener('push', (event) => {
  let payload = { title: 'Investment OS', body: 'You have a new notification.' };
  try { if (event.data) payload = Object.assign(payload, event.data.json()); } catch (e) { /* keep default */ }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      data: { url: payload.url || './' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) { if ('focus' in client) return client.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase + CDN scripts: always live network

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
  );
});
