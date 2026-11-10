// The mark and the status icon in the living styleguide. /styleguide?entry=nova-mark: Nova's mark,
// the traced SVG N on a transparent background (UI item 24), at 16, 24, 48, 96 and 180 px on Nebula
// dark, Nebula light and the Jarvis HUD study, with each look's weakest stop measured against its
// surface, and the owner's artwork it was traced from. /styleguide?entry=status-icon: every state's
// treatment at 16, 24 and 48 px, and a 180 px hero with a button per state, a change mid-transition
// and a reduced-motion switch. Demo only: nothing here reaches Nova.
import { MARK_STOPS, STATUS_ICON_STATES, setReducedMotion, statusIcon } from './status-icon.js';

const SIZES = [16, 24, 48];
export const MARK_SIZES = [16, 24, 48, 96, 180];
// The looks the mark entry shows: Nebula's two (its own tokens, set on the panel), and the HUD
// variant (ui/styles/jarvis-rings.css), which takes its stops from the Jarvis colours.
const LOOKS = [['dark', 'Nebula dark: the full nebula'], ['light', 'Nebula light: the deepened palette, every stop at 4.5:1 or more'], ['hud', 'Jarvis HUD (a styleguide study): one cyan family']];
let forced = null;
// The demo first lets the hero settle at idle, so the change always starts from the same place.
const MIDWAY_START = 900;

// Every state at 16, 24 and 48 px; also drawn on the Nebula acceptance entry (nebula-match).
export function statusIconSheet() {
  const cells = STATUS_ICON_STATES.map((s) => `<span class="sg-name">${s}</span>${SIZES.map((px) => `<span class="si-tile" data-si-cell="${s}-${px}"></span>`).join('')}`).join('');
  return `<div class="si-sheet" data-si-sheet><span></span>${SIZES.map((px) => `<span class="sg-name">${px} px</span>`).join('')}${cells}</div>`;
}

export function markEntry() {
  const look = ([id, words]) => `<figure class="si-look${id === 'hud' ? ' mark-hud' : ''}" data-mark-look="${id}"><figcaption class="sg-name">${words}<span class="si-ratio" data-mark-ratio></span></figcaption>
<div class="si-sizes">${MARK_SIZES.map((px) => `<span class="si-tile" data-mark-size="${px}"></span>`).join('')}</div></figure>`;
  return `<div class="si-marks" data-mark-preview>${LOOKS.map(look).join('')}
<figure class="si-look" data-mark-look="trace"><figcaption class="sg-name">Traced from the owner’s artwork: the SVG beside the tile it follows, both at 180 px</figcaption>
<div class="si-sizes"><img src="/icons/mark-1024.webp" width="180" height="180" alt="The owner’s artwork: the nebula N in its dark tile"><span class="si-tile" data-mark-size="180"></span></div></figure></div>`;
}

export function statusIconEntry() {
  return `<div class="si-preview" data-si-preview>
<div class="si-hero"><span class="si-tile" data-si-hero></span>
<div class="si-controls"><p class="sg-label">Set the hero’s state</p>
<div class="sg-demo-row" role="group" aria-label="Set the hero’s state">${STATUS_ICON_STATES.map((s) => `<button type="button" class="btn small" data-si-set="${s}">${s}</button>`).join('')}</div>
<div class="sg-demo-row"><button type="button" class="btn" data-si-midway>Idle → working, then needs-you 150 ms later</button>
<label class="si-reduce"><input type="checkbox" data-si-reduced> Reduced motion</label></div></div></div>
<p class="sg-label">Every state’s treatment</p>
${statusIconSheet()}</div>`;
}

// WCAG contrast of two sRGB colours (0..255).
function ratio(a, b) {
  const lum = (c) => { const [r, g, bl] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
// A panel's resolved colour of a custom property, as sRGB 0..255 (a canvas resolves color-mix()).
function resolved(el, prop) {
  const probe = document.createElement('span');
  probe.style.setProperty('color', `var(${prop})`);
  el.append(probe);
  const c = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  c.fillStyle = getComputedStyle(probe).color;
  c.fillRect(0, 0, 1, 1);
  probe.remove();
  return [...c.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}

// Nebula's own tokens on each Nebula panel (whatever the page's design), then the mark at each size,
// and the weakest stop's contrast on that panel's surface.
async function bindMarks(root) {
  const preview = root.querySelector('[data-mark-preview]');
  if (!preview) return;
  let pkg = null;
  try { pkg = (await fetch('/api/v1/design-systems/nebula').then((r) => r.json())).manifest; } catch { /* the panels keep the page's own design */ }
  for (const panel of preview.querySelectorAll('[data-mark-look]')) {
    const id = panel.dataset.markLook;
    const set = pkg && (id === 'dark' || id === 'trace' ? { ...pkg.tokens, ...pkg.modes?.dark } : id === 'light' ? pkg.tokens : null);
    if (set) for (const [name, v] of Object.entries(set)) if (/^(bg|surface|text|mark)\//.test(name)) panel.style.setProperty(`--${name.replace('/', '-')}`, v);
    // The HUD keeps the page's light or dark: its colours pick their ends by it (jarvis-rings.css).
    if (id !== 'hud') panel.dataset.scheme = id === 'light' ? 'light' : 'dark';
    for (const cell of panel.querySelectorAll('[data-mark-size]')) cell.append(statusIcon({ status: 'idle', size: Number(cell.dataset.markSize), label: () => `Nova’s mark, ${id === 'trace' ? 'dark' : id}, ${cell.dataset.markSize} px` }));
    const out = panel.querySelector('[data-mark-ratio]');
    if (!out) continue;
    const surface = resolved(panel, id === 'hud' ? '--jv-bg' : '--bg-base');
    const prop = (n) => (id === 'hud' ? `--mark-variant-${n}` : `--mark-${n}`);
    const weakest = MARK_STOPS.map((n) => [n, ratio(resolved(panel, prop(n)), surface)]).sort((a, b) => a[1] - b[1])[0];
    out.textContent = ` · weakest stop ${weakest[0]} at ${weakest[1].toFixed(2)}:1 on its surface`;
    panel.dataset.weakest = weakest[1].toFixed(2);
  }
  preview.dataset.ready = '';
}

export function bindStatusIcons(root) {
  bindMarks(root);
  for (const cell of root.querySelectorAll('[data-si-cell]')) {
    const [, s, px] = /^(.+)-(\d+)$/.exec(cell.dataset.siCell);
    cell.append(statusIcon({ status: s, size: Number(px) }));
  }
  // Task rows (components.js taskRow) leave a slot for their own state; the app fills it (shell.js),
  // here a still sample does. A finished task's flourish is the app's, so the sample shows none.
  for (const slot of root.querySelectorAll('[data-task-icon]')) {
    const s = slot.dataset.taskIcon;
    if (s === 'success') { slot.remove(); continue; }
    const el = statusIcon({ status: s, size: 16, decorative: true });
    el.classList.add('task-icon');
    slot.replaceWith(el);
  }
  // Success never rests: the sheet replays its flourish so it can be seen. wait: clock: the replay
  const flourish = [...root.querySelectorAll('[data-si-cell^="success-"] .status-icon')];
  if (flourish.length) { const replay = setInterval(() => (flourish[0].isConnected ? flourish.forEach((el) => el.setStatus('success')) : clearInterval(replay)), 3400); }
  const preview = root.querySelector('[data-si-preview]');
  if (!preview) return;
  const hero = statusIcon({ status: 'idle', size: 180 });
  preview.querySelector('[data-si-hero]').append(hero);
  const box = preview.querySelector('[data-si-reduced]');
  box.checked = forced ?? matchMedia('(prefers-reduced-motion: reduce)').matches;
  box.addEventListener('change', () => { forced = box.checked || null; setReducedMotion(forced); });
  preview.addEventListener('click', (e) => {
    const set = e.target.closest('[data-si-set]');
    if (set) hero.setStatus(set.dataset.siSet);
    if (e.target.closest('[data-si-midway]')) {
      // wait: clock: the demo’s script (idle, then working, then needs-you 150 ms into that change)
      hero.setStatus('idle');
      setTimeout(() => hero.setStatus('working'), MIDWAY_START);
      setTimeout(() => hero.setStatus('needs-you'), MIDWAY_START + 150);
    }
  });
}
