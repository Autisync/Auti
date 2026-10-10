// Service worker: makes Auti installable and opens instantly. Company data (/api/*) is never cached.
const CACHE = 'auti-shell-v2';
const SHELL = ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;   // straight to the network
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => new Response(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#1C1C1C"><body style="background:#1C1C1C;color:#A8A8A8;font:16px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;text-align:center;padding:0 16px"><div><img src="/icons/icon-192.png" width="72" height="72" alt="" style="border-radius:16px"><div style="color:#FFFFFF;letter-spacing:.3em;font:600 16px system-ui,sans-serif;margin-top:14px">AUTI</div><p>You are offline. Auti will reconnect when you have signal.</p></div>',
      { headers: { 'Content-Type': 'text/html' } })));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
