/* Web Push handlers, pulled into the generated Workbox service worker via
 * vite.config.ts `workbox.importScripts`. Dependency-free on purpose.
 *
 * Payload contract (backend app/push.py):
 *   { title, body, tags, url, notification_id, tag }
 *
 * `notification_id` and `tag` arrived with migration 125. Jeremy, 2026-08-07:
 * "I get push notifications from the PWA but when I click on it, it brings me
 * to chat but doesn't show me what the push notification was." That is this
 * file's half of the bug — `notificationclick` focused whatever window
 * existed and called `navigate`, and on an engine without
 * WindowClient.navigate (iOS standalone PWAs among them) the focus WAS the
 * whole handler. The app came up on chat, the id was gone, and nothing on
 * screen said what had been tapped.
 *
 * TWO MESSAGE TYPES, deliberately:
 *   nova:notification          — a person TAPPED this. The app may mark it
 *                                opened; that is the one state meaning receipt.
 *   nova:notification-arrived  — a push landed while a window was visible and
 *                                the banner was suppressed. Show it, claim
 *                                nothing. */

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
    // The id rides in data AND inside the url. Two carriers because the two
    // click paths below consume different ones, and neither is available on
    // every engine.
    data: { url: data.url || '/', notification_id: data.notification_id || null },
    // A re-push of the same notification REPLACES its banner instead of
    // stacking a second copy on the lock screen.
    ...(data.tag ? { tag: data.tag, renotify: false } : {}),
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
      if (wins.some((w) => w.visibilityState === 'visible')) {
        // Still tell the open window, so the notification appears in the
        // transcript immediately instead of only after the next reload. A
        // suppressed banner is not a suppressed notification.
        //
        // 'nova:notification-ARRIVED', NOT 'nova:notification'. The two are
        // different events and the difference is the only state in this
        // feature that must never be guessed. A tap is a person; a push
        // landing on a window that happens to be visible is a background
        // event — the app may be on a second monitor with nobody in front of
        // it. They shared a message type for one commit, and because the tap
        // handler in ChatPanel marks the row `opened` ("opened on your
        // device") and retires its inbox card, every push that arrived while
        // a window was open recorded a receipt nobody gave. The arrival
        // handler is only allowed to put it on screen.
        for (const w of wins) {
          try {
            w.postMessage({ type: 'nova:notification-arrived',
                            id: options.data.notification_id });
          } catch { /* closing */ }
        }
        return;
      }
    }
    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const url = d.url || '/';
  const id = d.notification_id || null;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll(
      { type: 'window', includeUncontrolled: true });
    if (wins.length > 0) {
      const w = wins[0];
      await w.focus();
      // BOTH channels, in this order, because neither works everywhere.
      //
      // postMessage first: it is the only one an iOS standalone PWA honours,
      // and the app's listener resolves the id without a reload — which is
      // also the nicer behaviour when a window was already open.
      try {
        w.postMessage({ type: 'nova:notification', id, url });
      } catch { /* the client went away between matchAll and now */ }
      // navigate second, when the engine has it: the URL carries the id too,
      // so a client that never received the message (an older build, a
      // window mid-reload) still lands on the right item.
      if ('navigate' in w) {
        try { await w.navigate(url); } catch { /* cross-origin or not allowed */ }
      }
      return;
    }
    await self.clients.openWindow(url);
  })());
});
