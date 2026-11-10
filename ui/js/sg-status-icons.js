// The status icon's preview in the living styleguide (/styleguide?entry=status-icon): Nova's mark,
// the owner's artwork, at 16, 24, 48, 96 and 180 px; the image itself as the browser draws it
// (ui/icons/mark.svg); every state's treatment at 16, 24 and 48 px; and a 180 px hero with a
// button per state, a change mid-transition and a reduced-motion switch. Demo only: nothing here
// reaches Nova.
import { STATUS_ICON_STATES, setReducedMotion, statusIcon } from './status-icon.js';

const SIZES = [16, 24, 48];
const MARK_SIZES = [16, 24, 48, 96, 180];
const CROPS = [['/icons/mark.svg', 'The artwork as given, on a transparent background (ui/icons/mark.svg)']];
let forced = null;
// The demo first lets the hero settle at idle, so the change always starts from the same place.
const MIDWAY_START = 900;

// Every state at 16, 24 and 48 px; also drawn on the Nebula acceptance entry (nebula-match).
export function statusIconSheet() {
  const cells = STATUS_ICON_STATES.map((s) => `<span class="sg-name">${s}</span>${SIZES.map((px) => `<span class="si-tile" data-si-cell="${s}-${px}"></span>`).join('')}`).join('');
  return `<div class="si-sheet" data-si-sheet><span></span>${SIZES.map((px) => `<span class="sg-name">${px} px</span>`).join('')}${cells}</div>`;
}

const crop = ([src, words]) => `<figure class="si-crop"><figcaption class="sg-name">${words}</figcaption><div class="si-sizes">${MARK_SIZES.map((px) => `<img src="${src}" width="${px}" height="${px}" alt="">`).join('')}</div></figure>`;

export function statusIconEntry() {
  return `<div class="si-preview" data-si-preview>
<div class="si-hero"><span class="si-tile" data-si-hero></span>
<div class="si-controls"><p class="sg-label">Set the hero’s state</p>
<div class="sg-demo-row" role="group" aria-label="Set the hero’s state">${STATUS_ICON_STATES.map((s) => `<button type="button" class="btn small" data-si-set="${s}">${s}</button>`).join('')}</div>
<div class="sg-demo-row"><button type="button" class="btn" data-si-midway>Idle → working, then needs-you 150 ms later</button>
<label class="si-reduce"><input type="checkbox" data-si-reduced> Reduced motion</label></div></div></div>
<p class="sg-label">The mark at 16, 24, 48, 96 and 180 px: one artwork, prefiltered downscales</p>
<div class="si-sizes" data-si-sizes>${MARK_SIZES.map((px) => `<span class="si-tile" data-si-size="${px}"></span>`).join('')}</div>
<p class="sg-label">The image</p>${CROPS.map(crop).join('')}
<p class="sg-label">Every state’s treatment</p>
${statusIconSheet()}</div>`;
}

export function bindStatusIcons(root) {
  for (const cell of root.querySelectorAll('[data-si-cell]')) {
    const [, s, px] = /^(.+)-(\d+)$/.exec(cell.dataset.siCell);
    cell.append(statusIcon({ status: s, size: Number(px) }));
  }
  for (const cell of root.querySelectorAll('[data-si-size]')) cell.append(statusIcon({ status: 'idle', size: Number(cell.dataset.siSize) }));
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
