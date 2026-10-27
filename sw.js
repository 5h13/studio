/* 5H13studio service worker — app shell offline, everything else stale-while-revalidate */
const VERSION = '1.8.0';
const SHELL = `5h13-shell-${VERSION}`;
const RUNTIME = '5h13-runtime';
const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./fonts/bricolage.woff2",
  "./fonts/inter.woff2",
  "./fonts/playfair-italic.woff2",
  "./fonts/playfair.woff2",
  "./fonts/space-grotesk.woff2",
  "./icons/apple-touch-icon.png",
  "./icons/brand-stamp.png",
  "./icons/favicon-32.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./manifest.webmanifest"
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('5h13-shell-') && k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith('http')) return;
  const url = new URL(req.url);

  // Google AI (Gemini) requests are never cached: key checks and readings must always be live
  if (url.hostname.endsWith('googleapis.com')) return;

  // Page navigations: network first so updates arrive, cached shell when offline
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./index.html', { ignoreSearch: true })));
    return;
  }

  // Own files: cache first. The AI remover's files (ai/, ~15 MB) are kept after their first use, not at install.
  if (url.origin === location.origin) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
      if (res && res.ok && url.pathname.includes('/ai/')) { const copy = res.clone(); caches.open(RUNTIME).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  // CDN (OCR engine): stale-while-revalidate
  e.respondWith(
    caches.open(RUNTIME).then(async cache => {
      const hit = await cache.match(req);
      const net = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    })
  );
});
