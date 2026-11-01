// Appearance: which design system this device shows, and light, dark or auto. Both live in the
// core (/api/v1/design-systems and the profile): a choice is for the person (every device) or for
// this device only, and the last change can be rolled back. A change arrives as a
// `design-system` event on the core's stream; the page then swaps the CSS in <style id="ds">,
// with no reload and no restart.
import { V1, api, deviceId, stream } from './core.js';

export const MODES = ['auto', 'light', 'dark'];
const state = { theme: null, mode: 'auto', scope: 'default', list: [], user: null, device: null, canRollback: { user: false, device: false }, fix: null, checks: [] };
export const current = () => ({ ...state, list: [...state.list] });

// While the person tries a design for all their devices, this page shows it before anything is
// saved (preview); the saved one comes back with swap() on Save or Cancel.
let previewing = null;
export const previewingNow = () => previewing;

const query = () => `?device=${encodeURIComponent(deviceId())}`;

// Fetches the active design system's CSS for this device and puts it in place of the old one.
export async function swap({ force = false } = {}) {
  if (previewing && !force) return;
  const res = await fetch(`/design-system.css${query()}`, { cache: 'no-store' });
  if (!res.ok) return;
  document.getElementById('ds').textContent = await res.text();
  document.getElementById('ds-boot')?.remove();
}

export async function refresh() {
  const [list, active, profile, schema] = await Promise.all([api('GET', '/design-systems'), api('GET', `/design-systems/active${query()}`), api('GET', '/profile').catch(() => ({})),
    state.checks.length ? null : api('GET', '/design-systems/schema').catch(() => null)]);
  if (schema?.live_checks) state.checks = schema.live_checks;
  const a = profile?.appearance ?? {};
  Object.assign(state, {
    list,
    theme: active.id,
    mode: active.mode,
    scope: active.scope,
    user: typeof a.design_system === 'string' ? a.design_system : null,
    device: a.device_overrides?.[deviceId()] ?? null,
    canRollback: { user: typeof a.previous === 'string', device: !!a.device_previous && deviceId() in a.device_previous },
    fix: active.fix ?? null,
  });
  document.documentElement.dataset.theme = active.id;
  document.documentElement.dataset.mode = active.mode;
  statusBar(active);
  window.dispatchEvent(new CustomEvent('nova:appearance', { detail: current() }));
}

// The installed iPhone app's status bar (DESIGN-SYSTEM §5; the tag in index.html): what this
// device's design declares for light and dark, picked as its CSS is (the mode, or the system's
// preference under auto). iOS reads the tag at launch, so a change made here may only show once
// the app is opened again; keeping it current means that next launch is right.
function statusBar(active) {
  const tag = document.getElementById('ios-status-bar');
  const bar = active?.ios_status_bar;
  if (!tag || !bar) return;
  Object.assign(tag.dataset, { light: bar.light, dark: bar.dark, mode: active.mode });
  pickStatusBar();
  // The server can't read this device's appearance id (it is in localStorage), so it is also kept
  // in a first-party cookie: the next launch's page then carries this device's own design's words.
  try { document.cookie = `nova-appearance=${deviceId()}; Path=/; Max-Age=31536000; SameSite=Strict`; } catch { /* cookies off: the person's design's words */ }
}
function pickStatusBar() {
  const tag = document.getElementById('ios-status-bar');
  if (!tag) return;
  const d = tag.dataset;
  const dark = d.mode === 'dark' || (d.mode !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  const want = (dark ? d.dark : d.light) === 'translucent' ? 'black-translucent' : 'default';
  if (tag.content !== want) tag.content = want;
}

let following = false;
// Loads this device's design system and follows the core's stream for changes made anywhere.
export function apply() {
  swap().catch(() => {});
  refresh().catch(() => {});
  if (following) return;
  following = true;
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', pickStatusBar);
  stream().addEventListener('design-system', () => { swap().catch(() => {}); refresh().catch(() => {}); });
}

async function settle() {
  // The event does this too; doing it here keeps the page right if the stream is down.
  previewing = null;
  await swap({ force: true });
  await refresh();
}

// Shows a design system (and a light or dark choice) on this page only; nothing is saved.
export async function preview(id, mode) {
  const res = await fetch(previewCss(id, mode), { cache: 'no-store' });
  if (!res.ok) throw new Error('Nova couldn’t show that design here.');
  previewing = { id, mode };
  document.getElementById('ds').textContent = await res.text();
  document.getElementById('ds-boot')?.remove();
}

// Back to what is saved for this device.
export async function endPreview() {
  if (!previewing) return;
  previewing = null;
  await swap({ force: true });
}

// The design every device shows by the person's choice (or the default): what this device
// follows when it has no design of its own.
export async function syncedId() {
  return (await api('GET', '/design-systems/active')).id;
}

// This device drops its own design and shows the person's again.
export async function follow() {
  await api('POST', '/design-systems/follow', { device_id: deviceId() });
  await settle();
}

// The live contrast check's one-tap fix for this device, and taking it away again.
export async function fixContrast() {
  const out = await api('POST', '/design-systems/contrast-fix', { device_id: deviceId() });
  await settle();
  return out;
}
export async function undoFix() {
  await api('POST', '/design-systems/contrast-fix/undo', { device_id: deviceId() });
  await settle();
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
