// Service worker: keeps the app shell available offline. API calls are never cached; they
// always go to the Hub (FR-125: clients hold no canonical state).
const CACHE = 'nova-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/')
  )
    return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/')));
    return;
  }
  event.respondWith(
    caches.match(event.request).then(
      (hit) =>
        hit ??
        fetch(event.request).then((res) => {
          if (res.ok && url.pathname.startsWith('/assets/')) {
            const copy = res.clone();
            void caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return res;
        }),
    ),
  );
});

// Push (FR-111, docs/13 §6, decisions 6-7 of ADR-095). The Hub's Web Push payload carries only
// ids, a title of the detail the owner chose (`push.detail`), the category, the in-app path and the
// deep link: `{v: 1, id, category, title, path, link, at}`. The notification shows that title and
// nothing else (no body: the payload carries none). A payload that does not parse still shows
// "Nova" (a push must show something), opening the app. The tag is the notification id, so the
// page's own OS notification for the same event (src/notifications/os.ts) replaces, not doubles.
const PUSH_CATEGORIES = ['approval', 'completion', 'error', 'attention', 'system'];
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** A same-origin app path, or null: never another origin, a scheme or `//host`. */
function safePath(raw) {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  try {
    const u = new URL(raw, self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search + u.hash : null;
  } catch {
    return null;
  }
}

/** Where a decision-7 deep link opens: `nova://run/<id>`, `code/<id>`, `approval/<id>`. */
function linkPath(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^nova:\/\/(run|code|approval|chat)\/([A-Za-z0-9_-]{1,100})$/.exec(raw);
  if (!m) return null;
  const id = m[2];
  if (m[1] === 'run') return '/work/' + id;
  if (m[1] === 'code') return '/code/' + id;
  if (m[1] === 'chat') return '/chat/' + id;
  return '/approvals/' + id;
}

/** The notification a push payload shows, from its fields only. */
function pushNotification(payload) {
  const p = payload && typeof payload === 'object' ? payload : null;
  const ok = p !== null && p.v === 1 && typeof p.id === 'string' && SAFE_ID.test(p.id);
  if (!ok) return { title: 'Nova', options: { data: { href: '/' } } };
  const category = PUSH_CATEGORIES.includes(p.category) ? p.category : 'system';
  const title = typeof p.title === 'string' && p.title.trim() ? p.title.slice(0, 120) : 'Nova';
  const href = safePath(p.path) || linkPath(p.link) || '/';
  const options = {
    tag: p.id,
    data: { href, id: p.id, category },
    icon: '/icon.svg',
    badge: '/icon.svg',
    // Approvals stay until answered or dismissed; the rest may go away by themselves.
    requireInteraction: category === 'approval',
  };
  const at = typeof p.at === 'string' ? Date.parse(p.at) : NaN;
  if (Number.isFinite(at)) options.timestamp = at;
  if (category === 'approval')
    options.actions = [
      { action: 'open', title: 'Open' },
      { action: 'approvals', title: 'All approvals' },
    ];
  return { title, options };
}

function readPayload(data) {
  if (!data) return null;
  try {
    return data.json();
  } catch {
    return null;
  }
}

self.addEventListener('push', (event) => {
  const n = pushNotification(readPayload(event.data));
  event.waitUntil(self.registration.showNotification(n.title, n.options));
});

// A notification shown by this worker (FR-013, FR-111) opens or focuses the app at its link. Only
// same-origin paths are followed; the approval's "All approvals" action opens the approvals page.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const href =
    event.action === 'approvals' ? '/approvals' : safePath(data.href) || linkPath(data.link) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const target = new URL(href, self.location.origin).href;
      for (const client of list) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          return client.focus().then((c) => (c && 'navigate' in c ? c.navigate(target) : c));
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
