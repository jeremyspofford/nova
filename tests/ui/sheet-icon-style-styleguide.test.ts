// The Sheet status icon style, design-first (2026-11-09; ui/js/sg-sheet-icons.js): the styleguide
// entry for the owner's reaction draws every frame, full screen, in Nebula light and dark, in Chromium
// and WebKit, with no Content-Security-Policy violation, no page error and nothing sent. The tiles are
// the owner's crops (scripts/sheet-icons.js), shown at their own 246 px or smaller, never upscaled;
// each state uses the tile the owner named, amber (WARNING) only for needs-you and red (ERROR) only for
// stopped; listening and speaking have no tile and are drawn as gaps, nothing picked. A change is the
// crops mixed by the real model's weights (StatusModel, 800 ms). Each place shows one icon. Each frame
// holds the house rules: no sideways scroll, 44 px targets, every control labelled, no duplicate ids.
// The style isn't wired: no app file but the styleguide's names the crops. On a phone (390×844) and a
// Duo's cover screen (380×900) each frame is one column filling the screen. With NOVA_UI_SHOTS set
// (scripts/ui-test.sh), Chromium writes the owner's screenshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { browser, device, shortTargets, shotsDir, still, watchCsp, webkitBrowser } from './support.ts';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { ensureMark } from '../../src/core/resilience/home-mark.ts';

const FRAMES = ['sizes', 'small', 'no-tile', 'change', 'rail', 'hero', 'phone-bar', 'appearance'];
const NARROW_FRAMES = ['sizes', 'small', 'no-tile', 'change', 'phone-bar', 'appearance'];
const LIGHT_TOO = new Set(['sizes', 'small', 'hero', 'appearance']);
const SIZES = { desktop: { width: 1440, height: 900, name: 'desktop-1440x900', touch: false }, phone: { width: 390, height: 844, name: 'phone-390x844', touch: true }, duo: { width: 380, height: 900, name: 'duo-cover-380x900', touch: true } };
// The owner's mapping of the model's states onto the sheet's tiles.
const TILE: Record<string, string> = { idle: 'idle', working: 'working', thinking: 'thinking', success: 'success', 'needs-you': 'warning', stopped: 'error', paused: 'paused', offline: 'offline' };
const ROOT = join(import.meta.dirname, '..', '..');

test('the Sheet style is not wired into the app: only the styleguide names its crops', () => {
  const files = [...readdirSync(join(ROOT, 'ui/js')).filter((f) => f.endsWith('.js') && f !== 'sg-sheet-icons.js').map((f) => `ui/js/${f}`), 'ui/index.html', 'ui/pair.html', 'ui/sw.js', 'ui/manifest.webmanifest'];
  for (const f of files) assert.ok(!readFileSync(join(ROOT, f), 'utf8').includes('state-sheet-'), `${f} doesn’t load the Sheet crops`);
  const crops = readdirSync(join(ROOT, 'ui/icons')).filter((f) => f.startsWith('state-sheet-')).sort();
  assert.deepEqual(crops, [...new Set(Object.values(TILE))].sort().map((t) => `state-sheet-${t}-246.webp`), 'one crop per tile on the sheet, eight in all');
});

async function fixture(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-ss-styleguide-'));
  chmodSync(dir, 0o700);
  let nova: ReturnType<typeof createNova> | undefined;
  try {
    const home = join(dir, 'nova');
    const user = join(dir, 'user');
    mkdirSync(user, { mode: 0o700 });
    ensureMark(home, { userHome: user });
    nova = createNova(loadConfig({ HOME: user, NOVA_HOME: home, NOVA_HOST: '127.0.0.1', NOVA_PORT: '0', NOVA_VAULT_KEY: 'file', NOVA_AGENT_CMD: '/bin/false', NOVA_AGENT_EGRESS: 'none' }));
    const server = nova.server;
    await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    if (nova) {
      nova.scheduler.stop();
      nova.server.closeAllConnections();
      if (nova.server.listening) await new Promise<void>((done) => nova!.server.close(() => done()));
      await nova.core.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

async function open(page: Page, url: string, theme: string) {
  await page.goto(`${url}&ds=nebula&mode=${theme}`);
  await page.waitForSelector(`html[data-sg-preview="nebula-${theme}"]`);
  await page.locator('[data-ss-frame]').first().waitFor();
  // Every Mark slot holds today's status icon, every crop has loaded, every crossfade and enlargement is drawn.
  await page.waitForFunction(() => [...document.querySelectorAll('[data-ss-mark]')].every((s) => s.querySelector('.status-icon'))
    && [...document.querySelectorAll<HTMLImageElement>('[data-ss-frame] img')].every((i) => i.complete && i.naturalWidth > 0)
    && [...document.querySelectorAll<HTMLCanvasElement>('canvas[data-ss-zoom], canvas[data-ss-mix]')].every((c) => c.dataset.ssDrawn === '1'));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function rules(page: Page, label: string) {
  const width = page.viewportSize()!.width;
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width, `${label}: no horizontal scroll`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-ss-frame], [data-ss-frame] *')]
    .filter((e) => e.checkVisibility() && !e.matches('.sr-only') && ['auto', 'scroll', 'hidden'].includes(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth + 1)
    .map((e) => `${e.className} ${e.scrollWidth}>${e.clientWidth}`)), [], `${label}: nothing scrolls or clips sideways`);
  assert.deepEqual(await shortTargets(page, '[data-ss-frame] :is(button, a, select, textarea, summary, input:not([type="radio"]):not([type="checkbox"]))', { visible: true }), [], `${label}: 44 px targets`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-ss-frame] :is(button, a, input, select, textarea)')]
    .filter((e) => {
      if ((e instanceof HTMLInputElement || e instanceof HTMLSelectElement || e instanceof HTMLTextAreaElement) && e.labels?.length) return false;
      const by = e.getAttribute('aria-labelledby');
      if (by) return !by.split(' ').map((id) => document.getElementById(id)?.textContent?.trim()).every(Boolean);
      return !(e.getAttribute('aria-label') || e.textContent?.trim());
    })
    .map((e) => e.outerHTML.slice(0, 80))), [], `${label}: every control is labelled`);
  const ids = await page.evaluate(() => [...document.querySelectorAll('[id]')].map((e) => e.id));
  assert.equal(new Set(ids).size, ids.length, `${label}: no duplicate ids`);
  // The crops are the owner's 246 px tiles, drawn at that size or smaller: never upscaled.
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLImageElement>('[data-ss-frame] img[src*="state-sheet-"]')]
    .filter((i) => i.naturalWidth !== 246 || i.naturalHeight !== 246 || i.getBoundingClientRect().width > 246).map((i) => `${i.src} ${i.naturalWidth}×${i.naturalHeight} at ${i.getBoundingClientRect().width}`)), [], `${label}: crops at 246 px or smaller`);
}

// Narrow: the frame's one column, as wide as the screen, down to its foot.
async function oneColumn(page: Page, frame: string, label: string) {
  const v = page.viewportSize()!;
  const col = await page.evaluate((f) => { const el = document.querySelector<HTMLElement>(`[data-ss-frame="${f}"] :is(.ss-col, .uc-chat)`)!; const r = el.getBoundingClientRect(); return { left: r.left, width: r.width, bottom: r.bottom }; }, frame);
  assert.ok(col.left <= 1 && col.width >= v.width - 1, `${label}: the column is the full width (${JSON.stringify(col)})`);
  assert.ok(col.bottom >= v.height - 1, `${label}: the column reaches the bottom, no dead band (${col.bottom} of ${v.height})`);
}

// What each frame must say and show.
async function words(page: Page, frame: string, label: string) {
  const f = page.locator(`[data-ss-frame="${frame}"]`);
  const text = (await f.innerText()).replace(/\s+/g, ' ');
  const has = (s: string) => assert.ok(text.toLowerCase().includes(s.toLowerCase()), `${label}: says “${s}”`);
  // The tile each state shows, read from the page: [state, tile] for every state section with a crop.
  const used = () => f.locator('section.ss-state').evaluateAll((secs) => secs.flatMap((s) => {
    const state = s.querySelector('.ss-h')!.firstChild!.textContent!.trim();
    return [...new Set([...s.querySelectorAll<HTMLImageElement>('img[src*="state-sheet-"]')].map((i) => /state-sheet-(\w+)-/.exec(i.src)![1]))].map((t) => [state, t] as [string, string]);
  }));
  // Live state, in the places: one icon, the tile the model's state names, at the app's size.
  const live = () => f.locator('.ss-live').evaluateAll((els) => els.filter((e) => (e as HTMLElement).checkVisibility()).map((e) => { const i = e.querySelector('img')!; return [/state-sheet-(\w+)-/.exec(i.src)![1], Math.round(i.getBoundingClientRect().width)]; }));
  if (frame === 'sizes') {
    assert.deepEqual(new Map(await used()), new Map(Object.entries(TILE)), `${label}: each state uses the owner’s tile, and only that one`);
    assert.equal(await f.locator('[data-ss-mark]').count(), 50, `${label}: ten states, five sizes of today’s Mark`);
    assert.equal(await f.locator('img[src*="state-sheet-"]').count(), 40, `${label}: eight tiles, five sizes`);
    assert.equal(await f.getByText('No tile on your sheet').count(), 2, `${label}: listening and speaking drawn as gaps`);
  }
  if (frame === 'small') {
    assert.equal(await f.locator('canvas[data-ss-zoom]').count(), 16, `${label}: 16 and 24 px enlarged for each tile`);
    assert.equal(await f.locator('[data-ss-verdict]').count(), 8, `${label}: a verdict for each tile`);
    has('Nothing is redrawn to help');
    has('OFFLINE turns to mush'); // said, not fixed by redrawing
    // An enlargement is the downscale itself: 16 px × 8, not a redraw at 128.
    assert.deepEqual(await f.locator('canvas[data-ss-zoom]').evaluateAll((cs) => [...new Set(cs.map((c) => `${(c as HTMLCanvasElement).width}`))].sort()), ['128', '144'], `${label}: 16 × 8 and 24 × 6`);
  }
  if (frame === 'no-tile') {
    assert.equal(await f.getByText('No tile on your sheet').count(), 2, `${label}: both gaps`);
    for (const [state, tile] of await used()) assert.ok(['working', 'thinking', 'idle'].includes(tile) && ['listening', 'speaking'].includes(state), `${label}: ${state} offers ${tile}`);
    has('Nothing is picked here');
    has('amber is only for needs-you, red only for stopped');
  }
  if (frame === 'change') {
    // StatusModel's own weights: halfway through the 800 ms ease is half and half; success settles by itself.
    for (const s of ['400 ms idle 50% · working 50%', '800 ms working 100%', '1800 ms success 100%', '2600 ms idle 100%', '950 ms needs-you 100%']) has(s);
    assert.equal(await f.locator('canvas[data-ss-mix]').count(), 16, `${label}: three sequences, sixteen frames`);
    assert.ok(await f.locator('canvas[data-ss-mix]').first().evaluate((c) => { const d = (c as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, (c as HTMLCanvasElement).width, (c as HTMLCanvasElement).height).data; let lit = 0; for (let i = 3; i < d.length; i += 4) if ((d[i] ?? 0) > 0) lit++; return lit > d.length / 8; }), `${label}: a frame is drawn`);
  }
  if (frame === 'rail') assert.deepEqual(await live(), [['working', 32]], `${label}: the rail’s icon, WORKING at 32 px, the only one`);
  if (frame === 'hero') assert.deepEqual(await live(), [['idle', 112]], `${label}: the hero, IDLE at 112 px, the only one (the rail’s hides on an empty chat)`);
  if (frame === 'phone-bar') assert.deepEqual(await live(), [['working', 24]], `${label}: the top bar’s icon, WORKING at 24 px`);
  if (['rail', 'hero', 'phone-bar', 'appearance'].includes(frame)) assert.equal(await f.locator('.status-icon').count(), 0, `${label}: no second icon beside the Sheet’s`);
  if (frame === 'appearance') {
    const cards = f.locator('.ds-card[data-ss-pick]');
    assert.equal(await cards.count(), 2, `${label}: two styles, as design cards`);
    assert.equal(await f.locator('details, [popover], [role="menu"]').count(), 0, `${label}: no popover or menu`);
    has('saves nothing');
  }
}

async function shoot(page: Page, dir: string, name: string) {
  await page.mouse.move(0, 0);
  await still(page);
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`Sheet status icon style styleguide (${engine}): every frame, no CSP violation, one column on a phone and a Duo cover`, { timeout: 900_000 }, async () => {
    let b: Browser | undefined;
    const dir = engine === 'chromium' ? shotsDir() : null;
    try {
      const launched = await launch();
      assert.notEqual(typeof launched, 'string', 'a browser is required');
      b = launched as Browser;
      await fixture(async (base) => {
        const runs: [keyof typeof SIZES, string, string[]][] = [['desktop', 'dark', FRAMES], ['desktop', 'light', FRAMES.filter((f) => LIGHT_TOO.has(f))], ['phone', 'dark', NARROW_FRAMES], ['phone', 'light', NARROW_FRAMES], ['duo', 'dark', NARROW_FRAMES], ['duo', 'light', NARROW_FRAMES]];
        for (const [size, theme, frames] of runs) {
          const s = SIZES[size];
          const d = await device(b!, { width: s.width, height: s.height, touch: s.touch, scheme: theme as 'light' | 'dark', serviceWorkers: 'block' });
          const p = d.page;
          const csp = await watchCsp(p);
          const sent: string[] = [];
          p.on('request', (r) => { if (!['GET', 'HEAD'].includes(r.method())) sent.push(`${r.method()} ${r.url()}`); });
          try {
            for (const frame of frames) {
              const label = `${engine}/${s.name}/${theme}/${frame}`;
              await open(p, `${base}/styleguide?entry=sheet-icon-style&frame=${frame}`, theme);
              assert.equal(await p.locator(`[data-ss-frame="${frame}"]`).count(), 1, `${label}: the frame is drawn`);
              await rules(p, label);
              if (size === 'desktop') await words(p, frame, label);
              else await oneColumn(p, frame, label);
              assert.deepEqual(await csp(), [], `${label}: no Content-Security-Policy violation`);
              if (dir) await shoot(p, dir, `${s.name}-${frame}-nebula-${theme}`);
            }
            // The whole entry, every frame stacked, as the owner opens it.
            if (size === 'desktop') {
              await open(p, `${base}/styleguide?entry=sheet-icon-style`, theme);
              assert.equal(await p.locator('[data-ss-frame]').count(), FRAMES.length, `${engine}/${theme}: the entry draws every frame`);
              assert.equal(await p.locator('.sg-broken').count(), 0, 'no frame failed to draw');
              await rules(p, `${engine}/${theme}/entry`);
              // Picking the Sheet presses it and only it, locally; nothing is saved or sent.
              const pane = p.locator('[data-ss-frame="appearance"]');
              await pane.getByRole('button', { name: /^Sheet/ }).click();
              assert.deepEqual(await pane.locator('.ds-card[data-ss-pick]').evaluateAll((cs) => cs.map((c) => `${(c as HTMLElement).dataset.ssPick} ${c.getAttribute('aria-pressed')}`)), ['mark false', 'sheet true'], 'the Sheet is pressed');
              assert.match(await pane.locator('[data-ss-said]').innerText(), /Nothing was saved/, 'the demo says so');
              assert.deepEqual(await csp(), [], `${engine}/${theme}/entry: no Content-Security-Policy violation`);
            }
            assert.deepEqual(sent, [], `${engine}/${s.name}/${theme}: the compositions send nothing`);
            assert.deepEqual(d.errors, [], `${engine}/${s.name}/${theme}: no page errors`);
          } finally {
            await d.ctx.close();
          }
        }
      });
    } finally { await b?.close(); }
  });
}
