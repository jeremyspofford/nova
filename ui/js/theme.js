// Appearance: which design system this device shows, and light, dark or auto. Both live in the
// core (/api/v1/design-systems and the profile): a choice is for the person (every device) or for
// this device only, and the last change can be rolled back. A change arrives as a
// `design-system` event on the core's stream; the page then swaps the CSS in <style id="ds">,
// with no reload and no restart.
import { V1, api, deviceId, stream } from './core.js';

export const MODES = ['auto', 'light', 'dark'];
const state = { theme: null, mode: 'auto', scope: 'default', list: [], user: null, device: null, canRollback: { user: false, device: false } };
export const current = () => ({ ...state, list: [...state.list] });

const query = () => `?device=${encodeURIComponent(deviceId())}`;

// Fetches the active design system's CSS for this device and puts it in place of the old one.
export async function swap() {
  const res = await fetch(`/design-system.css${query()}`, { cache: 'no-store' });
  if (!res.ok) return;
  document.getElementById('ds').textContent = await res.text();
  document.getElementById('ds-boot')?.remove();
}

export async function refresh() {
  const [list, active, profile] = await Promise.all([api('GET', '/design-systems'), api('GET', `/design-systems/active${query()}`), api('GET', '/profile').catch(() => ({}))]);
  const a = profile?.appearance ?? {};
  Object.assign(state, {
    list,
    theme: active.id,
    mode: active.mode,
    scope: active.scope,
    user: typeof a.design_system === 'string' ? a.design_system : null,
    device: a.device_overrides?.[deviceId()] ?? null,
    canRollback: { user: typeof a.previous === 'string', device: !!a.device_previous && deviceId() in a.device_previous },
  });
  document.documentElement.dataset.theme = active.id;
  document.documentElement.dataset.mode = active.mode;
  window.dispatchEvent(new CustomEvent('nova:appearance', { detail: current() }));
}

let following = false;
// Loads this device's design system and follows the core's stream for changes made anywhere.
export function apply() {
  swap().catch(() => {});
  refresh().catch(() => {});
  if (following) return;
  following = true;
  stream().addEventListener('design-system', () => { swap().catch(() => {}); refresh().catch(() => {}); });
}

async function settle() {
  // The event does this too; doing it here keeps the page right if the stream is down.
  await swap();
  await refresh();
}

// Apply a design system for every device (scope user) or this device only (scope device).
export async function use(id, scope = 'user') {
  await api('POST', `/design-systems/${encodeURIComponent(id)}/apply`, scope === 'device' ? { scope, device_id: deviceId() } : { scope });
  await settle();
}

// One step back, for every device or this one.
export async function rollback(scope = 'user') {
  await api('POST', '/design-systems/rollback', scope === 'device' ? { scope, device_id: deviceId() } : { scope });
  await settle();
}

export async function setMode(mode) {
  await api('PUT', '/profile/appearance/mode', { value: mode });
  await settle();
}

export const previewCss = (id, mode) => `${V1}/design-systems/${encodeURIComponent(id)}/preview.css${mode ? `?mode=${encodeURIComponent(mode)}` : ''}`;
