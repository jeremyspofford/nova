// Nova's service worker. The app shell is cached so Nova opens without a connection; every
// request still tries the network first, so what you see is live whenever Nova is reachable.
// When it isn't, a GET is answered from the cache and marked x-nova-offline, and the page says
// so: an honest offline state, never stale data presented as live. Changes (POST, PUT, DELETE)
// and the event streams are never cached or answered offline.
// The server fills in the cache name when it serves this file: a hash of this worker and the SHELL
// files (src/sw-version.js). Never edit it by hand; a changed shell file changes it by itself.
const VERSION = 'nova-shell-__SHELL_HASH__';
const SHELL = [
  '/', '/manifest.webmanifest', '/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/mark-1024.webp',
  '/styles/base.css', '/styles/components.css', '/styles/views.css', '/styles/layout.css', '/styles/models.css', '/styles/changes.css', '/styles/reset.css', '/styles/stage2.css', '/styles/palette.css', '/styles/status-icon.css',
  '/js/app.js', '/js/core.js', '/js/shell.js', '/js/layout.js', '/js/nav.js', '/js/status.js', '/js/components.js',
  '/js/surfaces.js', '/js/setup.js', '/js/theme.js', '/js/view.js', '/js/markdown.js', '/js/reduce.js', '/js/qr.js', '/js/device-key.js', '/js/takeover.js',
  '/js/connections.js', '/js/sites.js', '/js/capture.js', '/js/models.js', '/js/approvals.js', '/js/changes.js', '/js/checkpoints.js', '/js/services.js', '/js/topology.js', '/js/topology-view.js', '/js/reset.js', '/js/forget-here.js', '/js/settings-ia.js', '/js/contrast.js', '/js/look.js', '/js/wait.js', '/js/skeleton.js', '/js/passkey.js', '/js/config.js', '/js/device-models.js', '/js/fit-engine.js', '/js/palette.js', '/js/about.js', '/js/status-icon.js',
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
// factory reset: what it would erase, and whether it happened, are live. The topology is live
// health and action availability too, so even a pre-existing cached copy must be ignored.
// The changelog and pipeline say what is running and what has shipped, so like the version they are live.
// Diagnostics is a per-request attachment; included diagnostic logs may contain free text,
// so neither its current response nor a legacy cached copy may be kept or served offline.
// Passkeys (T2) are live too: a passkey removed must not look present, and a challenge is single use.
// So are approval tiers: a gate shown from a cache could look looser or stricter than it is.
const NEVER = /^\/api\/(?:memory|health|v1\/memory|v1\/receipts|v1\/health|v1\/mesh|v1\/browser|v1\/vault|v1\/connectors|v1\/capture|v1\/models|v1\/changes|v1\/resilience|v1\/reset|v1\/services\/topology|v1\/diagnostics|v1\/version|v1\/changelog|v1\/pipeline|v1\/security|v1\/approvals)(?:\/|$)/;
// Pages the app answers with its shell.
const PAGES = /^\/(?:|chat|new|tasks|memory|automations|skills|schedules|activity|health|settings|capture|topology|about|changelog|pipeline|c\/[\w-]+)$/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

// Upgrading removes only Nova's versioned offline stores, never another cache on this origin:
// the hash-named ones and the hand-numbered ones before them (nova-shell-v1 to v70).
const OURS = /^nova-shell-(?:v\d+|[0-9a-f]{12})$/;
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => OURS.test(k) && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
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
