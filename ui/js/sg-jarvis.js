// Jarvis rings in the living styleguide (/styleguide?entry=jarvis): compositions for the owner's
// reaction (2026-11-08, step 1), not a shipped theme. Every state at 16, 24, 48 and 96 px on a
// near-black surface, one HUD core at hero size driven by a button per state, a reduced-motion
// switch and a speaking-amplitude slider. Demo only: nothing here reaches Nova.
import { JARVIS_STATES, jarvisCore } from './jarvis-ring.js';

const SIZES = [16, 24, 48, 96];
const HERO = 200;
// Success never rests: the sheet replays its flourish so it can be seen. wait: clock: the replay
const REPLAY_MS = 2800;

export function jarvisEntry() {
  const rows = JARVIS_STATES.map((s) => `<span class="jv-name">${s}</span>${SIZES.map((px) => `<span class="jv-cell" role="img" aria-label="${s}, ${px} px" data-jv-cell="${s}-${px}"></span>`).join('')}`).join('');
  return `<div class="jv-surface" data-jv-preview>
<p class="jv-note"><strong>Compositions for the owner’s reaction, not a shipped theme.</strong> No design system, token or Appearance choice yet; the Nebula status icon is unchanged. Rings, arcs and ticks in one cyan family; red only for stopped, amber only for needs-you; each state told apart by its structure. Morphs take 800 ms; success settles to idle after a second.</p>
<div class="jv-hero-row"><div class="jv-hero" data-jv-hero></div>
<div class="jv-controls"><p class="jv-label" id="jv-set-label">Set the HUD core’s state</p>
<div class="jv-row" role="group" aria-labelledby="jv-set-label">${JARVIS_STATES.map((s) => `<button type="button" class="jv-btn" data-jv-set="${s}" aria-pressed="${s === 'idle'}">${s}</button>`).join('')}</div>
<p class="jv-label">Speaking amplitude</p>
<div class="jv-row"><input type="range" class="jv-amp-input" min="0" max="100" value="50" data-jv-amp aria-label="Speaking amplitude"><output class="jv-readout" data-jv-readout>off</output><button type="button" class="jv-btn" data-jv-pulse>Gentle default pulse</button></div>
<div class="jv-row"><label class="jv-switch"><input type="checkbox" data-jv-reduced> Reduced motion</label></div></div></div>
<div class="jv-sheet-wrap"><div class="jv-sheet" data-jv-sheet><span class="jv-head">state</span>${SIZES.map((px) => `<span class="jv-head">${px} px</span>`).join('')}${rows}</div></div></div>`;
}

let forced = null;
export function bindJarvis(root) {
  const preview = root.querySelector('[data-jv-preview]');
  if (!preview) return;
  const cores = [];
  for (const cell of preview.querySelectorAll('[data-jv-cell]')) {
    const [, s, px] = /^(.+)-(\d+)$/.exec(cell.dataset.jvCell);
    const core = jarvisCore({ status: s, size: Number(px) });
    core.removeAttribute('role'); // the cell is the image, named by state and size
    core.setAttribute('aria-hidden', 'true');
    cell.append(core);
    cores.push(core);
  }
  const flourish = cores.filter((c) => c.parentElement.dataset.jvCell.startsWith('success-'));
  // Success never rests: the sheet replays its flourish so it can be seen. wait: clock: the replay
  const replay = setInterval(() => (flourish[0].isConnected ? flourish.forEach((el) => el.setStatus('success')) : clearInterval(replay)), REPLAY_MS);
  const hero = jarvisCore({ status: 'idle', size: HERO });
  preview.querySelector('[data-jv-hero]').append(hero);
  cores.push(hero);
  if (forced !== null) cores.forEach((c) => c.setReduced(forced));

  const pressed = (s) => preview.querySelectorAll('[data-jv-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.jvSet === s)));
  const set = (s) => { hero.setStatus(s); pressed(s); };
  // The buttons follow the hero when success settles to idle by itself.
  new MutationObserver(() => pressed(hero.dataset.status)).observe(hero, { attributes: true, attributeFilter: ['data-status'] });

  const box = preview.querySelector('[data-jv-reduced]');
  box.checked = forced ?? matchMedia('(prefers-reduced-motion: reduce)').matches;
  box.addEventListener('change', () => { forced = box.checked || null; cores.forEach((c) => c.setReduced(forced)); });

  const amp = preview.querySelector('[data-jv-amp]');
  const readout = preview.querySelector('[data-jv-readout]');
  amp.addEventListener('input', () => {
    const a = Number(amp.value) / 100;
    readout.textContent = a.toFixed(2);
    hero.setAmplitude(a);
    if (hero.dataset.status !== 'speaking') set('speaking');
  });
  preview.querySelector('[data-jv-pulse]').addEventListener('click', () => {
    hero.setAmplitude(null);
    readout.textContent = 'off';
    set('speaking');
  });
  preview.addEventListener('click', (e) => {
    const b = e.target.closest('[data-jv-set]');
    if (b) set(b.dataset.jvSet);
  });
}
