// After a factory reset (M7 amendment §2): this page forgets what it kept of the Nova that was
// erased: its device key (device-key.js), its drafts and every other nova.* entry in this browser's
// storage, and every offline copy the service worker kept. Other apps' storage is left alone.
// Each part is tried on its own, so a browser without one of them still forgets the rest.
import { forget } from './device-key.js';

const dropNova = (s) => {
  try {
    const names = [];
    for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k?.startsWith('nova.')) names.push(k); }
    for (const k of names) s.removeItem(k);
  } catch { /* storage may be off */ }
};

export async function forgetHere() {
  try { await forget(); } catch { /* no IndexedDB, or no key: the rest still goes */ }
  if (globalThis.localStorage) dropNova(localStorage);
  if (globalThis.sessionStorage) dropNova(sessionStorage);
  try {
    if (globalThis.caches) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
  } catch { /* no Cache API */ }
}
