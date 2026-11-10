#!/usr/bin/env node
// Nova's mark is the owner's artwork, not code (docs/builder-packet/ui-references/
// nova-mark-artwork-not-code-amendment-2026-11-08.md): the nebula vortex with a black core, in its
// own dark rounded tile (nova-mark-owner-reference-regenerated-2026-11-08.webp, 1600×1600). This
// script only crops and downscales that file; it draws nothing. It writes:
//   ui/assets/nova-mark.webp              the source, as supplied
//   ui/icons/mark-1024.webp               the tile, corners transparent: the styleguide's reference
//                                         for the traced SVG mark (ui/js/status-icon.js, UI item 24)
//   ui/icons/mark-vortex-512.webp         the vortex alone on transparency (the styleguide's crop
//                                         comparison; the in-app mark uses the tile)
//   ui/icons/icon-192.png, icon-512.png   the tile, corners transparent (purpose any)
//   ui/icons/maskable-512.png             the tile's dark field full bleed, the vortex inside the
//                                         80% safe circle
//   ui/icon.svg                           the tile as images: 256 px, and a prefiltered 64 px for
//                                         favicon sizes (24 px and under)
// Every downscale halves step by step, so 16 px averages the artwork instead of aliasing it.
// Needs Chromium (for WebP decode and encode); run it in the Playwright image as scripts/ui-test.sh
// runs the UI gate:
//   CHROMIUM=… node scripts/app-icon.js            write the assets
//   NOVA_ICON_BEFORE=<dir> NOVA_ICON_SHOTS=<dir> CHROMIUM=… node scripts/app-icon.js --shots
//                                                  also draw the comparison screenshots
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..');
const ORIGIN = 'http://icon.test';
const TYPES = { '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.html': 'text/html', '.webmanifest': 'application/manifest+json' };
const SOURCE = 'docs/builder-packet/ui-references/nova-mark-owner-reference-regenerated-2026-11-08.webp';
// Measured on the 1600 px source (the tile's outer edge, where its rim meets the backdrop, and the
// corner radius from where the rim crosses each diagonal), and the vortex's core as fractions of
// the tile.
const TILE = { x: 156, y: 155, size: 1288, radius: 307 };
const CORE = { x: (800 - 156) / 1288, y: (793 - 155) / 1288 }; // the vortex's centre
const VORTEX_REACH = 674; // source px from the core to the vortex's farthest edge

// The repo at /, a previous icon set (for the comparison) at /before/.
async function serve(context, before) {
  await context.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    const file = path.startsWith('/before/') && before ? join(before, path.slice(8)) : join(ROOT, path);
    if (!existsSync(file)) return route.fulfill({ status: 404, body: 'missing' });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
  });
}

// In the page: crops of the source, each downscaled by halving.
const CROP = `
window.load = async (src) => { const i = new Image(); i.src = src; await i.decode(); return i; };
// Draw a region of the image at \`size\`, halving until one last step is under 2x.
window.scaled = (img, sx, sy, sw, size) => {
  let c = document.createElement('canvas'); c.width = c.height = sw;
  c.getContext('2d').drawImage(img, sx, sy, sw, sw, 0, 0, sw, sw);
  while (c.width / 2 >= size) {
    const h = document.createElement('canvas'); h.width = h.height = Math.round(c.width / 2);
    const g = h.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, h.width, h.height);
    c = h;
  }
  const out = document.createElement('canvas'); out.width = out.height = size;
  const g = out.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, size, size);
  return out;
};
// The tile with its corners cut on the artwork's own rounded edge.
window.tileAt = (img, t, size) => {
  const c = window.scaled(img, t.x, t.y, t.size, size), g = c.getContext('2d');
  g.globalCompositeOperation = 'destination-in';
  g.beginPath(); g.roundRect(0, 0, size, size, (t.radius / t.size) * size); g.fill();
  return c;
};
// Maskable: the tile's own dark interior, full bleed, the vortex scaled into the safe circle.
window.maskable = (img, t, core, reach, size) => {
  const k = (0.4 * size) / reach; // the safe circle's radius over the vortex's reach
  const out = document.createElement('canvas'); out.width = out.height = size;
  const g = out.getContext('2d');
  const inset = 18; // inside the rim
  const sw = t.size - 2 * inset, piece = window.scaled(img, t.x + inset, t.y + inset, sw, Math.round(sw * k));
  // The field: the interior's own colour, sampled just inside the rim.
  const d = piece.getContext('2d').getImageData(4, Math.round(piece.height / 2), 1, 1).data;
  g.fillStyle = 'rgb(' + d[0] + ' ' + d[1] + ' ' + d[2] + ')';
  g.fillRect(0, 0, size, size);
  const cx = (core.x * t.size - inset) * k, cy = (core.y * t.size - inset) * k;
  g.save(); g.beginPath(); g.roundRect(size / 2 - cx, size / 2 - cy, piece.width, piece.height, (t.radius - inset) * k); g.clip();
  g.drawImage(piece, size / 2 - cx, size / 2 - cy); g.restore();
  return out;
};
// The vortex alone: the tile's interior, its near-black keyed to transparency, the black core kept.
window.vortexAt = (img, t, core, size) => {
  const c = window.scaled(img, t.x, t.y, t.size, size), g = c.getContext('2d');
  const px = g.getImageData(0, 0, size, size), d = px.data;
  const r0 = 0.09 * size; // the core disc stays opaque black
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4, m = Math.max(d[i], d[i + 1], d[i + 2]);
    const inCore = Math.hypot(x - core.x * size, y - core.y * size) < r0;
    d[i + 3] = inCore ? 255 : Math.round(255 * Math.min(1, Math.max(0, (m - 14) / 36)));
  }
  g.putImageData(px, 0, 0);
  return c;
};
`;

async function icons(b) {
  const ctx = await b.newContext({ deviceScaleFactor: 1 });
  await serve(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(`${ORIGIN}/`, (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><body></body>' }));
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ content: CROP });
  const out = await page.evaluate(async ({ src, t, core, reach }) => {
    const img = await window.load(src);
    if (img.naturalWidth !== 1600) throw new Error(`the source is ${img.naturalWidth} px wide, not 1600: re-measure TILE`);
    const png = (c) => c.toDataURL('image/png');
    const webp = (c, q = 0.9) => c.toDataURL('image/webp', q);
    return {
      'ui/icons/mark-1024.webp': webp(window.tileAt(img, t, 1024), 0.9),
      'ui/icons/mark-vortex-512.webp': webp(window.vortexAt(img, t, core, 512), 0.9),
      'ui/icons/icon-512.png': png(window.tileAt(img, t, 512)),
      'ui/icons/icon-192.png': png(window.tileAt(img, t, 192)),
      'ui/icons/maskable-512.png': png(window.maskable(img, t, core, reach, 512)),
      large: webp(window.tileAt(img, t, 256), 0.9),
      small: png(window.tileAt(img, t, 64)),
    };
  }, { src: `/${SOURCE}`, t: TILE, core: CORE, reach: VORTEX_REACH });
  if (errors.length) throw new Error(errors.join('\n'));
  const bytes = (u) => Buffer.from(u.split(',')[1], 'base64');
  mkdirSync(join(ROOT, 'ui/assets'), { recursive: true });
  copyFileSync(join(ROOT, SOURCE), join(ROOT, 'ui/assets/nova-mark.webp'));
  for (const f of ['ui/icons/mark-1024.webp', 'ui/icons/mark-vortex-512.webp', 'ui/icons/icon-512.png', 'ui/icons/icon-192.png', 'ui/icons/maskable-512.png']) writeFileSync(join(ROOT, f), bytes(out[f]));
  writeFileSync(join(ROOT, 'ui/icon.svg'), [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">',
    // Generated by scripts/app-icon.js from the owner's artwork (ui/assets/nova-mark.webp). At
    // favicon size a 64 px downscale, prefiltered by halving, stands in for the 256 px one.
    '<style>.s{display:none}@media (max-width:24px){.l{display:none}.s{display:inline}}</style>',
    `<image class="l" width="512" height="512" href="${out.large}"/>`,
    `<image class="s" width="512" height="512" href="${out.small}"/>`,
    '</svg>',
    '',
  ].join('\n'));
  // In the app (and /pair) the mark is the SVG status-icon.js draws (UI item 24); these rasters are
  // only for the places a background is genuinely needed: the OS icons, the favicon.
  await ctx.close();
  console.log('assets written from', SOURCE);
}

// The comparison: before and after at 512, 192, 32 and 16 (the small ones also enlarged, pixel for
// pixel), the maskable icon under its safe circle, and the icon on a dark and a light home screen.
async function shots(b, before, dir) {
  mkdirSync(dir, { recursive: true });
  const ctx = await b.newContext({ deviceScaleFactor: 1, viewport: { width: 1400, height: 900 } });
  await serve(ctx, before);
  const page = await ctx.newPage();
  const css = `body{background:#1c1c21;color:#d8d8de;font:14px/1.4 system-ui,sans-serif;padding:24px}
    .row{display:flex;align-items:flex-end;gap:28px;margin:0 0 28px}.cell{display:flex;flex-direction:column;align-items:center;gap:8px}
    h2{font-size:15px;font-weight:600;margin:0 0 12px}.zoom{image-rendering:pixelated}.lbl{color:#9a99a3;font-size:12px}`;
  const v = Date.now();
  const set = (base, svg) => `<div class="row">
    <div class="cell"><img src="${base}/icon-512.png?${v}" width="512" height="512"><span class="lbl">512 (icon-512.png)</span></div>
    <div class="cell"><img src="${base}/icon-192.png?${v}" width="192" height="192"><span class="lbl">192 (icon-192.png)</span></div>
    <div class="cell"><img src="${svg}?${v}" width="32" height="32"><span class="lbl">32 (icon.svg)</span></div>
    <div class="cell"><img src="${svg}?${v}" width="16" height="16"><span class="lbl">16 (icon.svg)</span></div>
    <div class="cell"><canvas data-src="${svg}?${v}" data-px="32" width="192" height="192" class="zoom"></canvas><span class="lbl">32, 6x pixels</span></div>
    <div class="cell"><canvas data-src="${svg}?${v}" data-px="16" width="192" height="192" class="zoom"></canvas><span class="lbl">16, 12x pixels</span></div></div>`;
  // The enlarged views: the SVG rasterised at 16 and 32 px, then blown up nearest-neighbour.
  const zoom = `<script>window.zoomed = Promise.all([...document.querySelectorAll('canvas[data-src]')].map(async (c) => {
    const img = new Image(); img.src = c.dataset.src; await img.decode();
    const px = +c.dataset.px, t = document.createElement('canvas'); t.width = t.height = px;
    t.getContext('2d').drawImage(img, 0, 0, px, px);
    const g = c.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(t, 0, 0, c.width, c.height);
  }));</script>`;
  const html = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
  const shoot = async (name, body, el = 'body') => {
    await page.route(`${ORIGIN}/shot`, (r) => r.fulfill({ contentType: 'text/html', body: html(body) }));
    await page.goto(`${ORIGIN}/shot`);
    await page.evaluate(() => window.zoomed);
    await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
    await page.locator(el).first().screenshot({ path: join(dir, name) });
    await page.unroute(`${ORIGIN}/shot`);
  };
  await shoot('before-after.png', `<div id="s" style="display:inline-block"><h2>Before: the drawn ribbon swirl</h2>${set('/before/icons', '/before/icon.svg')}<h2>After: the owner’s artwork (ui/assets/nova-mark.webp), cropped and downscaled</h2>${set('/ui/icons', '/ui/icon.svg')}</div>${zoom}`, '#s');

  // Maskable: the 512 under its 80% safe circle, and as Android's common masks crop it.
  const masks = [['circle', '50%'], ['squircle', '30%'], ['rounded square', '18%']];
  await shoot('maskable-safe-zone.png', `<div id="s" style="display:inline-flex;gap:32px;align-items:flex-end">
    <div class="cell"><div style="position:relative;width:512px;height:512px"><img src="/ui/icons/maskable-512.png?${v}" width="512" height="512" style="display:block">
      <svg width="512" height="512" style="position:absolute;inset:0"><circle cx="256" cy="256" r="204.8" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="8 6" opacity=".85"/><rect x="0.5" y="0.5" width="511" height="511" fill="none" stroke="#fff" opacity=".3"/></svg></div>
      <span class="lbl">maskable-512.png, the dashed circle is the 80% safe zone (r = 204.8)</span></div>
    ${masks.map(([n, r]) => `<div class="cell"><img src="/ui/icons/maskable-512.png?${v}" width="160" height="160" style="border-radius:${r}"><span class="lbl">${n} mask</span></div>`).join('')}</div>`, '#s');

  // Home screens: a 4-column grid with plain stand-in apps; Nova second on the top row.
  const home = (mode) => {
    const darkMode = mode === 'dark';
    const wall = darkMode ? 'radial-gradient(120% 80% at 30% 10%, #2a2d3a 0%, #121318 55%, #08080b 100%)' : 'radial-gradient(120% 80% at 30% 10%, #ffffff 0%, #e6e8ee 55%, #c9ccd6 100%)';
    const ink = darkMode ? '#f2f2f5' : '#1d1d22';
    const stand = darkMode ? ['#3a3f4c', '#4a4450', '#34474a', '#4b4a3c'] : ['#cfd6e2', '#e2d3cf', '#cfe2da', '#ddd8c4'];
    const apps = Array.from({ length: 20 }, (_, i) => i === 1
      ? `<div class="app"><img src="/ui/icons/icon-192.png?${v}" width="60" height="60"><span>Nova</span></div>`
      : `<div class="app"><div class="ph" style="background:${stand[i % 4]}"></div><span>App</span></div>`).join('');
    return `<div id="s" style="width:390px;height:844px;border-radius:44px;overflow:hidden;background:${wall};padding:96px 22px 0;box-sizing:border-box;font-family:system-ui,sans-serif">
      <style>.grid{display:grid;grid-template-columns:repeat(4,1fr);row-gap:26px}.app{display:flex;flex-direction:column;align-items:center;gap:6px}.app span{font-size:12px;color:${ink}}.ph{width:60px;height:60px;border-radius:14px}</style>
      <div class="grid">${apps}</div>
      <div style="position:absolute"></div></div>`;
  };
  await shoot('home-dark.png', home('dark'), '#s');
  await shoot('home-light.png', home('light'), '#s');
  await ctx.close();
  console.log('screenshots in', dir);
}

const b = await chromium.launch({ executablePath: process.env.CHROMIUM || chromium.executablePath(), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  if (!process.argv.includes('--shots-only')) await icons(b);
  if (process.argv.includes('--shots') || process.argv.includes('--shots-only')) {
    await shots(b, process.env.NOVA_ICON_BEFORE, resolve(ROOT, process.env.NOVA_ICON_SHOTS || 'docs/screenshots/app-icon-2026-11-08'));
  }
} finally {
  await b.close();
}
