#!/usr/bin/env node
// The "Sheet" status icon style (design-first, 2026-11-09): the owner's agent state sheet
// (docs/builder-packet/ui-references/nova-agent-state-system-sheet-2026-11-08.jpg, 1536×1024) has
// eight tiles, and on the review page the owner kept them "as another style theme for users to
// choose from". They are the owner's artwork, not code (nova-mark-artwork-not-code-amendment-
// 2026-11-08.md): this script only crops them (the mark's own set is scripts/app-icon.py). It
// draws nothing, redraws nothing and scales nothing: each tile is copied pixel for pixel, its rounded
// frame and all, onto a transparent square, its corners cut on the tile's own rounded edge. The
// sheet's tiles are 232 px tall and 237 to 244 px wide, so 246 px (the widest tile and a pixel of
// its rim's falloff each side) is the largest size it honestly supports; nothing is upscaled.
// It writes ui/icons/state-sheet-<tile>-246.webp for the eight tiles. The two transition strips
// below the tiles are not used. The app never loads the sheet; only the styleguide shows the crops.
// Needs Chromium (for JPEG decode and WebP encode); run it in the Playwright image as
// scripts/ui-test.sh runs the UI gate:
//   CHROMIUM=… node scripts/sheet-icons.js
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = 'docs/builder-packet/ui-references/nova-agent-state-system-sheet-2026-11-08.jpg';
const SIZE = 246;
// Measured on the 1536×1024 source: each tile's outer edge, where its rim is brightest (the median
// over the straight part of each side; every side measured the same along its length). x and y are
// the rim's top-left pixel, w and h its extent. The corner radius is 55 px on every tile, from where
// the rim crosses each diagonal (16 px in from the corner: 16 / (1 − 1/√2)).
const TILES = Object.freeze({
  idle: { x: 182, y: 75, w: 237, h: 232 },
  working: { x: 488, y: 75, w: 244, h: 232 },
  thinking: { x: 802, y: 75, w: 242, h: 232 },
  success: { x: 1114, y: 75, w: 239, h: 232 },
  warning: { x: 183, y: 352, w: 241, h: 232 },
  error: { x: 492, y: 352, w: 241, h: 232 },
  paused: { x: 802, y: 352, w: 241, h: 232 },
  offline: { x: 1113, y: 352, w: 237, h: 232 },
});
const RADIUS = 55;
const MARGIN = 1; // one pixel past the rim each side: its anti-aliased falloff onto the backdrop

const b = await chromium.launch({ executablePath: process.env.CHROMIUM || chromium.executablePath() });
try {
  const page = await b.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
  const out = await page.evaluate(async ({ src, tiles, size, radius, margin }) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    if (img.naturalWidth !== 1536 || img.naturalHeight !== 1024) throw new Error(`the sheet is ${img.naturalWidth}×${img.naturalHeight}, not 1536×1024: re-measure TILES`);
    const crops = {};
    for (const [name, t] of Object.entries(tiles)) {
      const sw = t.w + 2 * margin, sh = t.h + 2 * margin;
      if (sw > size || sh > size) throw new Error(`${name} is larger than ${size} px`);
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      const dx = Math.floor((size - sw) / 2), dy = Math.floor((size - sh) / 2);
      // Pixel for pixel: the same width and height in and out, at whole-pixel offsets.
      g.imageSmoothingEnabled = false;
      g.drawImage(img, t.x - margin, t.y - margin, sw, sh, dx, dy, sw, sh);
      // The corners: everything outside the tile's own rounded edge goes transparent.
      g.globalCompositeOperation = 'destination-in';
      g.beginPath();
      g.roundRect(dx, dy, sw, sh, radius + margin);
      g.fill();
      crops[name] = c.toDataURL('image/webp', 0.92);
    }
    return crops;
  }, { src: `data:image/jpeg;base64,${readFileSync(join(ROOT, SOURCE)).toString('base64')}`, tiles: TILES, size: SIZE, radius: RADIUS, margin: MARGIN });
  if (errors.length) throw new Error(errors.join('\n'));
  for (const [name, url] of Object.entries(out)) {
    if (!url.startsWith('data:image/webp')) throw new Error('this Chromium has no WebP encoder');
    writeFileSync(join(ROOT, `ui/icons/state-sheet-${name}-${SIZE}.webp`), Buffer.from(url.split(',')[1], 'base64'));
  }
  console.log(`${Object.keys(out).length} tiles cropped from ${SOURCE} into ui/icons/state-sheet-*-${SIZE}.webp`);
} finally {
  await b.close();
}
