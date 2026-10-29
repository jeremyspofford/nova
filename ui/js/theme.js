// Appearance: which design system Nova shows, and light, dark or auto. Both live in the core
// (/api/v1/design-systems and the profile), so a choice holds on every device. A change arrives
// as a `design-system` event on the core's stream; the page then swaps the CSS in <style id="ds">,
// with no reload. A device id, if the PWA set one, picks up that device's own choice.
export const THEMES = []; // [{id, name, note}], from the API
export const MODES = ['auto', 'light', 'dark'];

const state = { theme: null, mode: 'auto' };
export const current = () => ({ ...state });

const device = () => { try { return localStorage.getItem('nova.device'); } catch { return null; } };
const query = () => (device() ? `?device=${encodeURIComponent(device())}` : '');

async function call(method, path, body) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-nova': '1' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = res.headers.get('content-type')?.startsWith('application/json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error ?? 'Nova couldn’t change the appearance.');
  return data;
}

// Fetches the active design system's CSS and puts it in place of the old one.
export async function swap() {
  const res = await fetch(`/design-system.css${query()}`, { cache: 'no-store' });
  if (!res.ok) return;
  document.getElementById('ds').textContent = await res.text();
  document.getElementById('ds-boot')?.remove();
}

async function refresh() {
  const [list, active] = await Promise.all([call('GET', '/api/v1/design-systems'), call('GET', `/api/v1/design-systems/active${query()}`)]);
  THEMES.splice(0, THEMES.length, ...list.filter((d) => d.valid && d.state !== 'disabled').map((d) => ({ id: d.id, name: d.name, note: d.description })));
  state.theme = active.id;
  state.mode = active.mode;
  document.documentElement.dataset.theme = active.id;
  document.documentElement.dataset.mode = active.mode;
  window.dispatchEvent(new CustomEvent('nova:appearance', { detail: current() }));
}

let following = false;
// Loads the choice and follows the core's stream for changes made anywhere.
export function apply() {
  refresh().catch(() => {});
  if (following) return;
  following = true;
  new EventSource('/api/v1/events').addEventListener('design-system', () => { swap().catch(() => {}); refresh().catch(() => {}); });
}

// A pick in Settings: applies the design system for the person, or sets the mode.
export async function choose(patch) {
  if (patch.theme && patch.theme !== state.theme) await call('POST', `/api/v1/design-systems/${encodeURIComponent(patch.theme)}/apply`, { scope: 'user' });
  if (patch.mode && patch.mode !== state.mode) await call('PUT', '/api/v1/profile/appearance/mode', { value: patch.mode });
  // The event does this too; doing it here keeps the page right if the stream is down.
  await swap();
  await refresh();
}
