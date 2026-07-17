/** Clock formatting that honors Settings → Operator → Time format.
 *
 * The backend owns the same choice for journal stamps and Nova's spoken
 * clock (app/timefmt.py); this is the UI half. Self-seeds from settings on
 * first use and tracks live edits via the shared setting-changed event, so
 * a flip lands without a reload (values refresh on the next render).
 */

import { getSettings } from './api';

let hour12 = true; // mirrors the backend default '12h'
let seeded = false;

function seed() {
  if (seeded) return;
  seeded = true;
  getSettings().then(defs => {
    hour12 = defs.find(d => d.key === 'nova.time_format')?.value !== '24h';
  }).catch(() => {});
  window.addEventListener('nova:setting-changed', e => {
    const { key, value } = (e as CustomEvent).detail as { key: string; value: unknown };
    if (key === 'nova.time_format') hour12 = value !== '24h';
  });
}

export function fmtTime(iso: string): string {
  seed();
  return new Date(iso).toLocaleTimeString(undefined,
    { hour12, hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export function fmtDateTime(iso: string): string {
  seed();
  return new Date(iso).toLocaleString(undefined,
    { hour12, year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit' });
}
