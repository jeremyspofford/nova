// The browser side of Web Push (FR-111, RFC 8030/8291/8292): whether this page can receive pushes,
// the service worker's PushManager, and which of the Hub's subscriptions is this browser's. The
// pieces are behind small interfaces so tests use a fake PushManager. iPhone and iPad give Web
// Push only to the app added to the Home Screen; a page served over plain HTTP gets none; and the
// service worker (public/sw.js) must be running, which it is in the built app.
import { defineMessages } from '@nova/i18n';
import type { CreatePushSubscriptionRequest } from '@nova/shared';

export interface PushSubscriptionLike {
  readonly endpoint: string;
  readonly options?: { readonly applicationServerKey: ArrayBuffer | null };
  toJSON(): PushSubscriptionJSON;
  unsubscribe(): Promise<boolean>;
}

export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(options: {
    userVisibleOnly: boolean;
    applicationServerKey: Uint8Array<ArrayBuffer>;
  }): Promise<PushSubscriptionLike>;
}

export interface PushRegistrationLike {
  readonly pushManager: PushManagerLike;
}

export type PermissionState = NotificationPermission | 'unsupported';

/** What the section needs from the browser. */
export interface PushEnv {
  /** A secure context (HTTPS, or this computer itself). */
  secure: boolean;
  /** `PushManager` exists here. */
  pushManager: boolean;
  /** A Safari tab on iPhone or iPad (Web Push needs the Home Screen app there). */
  iosTab: boolean;
  permission(): PermissionState;
  requestPermission(): Promise<PermissionState>;
  /** The page's service worker registration, or null when none is running. */
  registration(): Promise<PushRegistrationLike | null>;
  /** Kept per browser: which Hub subscription is this one's. */
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

export type PushSupport =
  | { ok: true; registration: PushRegistrationLike }
  | { ok: false; reason: 'insecure' | 'unsupported' | 'ios-install' | 'no-worker' };

function standalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches)
  );
}

function iosDevice(): boolean {
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1)
  );
}

function safeStorage(): PushEnv['storage'] {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function browserPushEnv(): PushEnv {
  const hasNotification = typeof window.Notification === 'function';
  return {
    secure: window.isSecureContext !== false,
    pushManager: 'PushManager' in window,
    iosTab: iosDevice() && !standalone(),
    permission: () => (hasNotification ? window.Notification.permission : 'unsupported'),
    requestPermission: async () => {
      if (!hasNotification) return 'unsupported';
      try {
        return await window.Notification.requestPermission();
      } catch {
        return window.Notification.permission;
      }
    },
    registration: async () => {
      try {
        const sw = (navigator as Partial<Navigator>).serviceWorker;
        const reg = await sw?.getRegistration();
        return reg && 'pushManager' in reg ? reg : null;
      } catch {
        return null;
      }
    },
    storage: safeStorage(),
  };
}

/** Whether this page can subscribe, or why not. */
export async function pushSupport(env: PushEnv): Promise<PushSupport> {
  if (!env.secure) return { ok: false, reason: 'insecure' };
  if (!env.pushManager) return { ok: false, reason: env.iosTab ? 'ios-install' : 'unsupported' };
  if (env.permission() === 'unsupported') return { ok: false, reason: 'unsupported' };
  const registration = await env.registration();
  return registration ? { ok: true, registration } : { ok: false, reason: 'no-worker' };
}

/** Why this page cannot get push notifications, by `PushSupport` reason. */
export const SUPPORT_TEXT = defineMessages('push.support', {
  insecure:
    'This page is not on a secure connection, so the browser gives it no push notifications. Turn on HTTPS in Network → Trust, or use the Nova app.',
  unsupported: 'This browser cannot receive push notifications.',
  'ios-install':
    'On iPhone and iPad, push notifications work in the Nova app on the Home Screen. Tap Share, then Add to Home Screen, and open Nova from there.',
  'no-worker':
    'Nova’s background worker is not running on this page, so it cannot receive pushes. Reload the page and try again.',
}) satisfies Record<Exclude<PushSupport, { ok: true }>['reason'], string>;

/** base64url (RFC 8292 `k`) → the bytes `subscribe` takes. */
export function vapidKeyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Whether `sub` was made with this application server key (a new Hub key needs a new one). */
export function sameServerKey(sub: PushSubscriptionLike, b64url: string): boolean {
  const key = sub.options?.applicationServerKey;
  if (!key) return true; // the browser does not say: assume it is
  const want = vapidKeyBytes(b64url);
  const have = new Uint8Array(key);
  return have.length === want.length && have.every((b, i) => b === want[i]);
}

/** The body of `POST /push/subscriptions`, or null when the browser gave no keys. */
export function subscriptionBody(
  sub: PushSubscriptionLike,
  label: string,
): CreatePushSubscriptionRequest | null {
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) return null;
  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh, auth },
    label: label.slice(0, 200),
  };
}

// ---- which Hub subscription is this browser's ------------------------------------------------

const MINE_KEY = 'nova.push.subscription';

async function endpointHash(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Remember the Hub's id for this browser's subscription (keyed by a hash of its endpoint). */
export async function rememberMine(env: PushEnv, id: string, endpoint: string): Promise<void> {
  try {
    env.storage?.setItem(MINE_KEY, JSON.stringify({ id, hash: await endpointHash(endpoint) }));
  } catch {
    // storage unavailable: the section matches by nothing and offers to turn on again
  }
}

/** The Hub id of this browser's subscription, when `endpoint` is the one remembered. */
export async function recallMine(env: PushEnv, endpoint: string): Promise<string | null> {
  try {
    const raw = env.storage?.getItem(MINE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { id?: unknown; hash?: unknown };
    if (typeof v.id !== 'string' || typeof v.hash !== 'string') return null;
    return v.hash === (await endpointHash(endpoint)) ? v.id : null;
  } catch {
    return null;
  }
}

export function forgetMine(env: PushEnv): void {
  try {
    env.storage?.removeItem(MINE_KEY);
  } catch {
    // nothing kept
  }
}
