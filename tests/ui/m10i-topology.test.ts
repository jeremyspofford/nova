import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browser, device, ready } from './support.ts';
import { topologyFixture } from './m10i-support.ts';

test('M10i: real seeded topology route, Settings Services and Health Devices entry points', async (t) => {
  const b = await browser(); if (typeof b === 'string') return t.skip(b);
  const f = await topologyFixture();
  try {
    const d = await device(b, { serviceWorkers: 'block' });
    await d.page.goto(`${f.base}/settings#services`); await ready(d.page);
    assert.equal(await d.page.locator('#services a[href="/topology"]').count(), 1, 'Settings Services links to the map');
    await d.page.locator('#services a[href="/topology"]').click();
    await d.page.locator('#topology-view [data-topology-machine]').first().waitFor();
    assert.equal(await d.page.locator('#rail [data-dest="topology"]').count(), 0);
    assert.equal(await d.page.locator('#rail [data-dest="settings"]').getAttribute('aria-current'), 'page');
    assert.equal((await d.page.reload())?.status(), 200, 'deep link is a real app page');
    await d.page.goto(`${f.base}/health`); await ready(d.page);
    await d.page.locator('#health-view a[href="/topology"]').click();
    await d.page.locator('#topology-view [data-topology-machine]').first().waitFor();
    assert.deepEqual(d.errors, []);
  } finally { await b.close(); await f.close(); }
});

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, webkitBrowser, still } from './support.ts';
import type { Page } from 'playwright-core';

async function map(page: Page, base: string) { await page.goto(`${base}/topology`); await ready(page); await page.locator('#topology-view [data-topology-machine]').first().waitFor(); }
async function detail(page: Page, hub: string, service = 'ordinary') {
  await page.locator(`[data-topology-machine="${hub}"]`).click();
  await page.locator(`[data-topology-service="${hub}/${service}"]`).click();
}
async function noOverflow(page: Page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await page.locator('#topology-view').evaluate(root => [...root.querySelectorAll<HTMLElement>('.topology-name,.topology-meta,button,dd')].filter(e => e.clientWidth && e.scrollWidth > e.clientWidth + 1).map(e => e.textContent)), []);
}
async function shot(page: Page, engine: string, size: string, state: string) {
  if (!process.env.NOVA_UI_SHOTS) return;
  const dir = join(ROOT, 'docs/screenshots/m10i-app', engine); mkdirSync(dir, { recursive: true });
  await still(page); await page.screenshot({ path: join(dir, `${state}-${size}.png`), fullPage: true, animations: 'disabled' });
}
for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`M10i: ${engine} real app, all six active themes at phone/desktop, layers, focus and exact snapshot export`, { timeout: 240_000 }, async (t) => {
    const b = await launch(); if (typeof b === 'string') return t.skip(b);
    const f = await topologyFixture();
    try {
      const packages = (await f.send('GET', '/api/v1/design-systems')).body;
      assert.equal(packages.length, 7);
      for (const [size, vp] of [['phone', { width: 390, height: 844, touch: true }], ['desktop', { width: 1440, height: 900 }]] as const) {
        const d = await device(b, { ...vp, serviceWorkers: 'block' }); const p = d.page;
        for (const pkg of packages) {
          // Off the app before applying: a live page follows the `profile` event with GET /profile,
          // /identity and /caps, and navigating while they are in flight makes WebKit log each
          // cancelled fetch as an "access control checks" error.
          await p.goto('about:blank');
          const applied = await f.send('POST', `/api/v1/design-systems/${pkg.id}/apply`, { scope: 'user' }); assert.equal(applied.status, 200);
          await map(p, f.base);
          const bg = String((await f.send('GET', `/api/v1/design-systems/${pkg.id}`)).body.manifest.tokens['bg/base']).toLowerCase();
          await p.waitForFunction(w => getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim().toLowerCase() === w, bg);
          await noOverflow(p);
          assert.equal(await p.locator('.topology-connections').isVisible(), size === 'desktop');
          if (pkg.id === 'nebula') await shot(p, engine, size, 'machines');
          // Export is the exact server snapshot already displayed; clicking export does not GET again.
          let reads = 0; let expected = '';
          p.on('response', async r => { if (r.url().endsWith('/api/v1/services/topology') && r.status() === 200) { reads++; expected = (await r.json()).mermaid; } });
          await p.locator('[data-topology-refresh]').click();
          await p.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-topology-refresh]')?.disabled);
          const before = reads;
          const download = p.waitForEvent('download'); await p.locator('[data-topology-export]').click();
          const file = await (await download).path(); assert.ok(file); assert.equal(readFileSync(file, 'utf8'), expected); assert.equal(reads, before);
          const hub = p.locator(`[data-topology-machine="${f.hubId}"]`); await hub.focus(); await p.keyboard.press('Enter');
          const ordinary = p.locator(`[data-topology-service="${f.hubId}/ordinary"]`);
          if (pkg.id === 'nebula') await shot(p, engine, size, 'services');
          await p.keyboard.press('Tab'); assert.equal(await ordinary.evaluate(e => e === document.activeElement), false, 'console is the first service');
          await ordinary.focus(); await p.keyboard.press('Enter'); await noOverflow(p);
          assert.match(await p.locator('.topology').innerText(), /Serving on this machine/);
          if (pkg.id === 'nebula') await shot(p, engine, size, 'versions');
          await p.locator('[data-topology-action="promote"]').click(); await p.locator('.approval-sheet[data-tier="2"]').waitFor();
          if (pkg.id === 'nebula') await shot(p, engine, size, 'approval');
          await p.keyboard.press('Escape'); await p.locator('[data-topology-back]').click();
          assert.equal(await ordinary.evaluate(e => e === document.activeElement), true);
          await p.locator('[data-topology-back]').click(); assert.equal(await hub.evaluate(e => e === document.activeElement), true);
          if (pkg.id === 'nebula') {
            await detail(p, f.hubId, 'capture-demo');
            await p.locator('[data-topology-action="promote"]').click(); await p.locator('.approval-sheet[data-tier="3"]').waitFor();
            await shot(p, engine, size, 'approval-capture'); await p.keyboard.press('Escape');
            await p.locator('[data-topology-action="rollback"]').click(); await p.locator('.approval-sheet[data-tier="2"]').waitFor();
            await shot(p, engine, size, 'rollback-capture'); await p.keyboard.press('Escape');
            await p.locator('[data-topology-back]').click(); await p.locator('[data-topology-back]').click();
          }
          f.controls.long = true; await p.locator('[data-topology-refresh]').click();
          await p.getByText(/A synthetic cloud site with/).waitFor(); await noOverflow(p); f.controls.long = false;
        }
        assert.deepEqual(d.errors, []); await d.ctx.close();
      }
    } finally { await b.close(); await f.close(); }
  });
}

test('M10i: server policy tiers, exact fixed action bodies, all rollbacks, revalidation, refusal and acknowledgement', async (t) => {
  const b = await browser(); if (typeof b === 'string') return t.skip(b);
  const f = await topologyFixture();
  try {
    const d = await device(b, { serviceWorkers: 'block' }); const p = d.page;
    const posts: { path: string; body: unknown }[] = [];
    p.on('request', r => { if (r.method() === 'POST' && r.url().includes('/services/')) posts.push({ path: new URL(r.url()).pathname, body: r.postDataJSON() }); });
    for (const [service, tier] of [['ordinary', 2], ['capture-demo', 3], ['privileged', 3]] as const) for (const action of ['promote', 'rollback']) {
      await map(p, f.base); await detail(p, f.hubId, service);
      await p.locator(`[data-topology-action="${action}"]`).click();
      const expectedTier = action === 'rollback' ? 2 : tier;
      await p.locator(`.approval-sheet[data-tier="${expectedTier}"]`).waitFor();
      assert.equal(await p.locator('[data-action="approve"]').isDisabled(), expectedTier === 3);
      await shot(p, 'chromium', 'desktop', `${action}-${service}-tier${expectedTier}`);
      if (expectedTier === 3) await p.locator('[name="confirm"]').check();
      const n = posts.length;
      await p.locator('[data-action="approve"]').dblclick();
      await p.locator('#sheet:not([open])').waitFor({ state: 'attached' });
      assert.match(await p.locator('[data-topology-notice]').innerText(), /Accepted.*not.*serving/i);
      assert.equal(posts.length, n + 1, 'pending double click sends only once');
      const { passkey_approval: approval, ...sent } = (posts.at(-1)!.body ?? {}) as Record<string, unknown>;
      assert.equal(!!approval, expectedTier === 3, 'tier 3 carries its passkey approval (T2); tier 2 none');
      assert.deepEqual({ path: posts.at(-1)!.path, body: sent }, { path: `/api/v1/services/hub/${service}/${action}`, body: action === 'promote' ? { version: '2.0.0', confirm: `${service}@2.0.0`, expected: { live: '1.0.0', previous: '0.9.0', assigned: null } } : { confirm: 'rollback', expected: { live: '1.0.0', previous: '0.9.0', assigned: null } } });
    }
    await map(p, f.base); await detail(p, f.hubId); await p.locator('[data-topology-action="promote"]').click();
    const before = posts.length; f.controls.policy = 3;
    await p.locator('[data-action="approve"]').click();
    await p.getByText(/target or its policy changed/i).waitFor(); assert.equal(posts.length, before, 'policy change cancels the old approval');
    f.controls.policy = 2;
    await map(p, f.base); await detail(p, f.hubId); await p.locator('[data-topology-action="promote"]').click();
    f.controls.oldService = true; await p.locator('[data-action="approve"]').click();
    await p.getByText(/target or its policy changed/i).waitFor(); assert.equal(posts.length, before, 'stale source cancels approval');
    assert.equal(await p.locator('[data-topology-heading]').evaluate(e => e === document.activeElement), true, 'unavailable action returns focus to its service heading');
    f.controls.oldService = false;
    await map(p, f.base); await detail(p, f.hubId); await p.locator('[data-topology-action="promote"]').click();
    f.controls.candidate = '3.0.0'; await p.locator('[data-action="approve"]').click();
    await p.getByText(/target or its policy changed/i).waitFor(); assert.equal(posts.length, before);
    await map(p, f.base); await detail(p, f.hubId); await p.locator('[data-topology-action="promote"]').click();
    f.controls.refusal = true; await p.locator('[data-action="approve"]').click();
    await p.getByText(/no longer ready/).waitFor(); assert.equal(posts.length, before + 1);
    // Real routes enforce access and strict action fields, even with a controlled supervisor.
    assert.equal((await f.send('POST', '/api/v1/services/hub/ordinary/promote', { version: '3.0.0', confirm: 'wrong' })).status, 400);
    assert.equal((await f.send('POST', '/api/v1/services/hub/ordinary/rollback', { confirm: 'rollback', argv: ['unexpected'] })).status, 400);
    assert.deepEqual(d.errors.filter(e => !e.includes('409') && !e.includes('400')), []);
  } finally { await b.close(); await f.close(); }
});

test('M10i: fresh machine never freshens old service, capture lag is factual and aged, failed refresh remains unknown', async (t) => {
  const b = await browser(); if (typeof b === 'string') return t.skip(b);
  const f = await topologyFixture();
  try {
    const d = await device(b, { serviceWorkers: 'block' }); const p = d.page;
    f.controls.oldService = true; f.controls.partial = true;
    await map(p, f.base); assert.match(await p.locator('#topology-view').innerText(), /Cluster observations unavailable/);
    await detail(p, f.hubId);
    const text = await p.locator('.topology').innerText(); assert.match(text, /18 minutes old/); assert.match(text, /Current service health is unknown/); assert.match(text, /Previously reported: Last reported live; current serving is unverified/);
    assert.equal(await p.locator('.topology [data-status="verified"]').count(), 0);
    assert.equal(await p.locator('[data-topology-action="promote"]').isDisabled(), true);
    await shot(p, 'chromium', 'desktop', 'stale-service');
    await map(p, f.base); await p.locator(`[data-topology-machine="${f.deviceId}"]`).click();
    const lag = await p.locator('.topology').innerText(); assert.match(lag, /17 pending events/); assert.match(lag, /Synthetic source is paused/); assert.match(lag, /18 minutes old/); assert.match(lag, /consent.*unknown/i);
    await shot(p, 'chromium', 'desktop', 'capture-lag');
    await p.route('**/api/v1/services/topology', r => r.abort());
    await p.locator('[data-topology-refresh]').click(); await p.getByText(/map could not refresh/i).waitFor();
    await shot(p, 'chromium', 'desktop', 'failed-refresh');
    await p.locator('[data-topology-return]').click();
    assert.match(await p.locator('.topology').innerText(), /Current machine health is unknown/);
    assert.equal(await p.locator('[data-topology-export]').isDisabled(), true);
    await p.locator('[data-topology-back]').click(); await p.locator(`[data-topology-machine="${f.hubId}"]`).click();
    await p.locator(`[data-topology-service="${f.hubId}/ordinary"]`).click();
    assert.equal(await p.locator('[data-topology-action="rollback"]').isDisabled(), true);
  } finally { await b.close(); await f.close(); }
});

test('M10i: a real controlling service worker never revives cached topology as current offline', async (t) => {
  const b = await browser(); if (typeof b === 'string') return t.skip(b);
  const f = await topologyFixture();
  try {
    const d = await device(b); const p = d.page;
    await map(p, f.base); await p.evaluate(() => navigator.serviceWorker.ready); await p.reload(); await ready(p);
    await p.waitForFunction(() => !!navigator.serviceWorker.controller);
    await p.locator('#topology-view [data-topology-machine]').first().waitFor();
    // Poison the cache deliberately: network-only topology must ignore even an existing hit.
    await p.evaluate(async () => { const c = await caches.open('nova-shell-v14'); await c.put('/api/v1/services/topology', new Response(JSON.stringify({ captured_at: new Date().toISOString(), fresh_for_ms: 120000, machines: [], mermaid: 'POISON', issues: [] }), { headers: { 'content-type': 'application/json' } })); });
    await detail(p, f.hubId);
    assert.equal(await p.locator('[data-topology-action="promote"]').isVisible(), true, 'ordinary service exposes its real promotion control before outage');
    assert.equal(await p.locator('[data-topology-action="promote"]').isEnabled(), true, 'ordinary service promotion is available before outage');
    const port = (f.nova.server.address() as import('node:net').AddressInfo).port;
    await new Promise<void>(resolve => { f.nova.server.close(() => resolve()); f.nova.server.closeAllConnections(); });
    await d.ctx.setOffline(true);
    await p.waitForFunction(() => {
      const view = document.querySelector<HTMLElement>('#topology-view');
      return !!view?.checkVisibility() && !!view.querySelector('.topology') && !view.querySelector('[data-topology-action="promote"]:enabled') && /health is unknown/i.test(view.textContent ?? '');
    });
    assert.equal(await p.locator('[data-topology-action="promote"]:enabled').count(), 0, 'no promotion can be issued after outage');
    assert.equal(await p.locator('[data-topology-export]').isDisabled(), true);
    // A failed read may show the safe failed-observation view with no promotion control.
    // Open the actual last-observation door to inspect the selected service's unknown state.
    const previous = p.locator('[data-topology-return]');
    if (await previous.isVisible()) await previous.click();
    assert.match(await p.locator('.topology').innerText(), /Current service health is unknown/);
    const offline = await p.evaluate(async () => { const r = await fetch('/api/v1/services/topology'); return { status: r.status, stale: r.headers.get('x-nova-offline'), text: await r.text() }; });
    assert.equal(offline.status, 503); assert.equal(offline.stale, '1'); assert.ok(!offline.text.includes('POISON'));
    await p.reload(); await ready(p); await p.getByText(/map could not refresh/i).waitFor();
    assert.equal(await p.locator('[data-topology-machine]').count(), 0, 'offline deep link has shell but no fabricated observations');
    await new Promise<void>(resolve => f.nova.server.listen(port, '127.0.0.1', resolve));
    await d.ctx.setOffline(false); await p.locator('[data-topology-refresh]').click(); await p.locator('[data-topology-machine]').first().waitFor();
    assert.equal(await p.locator('[data-topology-export]').isEnabled(), true);
  } finally { await b.close(); await f.close(); }
});

test('M10i: coalesced visible polling, expired sources, preserved focus, approval pause and late response protection', async (t) => {
  const b = await browser(); if (typeof b === 'string') return t.skip(b);
  const f = await topologyFixture();
  try {
    const d = await device(b, { serviceWorkers: 'block' }); const p = d.page;
    await p.clock.install();
    let reads = 0; p.on('request', r => { if (r.url().endsWith('/api/v1/services/topology')) reads++; });
    await map(p, f.base); await detail(p, f.hubId);
    await p.locator('[data-topology-action="promote"]').focus();
    const before = reads; await p.clock.runFor(10_100); await p.waitForTimeout(100);
    assert.equal(reads, before + 1); assert.equal(await p.locator('[data-topology-action="promote"]').evaluate(e => e === document.activeElement), true);
    await p.locator('[data-topology-action="promote"]').click();
    const paused = reads; await p.clock.runFor(30_000); assert.equal(reads, paused, 'open approval pauses polling');
    await p.keyboard.press('Escape');
    await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    const hidden = reads; await p.clock.runFor(30_000); assert.equal(reads, hidden, 'hidden page pauses topology polling');
    await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
    await p.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-topology-refresh]')?.disabled);
    await p.route('**/api/v1/services/topology', async r => { await r.abort(); });
    await p.clock.runFor(130_000);
    assert.equal(await p.locator('[data-topology-export]').isDisabled(), true);
    await p.locator('[data-topology-return]').click();
    assert.equal(await p.locator('[data-topology-action="promote"]').isDisabled(), true);
    assert.match(await p.locator('.topology').innerText(), /minutes old/);
    await p.unroute('**/api/v1/services/topology');
    await p.locator('[data-topology-refresh]').click(); await p.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-topology-refresh]')?.disabled);
    // Capture an old result, leave, return, and release it only after the new result rendered.
    let release!: () => void; let caught!: () => void;
    const held = new Promise<void>(r => { release = r; }); const captured = new Promise<void>(r => { caught = r; });
    await p.route('**/api/v1/services/topology', async r => { const response = await r.fetch(); caught(); await held; await r.fulfill({ response }); }, { times: 1 });
    await p.locator('[data-topology-refresh]').click(); await captured;
    await p.locator('#aside a[href="/health"]').click();
    await p.locator('#health-view').waitFor({ state: 'visible' });
    f.controls.long = true;
    await p.locator('#health-view a[href="/topology"]').click();
    await p.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-topology-refresh]')?.disabled);
    assert.equal(await p.locator('[data-topology-heading]').innerText(), 'ordinary', 'route return retains service selection');
    await p.locator('[data-topology-back]').click(); await p.locator('[data-topology-back]').click();
    await p.getByText(/A synthetic cloud site with/).waitFor();
    release(); await p.waitForTimeout(100);
    assert.equal(await p.getByText(/A synthetic cloud site with/).count(), 1);
    await p.locator('#rail [data-dest="settings"]').click();
    await p.locator('#settings-view').waitFor({ state: 'visible' });
    const off = reads; await p.clock.runFor(30_000); assert.equal(reads, off, 'off-route map does not poll');
  } finally { await b.close(); await f.close(); }
});

test('M10i: real device assignment acknowledgement never claims serving and read-only device refuses mutation', async (t) => {
  const b = await browser(); if (typeof b === 'string') return t.skip(b);
  const f = await topologyFixture();
  try {
    const { standInUrl, standInSha, STAND_IN_NAME } = await import('../support/workloads.ts');
    const definition = { service: 'native-worker', version: '1', artifact: { program: { 'linux-x64': { url: standInUrl(), sha256: standInSha(), command: ['node', STAND_IN_NAME] } } }, ports: [{ name: 'api', port: 18790 }], health: { http: '/health', every_s: 5 }, contract_tests: [], alongside: 'none', placement: { mode: 'pinned', device: f.deviceId }, secrets: [], os_permissions: [], egress: 'none' };
    assert.equal((await f.send('POST', '/api/v1/services/devices/deploy', { definition, confirm: 'native-worker@1' })).status, 200);
    const heartbeat = () => f.nova.core.mesh.spokes.heartbeat(f.nova.core.mesh.devices.get(f.deviceId), { version: '0.1.0', capabilities: ['heartbeat'], workloads: [{ service: 'native-worker', version: '1', status: 'ready', health: null, since: new Date(Date.now() - 1000).toISOString() }] });
    heartbeat();
    const d = await device(b, { serviceWorkers: 'block' }); const p = d.page;
    await map(p, f.base); await detail(p, f.deviceId, 'native-worker');
    await p.locator('[data-topology-action="promote"]').click(); await p.locator('.approval-sheet[data-tier="2"]').waitFor();
    await p.locator('[data-action="approve"]').click(); await p.locator('#sheet:not([open])').waitFor({ state: 'attached' });
    assert.match(await p.locator('[data-topology-notice]').innerText(), /assignment.*acknowledged.*not.*serving/i);
    const dto = (await f.send('GET', '/api/v1/services/topology')).body.machines.find((m: any) => m.id === f.deviceId).services[0];
    assert.equal(dto.assigned.want, 'live'); assert.equal(dto.live, null);
    // A real authenticated mesh device has read access but no approval authority.
    const read = await device(b, { serviceWorkers: 'block' });
    await read.ctx.setExtraHTTPHeaders({ authorization: `Bearer ${f.readOnlyToken()}` });
    await map(read.page, f.meshBase); await detail(read.page, f.hubId);
    await read.page.locator('[data-topology-action="promote"]').click(); await read.page.locator('[data-action="approve"]').click();
    await read.page.getByText(/not allowed|approve|permission|can’t use this part/i).filter({ visible: true }).first().waitFor();
    await read.page.locator('#sheet:not([open])').waitFor({ state: 'attached' });
    assert.match(await read.page.locator('[data-topology-notice]').innerText(), /approve|allowed|permission|can’t use this part/i);
    assert.equal(f.controls.calls.length, 0, 'access refusal never reaches supervisor');
    assert.deepEqual(d.errors, []); assert.deepEqual(read.errors.filter(e => !e.includes('403')), []);
  } finally { await b.close(); await f.close(); }
});

test('M10i: real eligible version selection honors each policy and a lost acknowledgement never retries', async (t) => {
  const b = await browser(); if (typeof b === 'string') return t.skip(b);
  const f = await topologyFixture();
  try {
    f.controls.extraReady = true;
    const d = await device(b, { serviceWorkers: 'block' }); const p = d.page;
    await map(p, f.base); await detail(p, f.hubId);
    assert.deepEqual(await p.locator('[data-topology-version] option').allTextContents(), ['2.0.0', '2.1.0']);
    await p.locator('[data-topology-version]').selectOption('2.1.0'); await p.locator('[data-topology-action="promote"]').click();
    await p.locator('.approval-sheet[data-tier="3"]').waitFor(); assert.match(await p.locator('.sheet-line').innerText(), /2.1.0/);
    await p.locator('[name="confirm"]').check(); await p.locator('[data-action="approve"]').click();
    await p.locator('#sheet:not([open])').waitFor({ state: 'attached' });
    assert.deepEqual(f.controls.calls, [{ action: 'promote', service: 'ordinary', version: '2.1.0', confirm: 'ordinary@2.1.0', expected: { live: '1.0.0', previous: '0.9.0', assigned: null } }]);
    await p.route('**/api/v1/services/hub/ordinary/promote', async r => { await r.fetch(); await r.abort(); });
    await p.locator('[data-topology-action="promote"]').click(); await p.locator('[name="confirm"]').check(); await p.locator('[data-action="approve"]').click();
    await p.locator('#sheet:not([open])').waitFor({ state: 'attached' });
    assert.match(await p.locator('[data-topology-notice]').innerText(), /outcome is unknown.*not retry/i);
    assert.equal(f.controls.calls.length, 2, 'lost response causes one real POST and no retry');
    assert.equal(await p.locator('[data-topology-action="promote"]').isDisabled(), true);
  } finally { await b.close(); await f.close(); }
});

test('M10i: real empty observations and pending collection remain truthful', async (t) => {
  const b = await browser(); if (typeof b === 'string') return t.skip(b);
  const f = await topologyFixture();
  try {
    const d = await device(b, { serviceWorkers: 'block' }); const p = d.page;
    let release!: () => void; const held = new Promise<void>(r => { release = r; });
    await p.route('**/api/v1/services/topology', async r => { await held; await r.continue(); }, { times: 1 });
    await p.goto(`${f.base}/topology`); await ready(p); await p.getByText('Waiting for machine observations', { exact: true }).waitFor();
    await shot(p, 'chromium', 'desktop', 'loading');
    assert.equal(await p.locator('[data-topology-export]').isDisabled(), true);
    release(); await p.locator('[data-topology-machine]').first().waitFor();
    // The core's actual registry and cluster source now contain no observations.
    f.nova.core.db.run("UPDATE device SET trust = 'revoked'"); f.controls.partial = true;
    await p.locator('[data-topology-refresh]').click(); await p.getByText('No machines to show yet', { exact: true }).waitFor();
    await shot(p, 'chromium', 'desktop', 'empty');
    assert.equal(await p.locator('[data-topology-machine]').count(), 0);
    assert.match(await p.locator('#topology-view').innerText(), /Partial map/);
  } finally { await b.close(); await f.close(); }
});

test('M10i: shell modules and runtime scripts stay local with no production dependency', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies ?? {}, {});
  const seen = new Set<string>();
  function inspect(path: string) {
    if (seen.has(path)) return; seen.add(path);
    const text = readFileSync(join(ROOT, 'ui', path), 'utf8');
    for (const match of text.matchAll(/(?:import\s+(?:[^'";]+?\s+from\s+)?|import\s*\()(['"])([^'"]+)\1/g)) {
      assert.ok(match[2]!.startsWith('./'), `no external runtime import: ${match[2]}`);
      inspect(join('js', match[2]!));
    }
  }
  inspect('js/app.js'); assert.ok(seen.has('js/topology.js')); assert.ok(seen.has('js/topology-view.js'));
  for (const match of readFileSync(join(ROOT, 'ui/index.html'), 'utf8').matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) assert.ok(match[1]!.startsWith('/js/'));
  const sw = readFileSync(join(ROOT, 'ui/sw.js'), 'utf8');
  assert.match(sw, /'\/js\/topology.js'/); assert.match(sw, /'\/js\/topology-view.js'/);
});

test('M10i: merged current failure remains worse than stale heartbeat and preserves both reasons and export', async (t) => {
  const b = await browser(); if (typeof b === 'string') return t.skip(b);
  const f = await topologyFixture();
  try {
    f.controls.conflict = true;
    f.nova.core.db.run('UPDATE device SET last_seen = ? WHERE id = ?', new Date(Date.now() - 18 * 60000).toISOString(), f.deviceId);
    const d = await device(b, { serviceWorkers: 'block' }); const p = d.page;
    await map(p, f.base);
    const machine = p.locator(`[data-topology-machine="${f.deviceId}"]`);
    assert.equal(await machine.locator('[data-status="failed"]').count(), 1, 'current stopped source remains worse than unknown heartbeat');
    assert.equal(await p.locator('[data-topology-export]').isEnabled(), true, 'newly fetched snapshot already includes its stale sources');
    await machine.click(); assert.match(await p.locator('.topology').innerText(), /Heartbeat: No recent heartbeat/); assert.match(await p.locator('.topology').innerText(), /Cluster: Synthetic cluster reports the node stopped/); assert.match(await p.locator('.topology').innerText(), /18 minutes old/);
    await shot(p, 'chromium', 'desktop', 'merged-failure');
  } finally { await b.close(); await f.close(); }
});

test('M10i: time spent collecting cannot freshen near-expired service evidence', async (t) => {
  const b = await browser(); if (typeof b === 'string') return t.skip(b);
  const f = await topologyFixture();
  try {
    f.controls.serviceAgeMs = 115000;
    const d = await device(b, { serviceWorkers: 'block' }); const p = d.page;
    await p.clock.install();
    let release!: () => void; let captured!: () => void;
    const held = new Promise<void>(r => { release = r; }); const collected = new Promise<void>(r => { captured = r; });
    await p.route('**/api/v1/services/topology', async r => { const response = await r.fetch(); captured(); await held; await r.fulfill({ response }); }, { times: 1 });
    await p.goto(`${f.base}/topology`); await ready(p); await collected;
    await p.clock.runFor(8000); release(); await p.locator('[data-topology-machine]').first().waitFor();
    await detail(p, f.hubId);
    assert.equal(await p.locator('[data-topology-action="promote"]').isDisabled(), true, '115-second evidence plus 8-second collection is stale');
    assert.equal(await p.locator('[data-topology-export]').isDisabled(), true);
    assert.match(await p.locator('.topology').innerText(), /2 minutes old/);
  } finally { await b.close(); await f.close(); }
});

test('M10i: moving the wall clock backward cannot make retained service evidence fresh', async (t) => {
  const b = await browser(); if (typeof b === 'string') return t.skip(b);
  const f = await topologyFixture();
  try {
    f.controls.serviceAgeMs = 115000;
    const d = await device(b, { serviceWorkers: 'block' }); const p = d.page;
    await p.clock.install(); await map(p, f.base); await detail(p, f.hubId);
    assert.equal(await p.locator('[data-topology-action="promote"]').isEnabled(), true);
    await p.clock.setSystemTime(new Date(Date.now() - 3600000)); await p.clock.runFor(8000);
    await p.locator('[data-topology-back]').click(); await p.locator(`[data-topology-service="${f.hubId}/ordinary"]`).click();
    assert.equal(await p.locator('[data-topology-action="promote"]').isDisabled(), true, 'monotonic elapsed time expires evidence despite a backward wall-clock adjustment');
    assert.equal(await p.locator('[data-topology-export]').isDisabled(), true);
  } finally { await b.close(); await f.close(); }
});

test('M10i: pending approval keeps confirmation controls disabled until its one request finishes', async (t) => {
  const b = await browser(); if (typeof b === 'string') return t.skip(b);
  const f = await topologyFixture();
  try {
    const d = await device(b, { serviceWorkers: 'block' }); const p = d.page;
    await map(p, f.base); await detail(p, f.hubId, 'privileged');
    await p.locator('[data-topology-action="promote"]').click(); await p.locator('[name="confirm"]').check();
    let release!: () => void; let captured!: () => void;
    const held = new Promise<void>(r => { release = r; }); const collected = new Promise<void>(r => { captured = r; });
    await p.route('**/api/v1/services/topology', async r => { const response = await r.fetch(); captured(); await held; await r.fulfill({ response }); }, { times: 1 });
    await p.locator('[data-action="approve"]').click(); await collected;
    assert.equal(await p.locator('[name="confirm"]').isDisabled(), true, 'pending confirmation cannot re-enable submit through the shared change handler');
    assert.equal(await p.locator('[data-action="approve"]').isDisabled(), true);
    release(); await p.locator('#sheet:not([open])').waitFor({ state: 'attached' });
    assert.equal(f.controls.calls.length, 1);
  } finally { await b.close(); await f.close(); }
});

test('M10i: optional live retained context leaves the approved stale-machine fixture unchanged', async () => {
  const modulePath = '../../ui/js/topology-view.js'; const { renderTopology } = await import(modulePath);
  const machine = { id: 'fixture', name: 'Fixture', roles: [], age: '18 minutes old', status: 'needs-you', stale: true, observations: [{ source: 'Heartbeat', reason: 'No response', age: '18 minutes old' }], services: [] };
  const old = renderTopology({ machines: [machine], selectedMachine: 'fixture' });
  assert.ok(!old.includes('Current machine health is unknown.'), 'live retained copy must be opt-in rather than altering the approved fixture fallback');
  const retained = renderTopology({ machines: [{ ...machine, lastObservation: true }], selectedMachine: 'fixture' });
  assert.match(retained, /Current machine health is unknown/);
});

test('M10i: review follows the displayed eligible candidate after the prior selection disappears', async (t) => {
  const b = await browser(); if (typeof b === 'string') return t.skip(b);
  const f = await topologyFixture();
  try {
    f.controls.extraReady = true;
    const d = await device(b, { serviceWorkers: 'block' }); const p = d.page;
    await map(p, f.base); await detail(p, f.hubId); await p.locator('[data-topology-version]').selectOption('2.1.0');
    f.controls.extraReady = false; await p.locator('[data-topology-refresh]').click();
    await p.waitForFunction(() => document.querySelector('[data-topology-version]')?.children.length === 1);
    assert.equal(await p.locator('[data-topology-version]').inputValue(), '2.0.0');
    await p.locator('[data-topology-action="promote"]').click();
    await p.locator('.approval-sheet[data-tier="2"]').waitFor({ timeout: 1500 });
    assert.match(await p.locator('.sheet-line').innerText(), /to 2.0.0/);
    await p.locator('[data-action="approve"]').click(); await p.locator('#sheet:not([open])').waitFor({ state: 'attached' });
    assert.deepEqual(f.controls.calls, [{ action: 'promote', service: 'ordinary', version: '2.0.0', confirm: 'ordinary@2.0.0', expected: { live: '1.0.0', previous: '0.9.0', assigned: null } }]);
  } finally { await b.close(); await f.close(); }
});

test('M10i: an unknown active hub never invents graph links or mutation authority', async (t) => {
  const b = await browser(); if (typeof b === 'string') return t.skip(b);
  const f = await topologyFixture();
  try {
    f.nova.core.db.run('UPDATE mesh_state SET hub_id = NULL WHERE id = 1');
    const dto = (await f.send('GET', '/api/v1/services/topology')).body;
    assert.equal(dto.hub_id, null); assert.equal(dto.machines.some((m: any) => m.hub), false);
    const d = await device(b, { serviceWorkers: 'block' }); const p = d.page;
    await map(p, f.base);
    assert.equal(await p.locator('.topology-connections').count(), 0, 'no real active hub means no invented hub connections');
    assert.equal(await p.locator('.topology-hub').count(), 0, 'unknown hub has no misleading hub class');
    await noOverflow(p); await shot(p, 'chromium', 'desktop', 'no-hub');
    await detail(p, f.hubId);
    assert.equal(await p.locator('[data-topology-action="promote"]').isDisabled(), true);
    assert.match(await p.locator('.topology').innerText(), /No supported mutation authority/);
  } finally { await b.close(); await f.close(); }
});

test('M10i: null or absent live hub uses existing rows while undefined preserves the approved fixture', async () => {
  const modulePath = '../../ui/js/topology-view.js'; const { renderTopology } = await import(modulePath);
  const row = { id: 'one', name: 'One', roles: ['spoke'], age: '1 second old', status: 'waiting', observations: [], services: [] };
  const machines = [row, { ...row, id: 'two', name: 'Two' }];
  const legacy = renderTopology({ machines }); assert.match(legacy, /class="topology-hub"/); assert.match(legacy, /topology-connections/);
  for (const hubId of [null, 'not-observed']) {
    const live = renderTopology({ machines, hubId });
    assert.ok(!live.includes('class="topology-hub"'), `${hubId}: no invented hub class`);
    assert.ok(!live.includes('topology-connections'), `${hubId}: no invented connections`);
    assert.match(live, /class="topology-services"/); assert.match(live, /class="topology-row"/);
  }
});

for (const health of ['failed', 'degraded'] as const) test(`M10i I2: independently expired heartbeat preserves current ${health} machine and service evidence`, async t => {
  const b = await browser(); if (typeof b === 'string') return t.skip(b);
  const f = await topologyFixture();
  try {
    f.controls.conflict = true; f.controls.conflictHealth = health;
    f.nova.core.db.run('UPDATE device SET last_seen = ? WHERE id = ?', new Date(Date.now() - 115000).toISOString(), f.deviceId);
    const d = await device(b, { serviceWorkers: 'block' }); const p = d.page; await p.clock.install(); await map(p, f.base);
    await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await p.clock.runFor(8000); await p.locator(`[data-topology-machine="${f.deviceId}"]`).click();
    const tone = health === 'failed' ? 'failed' : 'needs-you';
    assert.equal(await p.locator('.topology-heading [data-status]').getAttribute('data-status'), tone, 'a fresh worse source survives another source expiring');
    assert.equal(await p.locator(`[data-topology-service="${f.deviceId}/observed-worker"] [data-status]`).getAttribute('data-status'), tone);
    await p.locator(`[data-topology-service="${f.deviceId}/observed-worker"]`).click();
    assert.equal(await p.locator('.topology-heading [data-status]').getAttribute('data-status'), tone);
    assert.equal(await p.locator('[data-topology-export]').isDisabled(), true);
    assert.match(await p.locator('.topology').innerText(), /2 minutes old.*stale/s); assert.match(await p.locator('.topology').innerText(), /9 seconds old/);
    await p.clock.runFor(111100); await p.locator('[data-topology-back]').click();
    assert.equal(await p.locator('.topology-heading [data-status]').getAttribute('data-status'), 'waiting', 'the failed/degraded source itself eventually expires');
    assert.equal(await p.locator(`[data-topology-service="${f.deviceId}/observed-worker"] [data-status]`).getAttribute('data-status'), 'waiting');
  } finally { await b.close(); await f.close(); }
});

for (const kind of ['post', 'get-rejection']) test(`M10i I3: late ${kind} cannot close or focus a replacement approval`, async t => {
  const b = await browser(); if (typeof b === 'string') return t.skip(b);
  const f = await topologyFixture();
  try {
    const d = await device(b, { serviceWorkers: 'block' }); const p = d.page;
    await map(p, f.base); await detail(p, f.hubId); await p.locator('[data-topology-action="promote"]').click();
    let release!: () => void, captured!: () => void, finished!: () => void;
    const held = new Promise<void>(r => { release = r; }), collected = new Promise<void>(r => { captured = r; }), done = new Promise<void>(r => { finished = r; });
    await p.route(kind === 'post' ? '**/api/v1/services/hub/ordinary/promote' : '**/api/v1/services/topology', async r => {
      const response = await r.fetch(); captured(); await held;
      if (kind === 'post') await r.fulfill({ response }); else await r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Held topology read was rejected.' }) });
      finished();
    }, { times: 1 });
    await p.locator('[data-action="approve"]').click(); await collected; await p.keyboard.press('Escape');
    // Real SPA navigation and real tier-3 revoke sheet, in the same document/global dialog.
    await p.evaluate(() => { const a = document.createElement('a'); a.href = '/settings#devices'; document.body.append(a); a.click(); a.remove(); });
    await p.locator(`#devices [data-action="revoke-device"][data-device="${f.deviceId}"]`).click();
    const replacement = p.locator(`.approval-sheet[data-revoke="${f.deviceId}"]`); await replacement.waitFor();
    await replacement.locator('[name="confirm"]').focus();
    release(); await done; await p.waitForTimeout(150);
    assert.equal(await p.locator('#sheet').getAttribute('open'), '', 'the replacement sheet remains open');
    assert.equal(await replacement.count(), 1); assert.equal(await replacement.locator('[name="confirm"]').evaluate(e => e === document.activeElement), true, 'late work does not steal replacement focus');
    assert.equal(f.controls.calls.length, kind === 'post' ? 1 : 0);
    await p.keyboard.press('Escape');
    await p.evaluate(() => { const a = document.createElement('a'); a.href = '/topology'; document.body.append(a); a.click(); a.remove(); });
    await p.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-topology-refresh]')?.disabled);
    assert.match(await p.locator('[data-topology-notice]').innerText(), kind === 'post' ? /Accepted/ : /Held topology read was rejected/, 'late result remains available after return and refresh');
  } finally { await b.close(); await f.close(); }
});

test('M10i: serving labels require current healthy evidence, including held and null-health live versions', async (t) => {
  const b = await browser(); if (typeof b === 'string') return t.skip(b);
  const f = await topologyFixture();
  try {
    const d = await device(b, { serviceWorkers: 'block' }); const p = d.page;
    for (const scenario of ['held', 'stopped', 'unknown', 'healthy']) {
      await p.route('**/api/v1/services/topology', async r => {
        const response = await r.fetch(), data = await response.json();
        const s = data.machines.find((m: any) => m.id === f.hubId).services.find((s: any) => s.service === 'ordinary');
        if (scenario === 'unknown') { s.observations[0].health = 'unknown'; s.observations[0].reason = 'No verified service health observation.'; }
        if (scenario === 'held' || scenario === 'stopped') s.observations.push({ source: 'supervisor', at: data.captured_at, age_ms: 0, stale: false, health: 'failed', reason: scenario === 'held' ? 'The service is held after stopping repeatedly.' : 'The supervisor reports that the console stopped.' });
        await r.fulfill({ response, json: data });
      });
      await map(p, f.base); await detail(p, f.hubId);
      const content = await p.locator('.topology').innerText();
      if (scenario === 'healthy') assert.match(content, /Serving on this machine/);
      else {
        assert.doesNotMatch(content, /Serving on this machine/, scenario);
        assert.equal(await p.locator('.topology [data-status="verified"]').count(), 0);
        assert.match(content, /current serving is unverified/i);
      }
      if (scenario === 'held' || scenario === 'stopped') assert.equal(await p.locator('.topology [data-status="failed"]').count(), 1);
      await p.unroute('**/api/v1/services/topology');
    }
    assert.deepEqual(d.errors, []);
  } finally { await b.close(); await f.close(); }
});
