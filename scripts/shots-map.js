#!/usr/bin/env node
// The Stellar Map's walkthrough: a made-up home (scripts/sample-home.js), the
// real server and UI in a browser, the golden views captured, and each
// interaction the spec asks for checked. WebGL runs on SwiftShader here, so
// frame times are the software renderer's, not a GPU's.
// Usage: node scripts/shots-map.js [outDir]   (CHROMIUM=/path/to/chrome to override)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { writeSampleHome } from './sample-home.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const out = resolve(process.argv[2] ?? join(root, 'docs/screenshots'));
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'nova-map-'));
writeSampleHome(home);
const port = 4800 + Math.floor(Math.random() * 400);
const base = `http://localhost:${port}`;
const results = { checks: [] };
const check = (name, ok, detail = '') => { results.checks.push({ name, ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `: ${detail}` : ''}`); };

const server = spawn(process.execPath, [join(root, 'src/server.js')], {
  env: { ...process.env, NOVA_HOME: home, NOVA_PORT: String(port), NOVA_TZ: 'America/New_York', NOVA_AGENT_CMD: `node ${join(root, 'scripts/fake-agent.js')}` },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((ok) => server.stdout.on('data', (d) => { if (String(d).includes('ready')) ok(); }));
const chrome = process.env.CHROMIUM ?? ['/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const browser = await chromium.launch({ executablePath: chrome, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const done = async (code) => { await browser.close(); server.kill(); process.exit(code); };
process.on('unhandledRejection', async (e) => { console.error(`✗ walkthrough stopped: ${e.message.split('\n')[0]}`); await done(1); });

async function page({ width = 1440, height = 900, view = 'map', theme = 'nova', reducedMotion = 'no-preference', sidebar = 'open' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion });
  await ctx.addInitScript(([v, t, s]) => { localStorage.setItem('nova.memoryView', v); localStorage.setItem('nova.theme', t); localStorage.setItem('nova.sidebar', s); }, [view, theme, sidebar]);
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') p.errors.push(m.text()); });
  return p;
}
const ready = (p) => p.waitForFunction(() => document.querySelector('#stellar:not([hidden]) .map-label.is-on'), null, { timeout: 30000 });
const shot = (p, name) => p.screenshot({ path: join(out, `${name}.png`) });
const where = (p, id) => p.evaluate((i) => window.__stellar?.where(i), id);
const mapState = (p) => p.evaluate(() => window.__stellar?.state());
// Wait for the camera to arrive. Software rendering is slow, so wait on the state, not the clock.
const arrive = (p) => p.waitForFunction(() => !window.__stellar.state().flying, null, { timeout: 30000 }).then(() => p.waitForTimeout(250));

// ---- the galaxy, as it opens ---------------------------------------------------------
const p = await page({ sidebar: 'collapsed' });
await p.goto(`${base}/memory`);
await ready(p);
await p.waitForTimeout(1200);
await shot(p, 'nova-map-galaxy');
let st = await mapState(p);
check('the map opens on the galaxy, centred on Nova', st.scale === 'Galaxy' && Math.abs(st.cam.x) < 1 && Math.abs(st.cam.y) < 1);
check('the map is full-bleed, chrome floats over it', await p.evaluate(() => document.querySelector('.main').classList.contains('is-map') && !!document.querySelector('.map-hud.map-tools')));
const labels = await p.$$eval('.map-label.is-on', (els) => els.map((e) => e.getBoundingClientRect()).map((r) => [r.left, r.top, r.right, r.bottom]));
const overlap = labels.some((a, i) => labels.some((b, j) => j > i && !(a[2] <= b[0] || a[0] >= b[2] || a[3] <= b[1] || a[1] >= b[3])));
check('labels never collide', !overlap, `${labels.length} labels on`);
await p.waitForTimeout(3300);
check('chrome fades after ~3 s idle', await p.evaluate(() => document.querySelector('#stellar').classList.contains('is-idle')));

// ---- hover lights the neighbourhood; click selects -------------------------------
const sam = await where(p, 'you');
await p.mouse.move(sam.x, sam.y);
await p.waitForTimeout(500);
st = await mapState(p);
check('hover lights a body’s neighbourhood and dims the rest', st.hovered === 'you' && st.dimmed > 0, `${st.dimmed} dimmed`);
check('chrome returns on pointer move', await p.evaluate(() => !document.querySelector('#stellar').classList.contains('is-idle')));
await shot(p, 'nova-map-hover');
await p.mouse.click(sam.x, sam.y);
await p.waitForSelector('.map-inspector:not([hidden])');
await p.waitForTimeout(400);
await shot(p, 'nova-map-selected');
const insp = await p.textContent('.map-inspector');
check('click selects and the inspector says why: source, threads, moons', /Sam Rivera/.test(insp) && /USER\.md/.test(insp) && /Threads/.test(insp) && /Moons/.test(insp));

// ---- drag pans with parallax ----------------------------------------------------------
st = await mapState(p);
const before = st;
await p.mouse.move(700, 160);
await p.mouse.down();
await p.mouse.move(600, 200, { steps: 8 });
await p.mouse.up();
await p.waitForTimeout(200);
st = await mapState(p);
const bodyShift = (before.cam.x - st.cam.x) * st.cam.z;
const skyShift = before.sky[0] - st.sky[0];
check('drag pans, and the far field moves less than the bodies (parallax)', Math.abs(bodyShift + 100) < 3 && Math.abs(skyShift) > 0 && Math.abs(skyShift) < Math.abs(bodyShift) / 2, `bodies ${bodyShift.toFixed(0)} px, far field ${skyShift.toFixed(1)} px`);

// ---- dive, deeper, and back out ----------------------------------------------------
await p.keyboard.press('Home');
await arrive(p);
const sam2 = await where(p, 'you');
await p.mouse.dblclick(sam2.x, sam2.y);
await arrive(p);
st = await mapState(p);
check('double-click dives to the system', st.scale === 'System' && st.selected === 'you', st.scale);
await p.mouse.move(5, 450);
await p.waitForTimeout(600);
await shot(p, 'nova-map-system');
await p.focus('#stellar');
await p.keyboard.press('Enter');
await arrive(p);
st = await mapState(p);
check('Enter dives again, to the orbit', st.scale === 'Orbit', st.scale);
await p.waitForTimeout(600); // let the last label fades finish
await shot(p, 'nova-map-orbit');
await p.keyboard.press('Escape');
await arrive(p);
const s1 = (await mapState(p)).scale;
await p.keyboard.press('Escape');
await arrive(p);
const s2 = (await mapState(p)).scale;
check('Esc backs out one scale at a time', s1 === 'System' && s2 === 'Galaxy', `${s1} → ${s2}`);

// ---- scroll travels -----------------------------------------------------------------
await p.mouse.move(720, 450);
for (let i = 0; i < 8; i++) { await p.mouse.wheel(0, -240); await p.waitForTimeout(30); }
await p.waitForTimeout(200);
st = await mapState(p);
check('scroll travels inward through the scales', st.scale !== 'Galaxy', st.scale);
await p.keyboard.press('Home');
await arrive(p);

// ---- search flies you there -------------------------------------------------------------
await p.keyboard.press('Control+k');
await p.waitForSelector('.map-search:not([hidden])');
await p.keyboard.type('northw');
await p.keyboard.press('Enter');
await p.waitForTimeout(50);
const flying = (await mapState(p)).flying;
await arrive(p);
st = await mapState(p);
check('⌘K search flies the camera and arrives selected', flying && st.selected === 'topic:northwind' && !st.flying, `${flying ? 'flew' : 'no flight'} → ${st.selected}`);
await shot(p, 'nova-map-search');

// ---- keyboard steps along threads ---------------------------------------------------------
const stepped = [];
for (const k of ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight']) { await p.keyboard.press(k); stepped.push((await mapState(p)).selected); }
check('arrow keys step between linked bodies', stepped.some((id) => id && id !== 'topic:northwind'), stepped.join(', '));

// ---- a moon: read it, edit it, forget it, undo ----------------------------------------------
await p.evaluate(() => window.__stellar.select('m:m1a2b3c4d'));
await arrive(p);
await shot(p, 'nova-map-moon');
check('a moon reads in place, with Edit and Forget', /coffee black/.test(await p.textContent('.map-inspector')) && !!(await p.$('.map-inspector [data-act="forget"]')));
await p.click('.map-inspector [data-act="edit"]');
await p.keyboard.press('End');
await p.keyboard.type(' Decaf after noon.');
await p.keyboard.press('Enter');
await p.waitForSelector('.toast:not([hidden])');
const mem = await p.evaluate(() => fetch('/api/memory').then((r) => r.json()));
check('Edit from the map edits the file', JSON.stringify(mem).includes('Decaf after noon.'));
await p.click('.map-inspector [data-act="forget"]');
await p.waitForSelector('.toast [data-action="undo"]');
await p.waitForTimeout(300);
const gone = !(await p.evaluate(() => fetch('/api/map').then((r) => r.json()))).nodes.some((n) => n.id === 'm:m1a2b3c4d');
check('Forget from the map forgets it in the file, with Undo', gone);
await p.click('.toast [data-action="undo"]');
await p.waitForTimeout(600);
const back = (await p.evaluate(() => fetch('/api/map').then((r) => r.json()))).nodes.some((n) => n.id === 'm:m1a2b3c4d');
check('Undo puts it back', back);

// ---- a new memory flares, once -----------------------------------------------------------
const mpath = join(home, 'MEMORY.md');
const { readFileSync, appendFileSync } = await import('node:fs');
appendFileSync(mpath, '- Mia starts piano on Wednesdays. <!-- id=m9a8b7c6d from=sample/1 at=2026-10-26T12:00:00Z -->\n');
await p.evaluate(() => window.__stellar.refresh());
await p.waitForTimeout(250);
check('a new memory is born as a small flare that settles', (await mapState(p)).flares > 0);
await p.waitForTimeout(2300);
check('…and is calm again after ~2 s', (await mapState(p)).flares === 0);

// ---- list parity -----------------------------------------------------------------------------
await p.click('.map-tools [data-act="list"]');
const listed = await p.waitForSelector('#memory:not([hidden]) #m-m9a8b7c6d', { timeout: 5000 }).then(() => true, () => false);
check('List shows the same memories as an accessible list', listed && await p.evaluate(() => document.querySelector('#stellar').hidden));
await p.click('#memory-switch [data-memory-view="map"]');
await p.waitForSelector('#stellar:not([hidden])');
check('Map travels back in (push-in)', await p.evaluate(() => document.querySelector('#stellar').classList.contains('is-entering')));
check('no errors through the walkthrough', p.errors.length === 0, p.errors.join(' | '));

// ---- frame time on this machine's software renderer ---------------------------------------
await p.waitForTimeout(800);
const fps = await p.evaluate(() => new Promise((ok) => {
  const t = []; let last = performance.now(); let n = 0;
  const el = document.querySelector('.map-canvas');
  const r = el.getBoundingClientRect();
  const tick = (now) => { t.push(now - last); last = now; el.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 400 + (n % 40) * 5, clientY: r.top + 300, bubbles: true })); if (++n < 40) requestAnimationFrame(tick); else ok(t.slice(10)); };
  requestAnimationFrame(tick);
}));
const avg = fps.reduce((a, b) => a + b, 0) / fps.length;
results.frameMs = Math.round(avg * 10) / 10;
console.log(`  frame time while interacting (SwiftShader, no GPU): ${avg.toFixed(1)} ms`);

// ---- other themes have no map ---------------------------------------------------------------
{
  const q = await page({ theme: 'paper' });
  await q.goto(`${base}/memory`);
  await q.waitForSelector('#memory:not([hidden]) .memory-item');
  check('Paper: Memory is the list only, no map and no switch', await q.evaluate(() => document.querySelector('#stellar').hidden && document.querySelector('#memory-switch').hidden));
}

// ---- reduced motion: a still, labelled chart --------------------------------------------------
{
  const q = await page({ reducedMotion: 'reduce' });
  await q.goto(`${base}/memory`);
  await ready(q);
  const id = 'topic:northwind';
  await q.evaluate((i) => window.__stellar.select(i), id);
  await q.waitForTimeout(50);
  const s = await q.evaluate(() => window.__stellar.state());
  check('reduced motion: no flights, the camera arrives at once', !s.flying && s.selected === id);
  await q.waitForTimeout(500);
  await q.screenshot({ path: join(out, 'nova-map-reduced.png') });
}

// ---- small screens -----------------------------------------------------------------------------
{
  const q = await page({ width: 390, height: 844 });
  await q.goto(`${base}/memory`);
  await ready(q);
  await q.waitForTimeout(800);
  await q.screenshot({ path: join(out, 'mobile-map.png') });
  const n = await q.evaluate(() => window.__stellar.where('you'));
  await q.mouse.click(n.x, n.y);
  await q.waitForTimeout(500);
  await q.screenshot({ path: join(out, 'mobile-map-selected.png') });
  check('phone: the map fits and the inspector is a bottom sheet', await q.evaluate(() => { const r = document.querySelector('.map-inspector').getBoundingClientRect(); return r.width > 300 && r.bottom <= innerHeight; }));
}

// ---- the empty days ---------------------------------------------------------------------------
{
  const empty = mkdtempSync(join(tmpdir(), 'nova-map-empty-'));
  const port2 = port + 1;
  const s2 = spawn(process.execPath, [join(root, 'src/server.js')], { env: { ...process.env, NOVA_HOME: empty, NOVA_PORT: String(port2), NOVA_AGENT_CMD: `node ${join(root, 'scripts/fake-agent.js')}` }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok) => s2.stdout.on('data', (d) => { if (String(d).includes('ready')) ok(); }));
  const q = await page();
  await q.goto(`http://localhost:${port2}/memory`);
  await q.waitForSelector('.map-empty:not([hidden])', { timeout: 30000 });
  await q.waitForTimeout(800);
  await q.screenshot({ path: join(out, 'nova-map-empty.png') });
  check('empty: just the Nova, the starfield, and one line', /Nothing remembered yet/.test(await q.textContent('.map-empty')));
  s2.kill();
}

writeFileSync(join(out, 'map-results.json'), `${JSON.stringify(results, null, 2)}\n`);
const failed = results.checks.filter((c) => !c.ok);
console.log(`\n${results.checks.length - failed.length}/${results.checks.length} checks passed.`);
await done(failed.length ? 1 : 0);
