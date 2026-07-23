# Web Push — Nova notifies the installed PWA natively

> **Status 2026-07-23: BUILT, uncommitted.** Planned interactively with
> Jeremy (transport: Web Push to the PWA, ntfy stays as the local-only
> alternative; triggers: existing notify traffic + new recommendations +
> reply-finished-while-away; taps deep-link per kind). Everything below is
> implemented and verified except the physical phone test, which only
> Jeremy can run (see Verification).

## How it works

- **Provider**: `webpush` joins the notify provider registry
  (`backend/app/notify.py` `WebPushProvider`); select it in Settings →
  Notifications → Provider. Single-provider selection unchanged.
- **Identity**: one VAPID keypair per fleet, generated lazily into
  `push_vapid` (migration 048) — shared DB so every instance can deliver.
  Deliberately not in the settings store (private key never renders in UI).
- **Subscriptions**: `push_subscriptions` (mig 048), one row per device,
  upsert by endpoint. Endpoints returning 404/410 are pruned on send;
  other failures increment a per-row counter. Managed via
  `/api/v1/push/{pubkey,subscribe,unsubscribe,subscriptions}` +
  the "Push on this device" card in Settings → Notifications
  (`frontend/src/components/settings/notifications.tsx PushDeviceCard`).
- **Delivery**: `backend/app/push.py send_all` — pywebpush (new backend
  dep → image rebuild) in `asyncio.to_thread`, gathered across devices;
  payload `{title, body, tags, url}`, aes128gcm-encrypted; Urgency header
  mapped from priority.
- **Service worker**: generateSW kept; `workbox.importScripts:
  ['push-sw.js']` pulls `frontend/public/push-sw.js` into the generated
  worker. `push` → showNotification; **suppressed when a Nova window is
  visible, except on iOS** (Safari's silent-push budget revokes
  subscriptions that swallow pushes — there we always show, which is
  native iOS behavior anyway). `notificationclick` → focus + navigate to
  the payload URL, else openWindow.
- **Triggers**:
  - Everything already routed through `notify.send` (resource alerts now
    carry `click=/observability`).
  - New recommendations (`recommendations.create`) → "Nova recommends: …",
    `click=/chat?inbox=open` (ChatPanel opens the inbox from that param).
  - Chat turns longer than `notify.push_reply_min_secs` (default 20s,
    0 = all) → "Nova replied", `click=/chat`; the SW visibility check
    makes it away-only on non-iOS.

## Constraints / notes

- Push requires the **built app** (tailscale HTTPS URL or :8080) — the
  vite dev server registers no service worker, and the Settings card says
  so if Enable is clicked there.
- iOS delivers only to a home-screen-installed PWA over HTTPS — matches
  the existing tailscale serve setup.
- Payloads are end-to-end encrypted; Apple/Google relays see only that a
  push happened. ntfy (builtin server) remains the fully-tailnet-local
  provider.
- VAPID `sub` contact: `mailto:jeremyspofford@gmail.com`
  (`backend/app/push.py _VAPID_SUB`).

## Verified (2026-07-23)

- In-container delivery test: real client keypair + local 410 server —
  encrypted POST delivered, 410 pruned the row, invalid-key device counted
  a failure, cleanup clean.
- `/settings` enum shows `webpush`; `push_reply_min_secs` present; VAPID
  pubkey endpoint mints a correct 65-byte P-256 applicationServerKey.
- tsc + vite build clean; generated `sw.js` contains
  `importScripts("push-sw.js")`; :8080 serves `push-sw.js`; Settings card
  renders on the built app.

## Remaining (operator)

On the phone (installed PWA over the tailscale URL): Settings →
Notifications → **Enable push** → grant → **Send test notification** with
Provider set to `webpush` → lock the phone → notification on the lock
screen → tap → lands at the deep link. Desktop browsers can subscribe the
same way (each device is its own row).
