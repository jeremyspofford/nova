#!/usr/bin/env node
// Draws Nova's app icon from the shipped status icon (ui/js/status-icon.js): the idle swirl, the
// owner's supernova N, rendered by the same WebGL shader at production size and set on the
// near-black tile of the state sheet (docs/builder-packet/ui-references/
// nova-agent-state-system-sheet-2026-11-08.jpg). Colours are Nebula's dark tokens, read from
// design-systems/nebula.json, so the icon and the status icon are one material.
//   ui/icons/icon-192.png, icon-512.png   the tile, rounded, transparent corners (purpose any)
//   ui/icons/maskable-512.png             full-bleed field, the swirl inside the 80% safe circle
//   ui/icon.svg                           both renders as images: the full swirl, and the status
//                                         icon's own small form at 24 px and under (the favicon)
// Needs Chromium with WebGL; run it in the Playwright image as scripts/ui-test.sh runs the UI gate:
//   CHROMIUM=… node scripts/app-icon.js            write the icons
//   NOVA_ICON_BEFORE=<dir> NOVA_ICON_SHOTS=<dir> CHROMIUM=… node scripts/app-icon.js --shots
//                                                  also draw the comparison screenshots
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..');
const ORIGIN = 'http://icon.test';
const TYPES = { '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.html': 'text/html', '.webmanifest': 'application/manifest+json' };
const dark = JSON.parse(readFileSync(join(ROOT, 'design-systems/nebula.json'), 'utf8')).modes.dark;
const TOKENS = { '--orb-core': 'orb/core', '--accent-secondary': 'accent/secondary', '--orb-listening': 'orb/listening', '--orb-attention': 'orb/attention', '--status-error': 'status/error' };
const vars = Object.entries(TOKENS).map(([v, t]) => `${v}:${dark[t]};`).join('');
const FIELD = '#0b0b13'; // the sheet's field, beneath Nebula's bg/base (#0f0e11)
const FINE = 576; // ribbon points for the large render (a multiple of 4, as the shader reads them)

// The repo at /, a previous icon set (for the comparison) at /before/.
async function serve(context, before) {
  await context.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    const file = path.startsWith('/before/') && before ? join(before, path.slice(8)) : join(ROOT, path);
    if (!existsSync(file)) return route.fulfill({ status: 404, body: 'missing' });
    if (path === '/ui/js/status-icon.js' && url.search === '?fine') {
      // The shipped module, its ribbon sampled at FINE points instead of 36: the same forms (every
      // form is parametric in its point count) and the same shader, without the creases between
      // straight segments that show once the icon is drawn hundreds of pixels wide.
      const src = readFileSync(file, 'utf8');
      if (!/^const N = 36;$/m.test(src)) throw new Error('status-icon.js no longer declares `const N = 36;`: update scripts/app-icon.js');
      return route.fulfill({ status: 200, contentType: TYPES['.js'], body: src.replace(/^const N = 36;$/m, `const N = ${FINE};`) });
    }
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
  });
}

const blank = (body = '') => `<!doctype html><html><head><meta charset="utf-8"><style>:root{${vars}}html,body{margin:0;background:#000}</style></head><body>${body}</body></html>`;

// In the page: render the idle swirl at `size` CSS px; return its canvas, the box its body fills,
// and which renderer drew it.
const RENDER = `
window.renderIdle = async (size, fine = false) => {
  const { statusIcon, setReducedMotion } = await import(fine ? '/ui/js/status-icon.js?fine' : '/ui/js/status-icon.js');
  setReducedMotion(true); // the resting form, t = 0
  const el = statusIcon({ status: 'idle', size });
  document.body.append(el);
  const c = el.querySelector('canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (d[(y * c.width + x) * 4 + 3] > 128) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  // The farthest body pixel from the box's centre: what has to fit a maskable safe circle.
  const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
  let reach = 0;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (d[(y * c.width + x) * 4 + 3] > 128) reach = Math.max(reach, Math.hypot(x + 0.5 - cx, y + 0.5 - cy));
  }
  el.remove();
  return { c, box: { x0, y0, x1: x1 + 1, y1: y1 + 1, cx, cy, reach }, renderer: el.dataset.renderer };
};
// The tile: near-black, a breath lighter at the top, a faint rim; then the form, centred on its body.
window.tile = (r, size, { fill, maskable = false, safe = 0.4, radius = 0.225 } = {}) => {
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const g = out.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  const rr = maskable ? 0 : size * radius;
  g.beginPath();
  g.roundRect(0, 0, size, size, rr);
  const bg = g.createLinearGradient(0, 0, 0, size);
  bg.addColorStop(0, '#17161e');
  bg.addColorStop(0.55, '${FIELD}');
  bg.addColorStop(1, '#09090f');
  g.fillStyle = bg;
  g.fill();
  if (!maskable && size >= 64) {
    g.save();
    g.clip();
    g.lineWidth = size / 256;
    const rim = g.createLinearGradient(0, 0, 0, size);
    rim.addColorStop(0, 'rgba(255,255,255,0.10)');
    rim.addColorStop(1, 'rgba(255,255,255,0.03)');
    g.strokeStyle = rim;
    g.beginPath();
    g.roundRect(g.lineWidth / 2, g.lineWidth / 2, size - g.lineWidth, size - g.lineWidth, rr - g.lineWidth / 2);
    g.stroke();
    g.restore();
  }
  const { c, box } = r;
  // Scale: the body's larger side fills \`fill\` of the tile, or its reach fits the safe circle.
  const k = maskable ? (safe * size) / box.reach : (fill * size) / Math.max(box.x1 - box.x0, box.y1 - box.y0);
  const w = c.width * k;
  g.save();
  g.beginPath();
  g.roundRect(0, 0, size, size, rr);
  g.clip();
  // Downscale in halving steps so the swirl's fine edge and stars average rather than alias.
  let src = c, sw = c.width;
  while (sw / 2 >= w) {
    const half = document.createElement('canvas');
    half.width = half.height = Math.round(sw / 2);
    const h = half.getContext('2d');
    h.imageSmoothingQuality = 'high';
    h.drawImage(src, 0, 0, half.width, half.height);
    src = half; sw = half.width;
  }
  g.drawImage(src, size / 2 - box.cx * k, size / 2 - box.cy * k, w, w);
  g.restore();
  return out;
};
`;

async function icons(b) {
  // The full swirl, large (dpr 1: a 1024 canvas, twice the largest icon).
  const ctx = await b.newContext({ deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await serve(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(`${ORIGIN}/`, (r) => r.fulfill({ contentType: 'text/html', body: blank() }));
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ content: RENDER });
  const out = await page.evaluate(async () => {
    const big = await window.renderIdle(1024, true);
    if (big.renderer !== 'webgl') throw new Error(`renderer is ${big.renderer}, not webgl`);
    const png = (c) => c.toDataURL('image/png');
    const any = { fill: 0.82 };
    return {
      box: big.box,
      'ui/icons/icon-512.png': png(window.tile(big, 512, any)),
      'ui/icons/icon-192.png': png(window.tile(big, 192, any)),
      'ui/icons/maskable-512.png': png(window.tile(big, 512, { maskable: true, safe: 0.37 })),
      large: window.tile(big, 512, any).toDataURL('image/webp', 0.9),
    };
  });
  // The status icon's own small form (≤ 24 px), drawn at 3x: what the favicon shows.
  const sctx = await b.newContext({ deviceScaleFactor: 3, reducedMotion: 'reduce' });
  await serve(sctx);
  const sp = await sctx.newPage();
  await sp.route(`${ORIGIN}/`, (r) => r.fulfill({ contentType: 'text/html', body: blank() }));
  await sp.goto(`${ORIGIN}/`);
  await sp.addScriptTag({ content: RENDER });
  const small = await sp.evaluate(async () => {
    const s = await window.renderIdle(16); // small form, 48 px canvas
    return window.tile(s, 48, { fill: 0.9, radius: 0.2 }).toDataURL('image/png');
  });
  if (errors.length) throw new Error(errors.join('\n'));
  const bytes = (u) => Buffer.from(u.split(',')[1], 'base64');
  for (const f of ['ui/icons/icon-512.png', 'ui/icons/icon-192.png', 'ui/icons/maskable-512.png']) writeFileSync(join(ROOT, f), bytes(out[f]));
  writeFileSync(join(ROOT, 'ui/icon.svg'), [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">',
    // Generated by scripts/app-icon.js from ui/js/status-icon.js. At favicon size the status icon's
    // small form (fewer, broader arms) replaces the full swirl, which muddies under 24 px.
    '<style>.s{display:none}@media (max-width:24px){.l{display:none}.s{display:inline}}</style>',
    `<image class="l" width="512" height="512" href="${out.large}"/>`,
    `<image class="s" width="512" height="512" href="${small}"/>`,
    '</svg>',
    '',
  ].join('\n'));
  await ctx.close();
  await sctx.close();
  console.log('icons written; body box at 1024:', JSON.stringify(out.box));
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
  await shoot('before-after.png', `<div id="s" style="display:inline-block"><h2>Before: the teal disc</h2>${set('/before/icons', '/before/icon.svg')}<h2>After: the idle swirl, from ui/js/status-icon.js</h2>${set('/ui/icons', '/ui/icon.svg')}</div>${zoom}`, '#s');

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
