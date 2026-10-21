// Theme and appearance: a theme is a token file; the mode picks its light or
// dark values. Stored per browser, since it describes this screen.
export const THEMES = [
  { id: 'paper', name: 'Paper', note: 'Warm paper, ink, a serif voice.' },
  { id: 'aurora', name: 'Aurora', note: 'Frosted glass and morning light.' },
  { id: 'obsidian', name: 'Obsidian', note: 'A quiet control room. Always dark.' },
];
export const MODES = ['system', 'light', 'dark'];

const get = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

export const current = () => ({ theme: get('nova.theme', document.documentElement.dataset.theme), mode: get('nova.mode', 'system') });

const media = matchMedia('(prefers-color-scheme: dark)');

export function apply({ theme, mode } = current()) {
  const root = document.documentElement;
  root.dataset.theme = THEMES.some((t) => t.id === theme) ? theme : 'paper';
  root.dataset.mode = mode === 'system' ? (media.matches ? 'dark' : 'light') : mode;
}

export function choose(patch) {
  const next = { ...current(), ...patch };
  set('nova.theme', next.theme);
  set('nova.mode', next.mode);
  apply(next);
}

media.addEventListener('change', () => apply());
