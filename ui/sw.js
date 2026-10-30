// Nova's service worker. The app shell is cached so Nova opens without a connection; every
// request still tries the network first, so what you see is live whenever Nova is reachable.
// When it isn't, a GET is answered from the cache and marked x-nova-offline, and the page says
// so: an honest offline state, never stale data presented as live. Changes (POST, PUT, DELETE)
// and the event streams are never cached or answered offline.
const VERSION = 'nova-shell-v8';
const SHELL = [
  '/', '/manifest.webmanifest', '/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png',
  '/styles/base.css', '/styles/components.css', '/styles/views.css', '/styles/layout.css', '/styles/models.css', '/styles/changes.css', '/styles/reset.css',
  '/js/app.js', '/js/core.js', '/js/shell.js', '/js/layout.js', '/js/nav.js', '/js/status.js', '/js/components.js',
  '/js/surfaces.js', '/js/setup.js', '/js/theme.js', '/js/view.js', '/js/markdown.js', '/js/reduce.js', '/js/qr.js', '/js/device-key.js', '/js/takeover.js',
  '/js/connections.js', '/js/capture.js', '/js/models.js', '/js/changes.js', '/js/checkpoints.js', '/js/reset.js', '/js/forget-here.js',
];
// Memory and context receipts are never kept here: a forgotten memory must not survive in a
// cache (owner's standing order 4), so these are network-only.
// Health checks are network-only too: they are how the page learns whether Nova is reachable,
// so a cached answer would say "up" while the server is down. So is the device mesh: a revoked
// device or an answered request must never come back from a cache. Nor is a browser task's live
// picture or its screenshot: what a page showed is the person's, and a frame from the past must
// never pass for the present. Nor are connections and the vault: a disconnected service must not
// look connected, and a home's state must be live. Nor is capture: a forgotten event must not
// survive in a cache either, and the indicator must say what is capturing now. Nor are models
// (M6b): a download’s progress
// and a role's health are live state. Nor are changes (M7a): a change rolled back must never look live. Nor
// is resilience (checkpoints, M7 amendment): after a restore, only what is there now may show. Nor is a
// factory reset: what it would erase, and whether it happened, are live.
const NEVER = /^\/api\/(?:memory|health|v1\/memory|v1\/receipts|v1\/health|v1\/mesh|v1\/browser|v1\/vault|v1\/connectors|v1\/capture|v1\/models|v1\/changes|v1\/resilience|v1\/reset)(?:\/|$)/;
// Pages the app answers with its shell.
const PAGES = /^\/(?:|chat|new|tasks|memory|automations|skills|schedules|activity|health|settings|capture|c\/[\w-]+)$/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const offline = (res) => {
  const headers = new Headers(res.headers);
  headers.set('x-nova-offline', '1');
  return res.blob().then((body) => new Response(body, { status: res.status, statusText: res.statusText, headers }));
};

const unreachable = () => new Response(JSON.stringify({ error: 'Nova’s server isn’t reachable, and this wasn’t saved for offline use.' }), {
  status: 503, headers: { 'content-type': 'application/json', 'x-nova-offline': '1' },
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // Live streams and development reloads go straight to the network.
  if (req.headers.get('accept') === 'text/event-stream' || url.pathname.endsWith('/events') || url.pathname.startsWith('/__dev/') || url.pathname.startsWith('/oauth/')) return;
  const page = req.mode === 'navigate' && PAGES.test(url.pathname);
  const key = page ? '/' : req;
  const api = url.pathname.startsWith('/api/') || url.pathname === '/design-system.css';
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && !NEVER.test(url.pathname) && (api || page || SHELL.includes(url.pathname))) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(key, copy)).catch(() => {});
      }
      return res;
    } catch {
      const hit = NEVER.test(url.pathname) ? null : await caches.match(key, { ignoreSearch: page });
      if (hit) return api ? offline(hit) : hit;
      return api ? unreachable() : Response.error();
    }
  })());
});
