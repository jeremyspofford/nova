// The status icon's preview in the living styleguide (/styleguide?entry=status-icon): every state at
// 16, 24 and 48 px, one 96 px hero with a button per state, a change mid-transition, and a
// reduced-motion switch. Demo only: nothing here reaches Nova.
import { STATUS_ICON_STATES, setReducedMotion, statusIcon } from './status-icon.js';

const SIZES = [16, 24, 48];
let forced = null;
// The demo first lets the hero settle at idle, so the change always starts from the same place.
const MIDWAY_START = 450;

export function statusIconEntry() {
  const cells = STATUS_ICON_STATES.map((s) => `<span class="sg-name">${s}</span>${SIZES.map((px) => `<span class="si-tile" data-si-cell="${s}-${px}"></span>`).join('')}`).join('');
  return `<div class="si-preview" data-si-preview>
<div class="si-hero"><span class="si-tile si-tile-hero" data-si-hero></span>
<div class="si-controls"><p class="sg-label">Set the hero’s state</p>
<div class="sg-demo-row" role="group" aria-label="Set the hero’s state">${STATUS_ICON_STATES.map((s) => `<button type="button" class="btn small" data-si-set="${s}">${s}</button>`).join('')}</div>
<div class="sg-demo-row"><button type="button" class="btn" data-si-midway>Idle → working, then needs-you 150 ms later</button>
<label class="si-reduce"><input type="checkbox" data-si-reduced> Reduced motion</label></div></div></div>
<div class="si-sheet" data-si-sheet><span></span>${SIZES.map((px) => `<span class="sg-name">${px} px</span>`).join('')}${cells}</div></div>`;
}

export function bindStatusIcons(root) {
  const preview = root.querySelector('[data-si-preview]');
  if (!preview) return;
  for (const cell of preview.querySelectorAll('[data-si-cell]')) {
    const [, s, px] = /^(.+)-(\d+)$/.exec(cell.dataset.siCell);
    cell.append(statusIcon({ status: s, size: Number(px) }));
  }
  // Success never rests: the sheet replays its flourish so it can be seen.
  const flourish = [...preview.querySelectorAll('[data-si-cell^="success-"] .status-icon')];
  const replay = setInterval(() => (flourish[0].isConnected ? flourish.forEach((el) => el.setStatus('success')) : clearInterval(replay)), 2200);
  const hero = statusIcon({ status: 'idle', size: 96 });
  preview.querySelector('[data-si-hero]').append(hero);
  const box = preview.querySelector('[data-si-reduced]');
  box.checked = forced ?? matchMedia('(prefers-reduced-motion: reduce)').matches;
  box.addEventListener('change', () => { forced = box.checked || null; setReducedMotion(forced); });
  preview.addEventListener('click', (e) => {
    const set = e.target.closest('[data-si-set]');
    if (set) hero.setStatus(set.dataset.siSet);
    if (e.target.closest('[data-si-midway]')) {
      hero.setStatus('idle');
      setTimeout(() => hero.setStatus('working'), MIDWAY_START);
      setTimeout(() => hero.setStatus('needs-you'), MIDWAY_START + 150);
    }
  });
}
