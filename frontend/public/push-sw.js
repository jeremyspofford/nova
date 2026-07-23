/* Web Push handlers, pulled into the generated Workbox service worker via
 * vite.config.ts `workbox.importScripts`. Dependency-free on purpose.
 *
 * Payload contract (backend app/push.py): { title, body, tags, url }. */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Nova';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
  };
  event.waitUntil((async () => {
    // "While away" is decided here, not on the server: if a Nova window is
    // visible, the in-app surfaces already show the news — stay quiet.
    // EXCEPT on iOS: Safari revokes subscriptions that repeatedly consume a
    // push without showing anything (silent-push budget), so there we
    // always show — a banner while the app is open is native iOS behavior.
    const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (!ios) {
      const wins = await self.clients.matchAll(
        { type: 'window', includeUncontrolled: true });
      if (wins.some((w) => w.visibilityState === 'visible')) return;
    }
    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll(
      { type: 'window', includeUncontrolled: true });
    if (wins.length > 0) {
      await wins[0].focus();
      if ('navigate' in wins[0]) await wins[0].navigate(url);
      return;
    }
    await self.clients.openWindow(url);
  })());
});
