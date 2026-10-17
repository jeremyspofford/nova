// Operating-system notifications (FR-013) through the browser's Notification API. They are shown
// only while the page is hidden and only after the user allowed them on this device; an installed
// PWA (and browsers that allow only that) uses its service worker registration instead.
import type { NotificationView } from '@nova/shared';

export type OsPermission = 'unsupported' | NotificationPermission;

export function osPermission(): OsPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return window.Notification.permission;
}

/** Ask the browser for permission; resolves with the resulting state. */
export async function requestOsPermission(): Promise<OsPermission> {
  if (osPermission() === 'unsupported') return 'unsupported';
  try {
    return await window.Notification.requestPermission();
  } catch {
    return osPermission();
  }
}

async function workerRegistration(): Promise<ServiceWorkerRegistration | null> {
  try {
    const sw = (navigator as Partial<Navigator>).serviceWorker;
    return (await sw?.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

function installed(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(display-mode: standalone)').matches
    : false;
}

/**
 * Show `n` as an OS notification if the page is hidden and permission is granted. `onClick`
 * runs when the user clicks a page-owned notification. Resolves with whether one was shown.
 */
export async function showOsNotification(
  n: NotificationView,
  onClick: () => void,
): Promise<boolean> {
  if (document.visibilityState !== 'hidden' || osPermission() !== 'granted') return false;
  const options: NotificationOptions = {
    tag: n.id,
    data: { href: n.href },
    ...(n.body ? { body: n.body } : {}),
  };
  const reg = installed() ? await workerRegistration() : null;
  if (reg) {
    await reg.showNotification(n.title, options);
    return true;
  }
  try {
    const shown = new window.Notification(n.title, options);
    shown.onclick = () => {
      window.focus();
      onClick();
      shown.close();
    };
    return true;
  } catch {
    // Some mobile browsers refuse page notifications and allow only the service worker's.
    const fallback = await workerRegistration();
    if (!fallback) return false;
    await fallback.showNotification(n.title, options);
    return true;
  }
}
