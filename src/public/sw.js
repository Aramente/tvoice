// Tvoice service worker.
// Strategy:
//   - Precache shell assets on install
//   - Network-first for dynamic HTML/JSON
//   - Cache-first for /vendor/ assets (xterm is big)
//   - Always network-only for /api/ and /ws

const VERSION = 'tvoice-v11-audit-hardening';
const SHELL = [
  '/',
  '/css/tvoice.css',
  '/css/toolbar.css',
  '/css/tabs.css',
  '/css/ai-render.css',
  '/js/app.js',
  '/js/terminal.js',
  '/js/toolbar.js',
  '/js/tabs.js',
  '/js/gestures.js',
  '/js/ai-render.js',
  '/js/voice.js',
  '/js/reconnect.js',
  '/js/push-client.js',
  '/js/history.js',
  '/js/snippets.js',
  '/js/themes.js',
  '/js/viewport.js',
  '/vendor/xterm.js',
  '/vendor/xterm.css',
  '/vendor/addon-fit.js',
  '/vendor/addon-serialize.js',
  '/vendor/addon-web-links.js',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      // Use addAll with best-effort: individual failures shouldn't abort install
      await Promise.all(
        SHELL.map((url) =>
          fetch(url, { credentials: 'same-origin' })
            .then((res) => {
              if (!res.ok) return;
              return cache.put(url, res.clone());
            })
            .catch(() => {})
        )
      );
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Nuke every old cache, not just the ones whose name doesn't match the
      // current VERSION. The SW itself is the only cache governance we keep.
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
      // Force every controlled client to reload so they pick up the new
      // shell. Without this, iOS PWAs can stay stuck on the old HTML for
      // hours even with skipWaiting() + claim().
      try {
        const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of all) {
          if (client.url && 'navigate' in client) {
            try { await client.navigate(client.url); } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Never intercept API or WebSocket
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/ws')) return;

  // HTML shell + the service worker itself + the manifest — never cache.
  // These drive the "can I see new UI" question; caching them is what causes
  // the stuck-on-old-shell bug on iOS PWAs.
  if (
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/sw.js' ||
    url.pathname === '/manifest.webmanifest'
  ) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  // Cache-first for vendor
  if (url.pathname.startsWith('/vendor/')) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // Network-first for everything else, falling back to cache
  event.respondWith(networkFirst(event.request));
});

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    return new Response('offline', { status: 503 });
  }
}

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(request);
    if (res.ok && request.method === 'GET') cache.put(request, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response('offline', { status: 503 });
  }
}

// Push notification handler
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Tvoice', body: event.data?.text?.() || '' }; }
  const title = data.title || 'Tvoice';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'tvoice',
    data: data.data || {},
    requireInteraction: !!data.requireInteraction,
    actions: data.actions || [],
    vibrate: [60, 30, 60],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const action = event.action;
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        if ('focus' in client) {
          await client.focus();
          client.postMessage({ type: 'notification-action', action, data: event.notification.data });
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
    })()
  );
});
