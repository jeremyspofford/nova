// The supernova N's preview in the living styleguide (/styleguide?entry=n-mark), for the owner's
// reaction (single-mark direction 2026-11-08, step 1): the three constructions side by side, each
// as a 240 px hero, at 96, 48, 24 and 16 px on the near-black tile, as the 180 px app icon, and at
// 16 and 24 px on a light surface; then all three at 16, 24 and 48 px together. Still, idle palette.
// Demo only: nothing here reaches Nova.
import { N_MARK_VARIANTS, nMark } from './n-mark.js';

export const N_MARK_SIZES = Object.freeze([96, 48, 24, 16]);
const SHEET = [16, 24, 48];

const sizeCell = (id, px) => `<figure class="nm-size"><span class="nm-cell" data-nm-cell="${id}-${px}"></span><figcaption class="nm-caption">${px} px</figcaption></figure>`;

function variant({ id, letter, name, about }) {
  return `<section class="nm-variant" data-nm-variant="${id}" aria-labelledby="nm-${id}-name">
<h4 class="nm-name" id="nm-${id}-name"><span class="nm-letter">${letter}</span> ${name}</h4>
<p class="nm-about">${about}</p>
<div class="nm-dark nm-hero"><span class="nm-cell" data-nm-cell="${id}-240"></span></div>
<div class="nm-dark nm-sizes">${N_MARK_SIZES.map((px) => sizeCell(id, px)).join('')}</div>
<p class="sg-label">App icon, 180 px</p>
<div class="nm-icon"><span class="nm-cell" data-nm-icon="${id}"></span></div>
<p class="sg-label">On a light surface, 16 and 24 px</p>
<div class="nm-light"><span class="nm-cell" data-nm-light="${id}-16"></span><span>Nova</span><span class="nm-cell" data-nm-light="${id}-24"></span><span>Nova</span></div>
</section>`;
}

export function nMarkEntry() {
  return `<div class="nm-preview" data-nm-preview>
<p class="nm-note">For the owner’s reaction: three ways to build the one mark, still, in the idle palette. Pick one (or say what to change) before any motion work. Nothing here is wired into Nova; the live status icon is unchanged.</p>
<div class="nm-variants">${N_MARK_VARIANTS.map(variant).join('')}</div>
<p class="sg-label">All three at 16, 24 and 48 px</p>
<div class="nm-dark nm-sheet" data-nm-sheet><span></span>${SHEET.map((px) => `<span class="nm-caption">${px} px</span>`).join('')}${N_MARK_VARIANTS.map(({ id, letter, name }) => `<span class="nm-caption nm-row-name">${letter} · ${name}</span>${SHEET.map((px) => `<span class="nm-cell" data-nm-cmp="${id}-${px}"></span>`).join('')}`).join('')}</div>
</div>`;
}

export function bindNMark(root) {
  const fill = (attr, make) => {
    for (const slot of root.querySelectorAll(`[${attr}]`)) {
      const [, id, px] = /^(.+?)(?:-(\d+))?$/.exec(slot.getAttribute(attr));
      slot.replaceChildren(make(id, Number(px)));
    }
  };
  fill('data-nm-cell', (variant, size) => nMark({ variant, size }));
  fill('data-nm-light', (variant, size) => nMark({ variant, size }));
  fill('data-nm-cmp', (variant, size) => nMark({ variant, size }));
  fill('data-nm-icon', (variant) => nMark({ variant, size: 180, tile: true }));
}
