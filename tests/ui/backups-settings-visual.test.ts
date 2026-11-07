// Current app/specimen parity and native-scroll viewport evidence. Public recovery placeholder
// only; no generated key is captured. No forced styles, replaced DOM or screenshot retries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Browser, Locator, Page } from 'playwright-core';
import { blank, browser, webkitBrowser, device, finishSetup, ready, still, ROOT, shortTargets, until } from './support.ts';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { ensureMark } from '../../src/core/resilience/home-mark.ts';

const KEY = '01234567-89abcdef-01234567-89abcdef-01234567-89abcdef-01234567-89abcdef';
const POSTURES = { phone: { width: 390, height: 844 }, rail: { width: 1440, height: 900 }, tablet: { width: 820, height: 1180 }, halfopen: { width: 842, height: 675 } };

async function open(page: Page) {
  if (!await page.locator('a[href="/settings"]').filter({ visible: true }).first().isVisible()) await page.locator('#more-btn').click();
  await page.locator('a[href="/settings"]').filter({ visible: true }).first().click();
  await page.locator('#settings-nav a[data-cat="backups"]').click();
  await page.locator('[data-action="backups-save"]').waitFor();
}
async function geometry(page: Page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page overflow');
  const root = page.locator('.backups-settings');
  assert.deepEqual(await root.evaluate(e => [...e.querySelectorAll<HTMLElement>('h2,h3,p,button,pre,code')].filter(n => n.clientWidth && n.scrollWidth > n.clientWidth + 1).map(n => n.tagName)), [], 'no text clipped');
  assert.deepEqual(await shortTargets(page, '.backups-settings input:not(:disabled), .backups-settings button:not(:disabled)'), [], '44px touch controls');
  const counts = await page.locator('[id]').evaluateAll(es => {
    const ids: Record<string, number> = {}; for (const e of es) ids[e.id] = (ids[e.id] ?? 0) + 1;
    return Object.entries(ids).filter(([, n]) => n > 1).sort(([a], [b]) => a.localeCompare(b));
  });
  // Ruling9: qualified702 baseline renders each of these unchanged cards in Home and aside.
  // Exact names AND count2 are pinned; no unknown/global Backups collision is allowed.
  const baseline = new URL(page.url()).pathname === '/settings' ? [['device-mesh-card-title', 2], ['handling-card-title', 2], ['health-card-title', 2]] : [];
  assert.deepEqual(counts, baseline, 'no new global ID collisions over the qualified inherited baseline');
  const componentIds = await root.locator('[id]').evaluateAll(es => es.map(e => e.id));
  for (const id of componentIds) assert.equal(await page.locator(`[id="${id}"]`).count(), 1, `${id}: globally unique Backups ID`);
  assert.equal(await page.locator('form form').count(), 0);
}
async function band(page: Page, region: Locator, path: string | null) {
  await region.scrollIntoViewIfNeeded(); await still(page);
  const observed = await region.evaluate(el => {
    const root = el.getBoundingClientRect();
    const scroller = el.closest('#scroller'); const clip = scroller?.getBoundingClientRect();
    const top = Math.max(0, clip?.top ?? 0), bottom = Math.min(innerHeight, clip?.bottom ?? innerHeight);
    const nodes = [...el.querySelectorAll<HTMLElement>('h3,p,button,label,code')].filter(e => e.checkVisibility());
    return { top: root.top, bottom: root.bottom, clipTop: top, clipBottom: bottom, painted: nodes.map(n => {
      const r = n.getBoundingClientRect(); const x = Math.max(0, Math.min(innerWidth - 1, r.left + r.width / 2)); const y = Math.max(0, Math.min(innerHeight - 1, r.top + r.height / 2));
      const hit = document.elementFromPoint(x, y);
      return { tag: n.tagName, top: r.top, bottom: r.bottom, unobscured: !!hit && (n.contains(hit) || hit.contains(n)) };
    }) };
  });
  assert.ok(observed.top >= observed.clipTop - 1 && observed.bottom <= observed.clipBottom + 1, `recovery band fits native scroll viewport: ${JSON.stringify(observed)}`);
  assert.ok(observed.painted.length > 2 && observed.painted.every(n => n.unobscured), 'heading, disclosure and controls are unobscured at capture');
  if (path) await page.screenshot({ path, fullPage: false, animations: 'disabled', caret: 'hide' });
  return observed;
}

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`Backups app/specimen ${engine}: four postures, native recovery bands and accessibility`, async () => {
    const launched = await launch(); assert.notEqual(typeof launched, 'string'); if (typeof launched === 'string') throw new Error(launched);
    const b: Browser = launched;
    const m = blank(`nova-backups-visual-${engine}-`); mkdirSync(m.env.HOME, { mode: 0o700 });
    ensureMark(m.home, { userHome: m.env.HOME });
    const nova = createNova(loadConfig({ ...m.env, NOVA_HOST: '127.0.0.1', NOVA_AGENT_CMD: '/bin/false', NOVA_AGENT_EGRESS: 'none' }));
    const target = join(m.dir, 'neutral-backup-copies'); const encrypted = join(m.dir, 'neutral-encrypted-copies');
    mkdirSync(target, { mode: 0o700 }); mkdirSync(encrypted, { mode: 0o700 });
    // A documented public placeholder, put only into this fixture's synthetic vault. No raw
    // getter/recovery-factor/broker scope and no external provider/device operation.
    nova.core.vault.put('nova/backup-key', Buffer.from(KEY.replaceAll('-', ''), 'hex').toString('base64'));
    const out = process.env.NOVA_BACKUPS_APP_SHOTS ? join(resolve(process.env.NOVA_BACKUPS_APP_SHOTS), 'matched', engine) : null;
    if (out) mkdirSync(out, { recursive: true });
    const evidence: object[] = [];
    try {
      await new Promise<void>(r => nova.server.listen(0, '127.0.0.1', r)); m.base = `http://127.0.0.1:${(nova.server.address() as { port: number }).port}`;
      await finishSetup(m);
      assert.equal((await m.send('PUT', '/api/v1/backups/settings', { target, encrypted_target: encrypted })).status, 200);
      for (const [posture, size] of Object.entries(POSTURES)) {
        const app = await device(b, { ...size, touch: posture !== 'rail', scheme: 'dark', serviceWorkers: 'block' });
        const specimen = await device(b, { ...size, touch: posture !== 'rail', scheme: 'dark', serviceWorkers: 'block' });
        await app.page.goto(`${m.base}/`); await ready(app.page); await open(app.page);
        await until(app.page, async () => (await import(String('/js/surfaces.js'))).store.reachable === true);
        // Ruling8/16: this must pass on the actual qualified Health integration. The inherited
        // pre-Health false-offline banner is retained as raw evidence, never hidden by a fixture.
        assert.equal(await app.page.locator('#banner').filter({ visible: true }).count(), 0, 'neutral live capture has no outage banner');
        await specimen.page.goto(`${m.base}/styleguide?entry=backups-settings`); await specimen.page.getByLabel('Specimen state').waitFor();
        for (const state of ['configured', 'confirm', 'shown', 'unavailable']) {
          if (state === 'confirm') await app.page.locator('[data-action="backups-reveal"]').click();
          if (state === 'shown') {
            await app.page.getByLabel('I understand that the recovery key will be visible on this screen.').check();
            await app.page.locator('[data-action="backups-confirm"]').click(); await app.page.locator('#settings-backups code').waitFor();
            assert.ok(await app.page.locator('#settings-backups code').innerText() === KEY);
          }
          if (state === 'unavailable') {
            await app.page.route('**/api/v1/mesh/status', r => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic missing mesh"}' }));
            await m.send('PUT', '/api/v1/profile/user/name', { value: `Visual missing permissions ${engine} ${posture}` });
            await app.page.waitForFunction(() => document.querySelector<HTMLInputElement>('#settings-backups input[name="target"]')?.disabled === true);
            assert.equal(await app.page.locator('#settings-backups code').count(), 0);
          }
          await specimen.page.getByLabel('Specimen state').selectOption(state);
          await specimen.page.locator(`[data-backups-specimen="${state}"]`).waitFor();
          for (const [kind, page] of [['app', app.page], ['specimen', specimen.page]] as const) {
            await geometry(page);
            const measured = await band(page, page.locator('.backups-recovery'), out ? join(out, `${posture}-${state}-${kind}-recovery.png`) : null);
            const root = page.locator('.backups-settings');
            const controls = await root.locator('input,button').evaluateAll(es => es.map(e => ({ tag: e.tagName, name: e.getAttribute('name'), action: e.getAttribute('data-action'), disabled: (e as HTMLInputElement).disabled })));
            evidence.push({ engine, posture, state, kind, measured, controls });
            if (state === 'configured' || state === 'unavailable') {
              await root.locator('h2').scrollIntoViewIfNeeded(); await still(page);
              assert.equal(await root.locator('h2').isVisible(), true);
              if (out) await page.screenshot({ path: join(out, `${posture}-${state}-${kind}-fields.png`), fullPage: false, animations: 'disabled', caret: 'hide' });
            }
            await page.addScriptTag({ content: readFileSync(join(ROOT, 'node_modules/axe-core/axe.min.js'), 'utf8') });
            const violations = await page.evaluate(async () => (await (window as any).axe.run(document.querySelector('.backups-settings'))).violations.map((v: any) => ({ id: v.id, nodes: v.nodes.map((n: any) => n.target) })));
            assert.deepEqual(violations, [], `${engine}/${posture}/${state}/${kind}: axe`);
          }
          if (state !== 'unavailable') {
            const actions = (p: Page) => p.locator('.backups-settings button').evaluateAll(es => es.map(e => e.getAttribute('data-action')));
            assert.deepEqual(await actions(app.page), await actions(specimen.page), 'same shared component actions, not a shadow implementation');
            const labels = (p: Page) => p.locator('.backups-settings label').allTextContents();
            assert.deepEqual(await labels(app.page), await labels(specimen.page));
          }
        }
        assert.deepEqual(app.errors.filter(e => !/Failed to load resource/.test(e)), []);
        assert.deepEqual(specimen.errors, []);
        await app.ctx.close(); await specimen.ctx.close();
      }
      if (out) writeFileSync(join(out, 'matrix.json'), JSON.stringify(evidence, null, 2));
    } finally {
      await b.close(); nova.scheduler.stop(); nova.server.closeAllConnections();
      if (nova.server.listening) await new Promise<void>(r => nova.server.close(() => r()));
      await nova.core.close(); rmSync(m.dir, { recursive: true, force: true });
    }
  });
}


test('Backups actual missing-key conflict and replica console stay within existing guards', async () => {
  const b = await browser(); assert.notEqual(typeof b, 'string'); if (typeof b === 'string') throw new Error(b);
  const m = blank('nova-backups-missing-key-'); mkdirSync(m.env.HOME, { mode: 0o700 }); ensureMark(m.home, { userHome: m.env.HOME });
  const nova = createNova(loadConfig({ ...m.env, NOVA_HOST: '127.0.0.1', NOVA_AGENT_CMD: '/bin/false', NOVA_AGENT_EGRESS: 'none' }));
  try {
    await new Promise<void>(r => nova.server.listen(0, '127.0.0.1', r)); m.base = `http://127.0.0.1:${(nova.server.address() as { port: number }).port}`;
    await finishSetup(m);
    // Fixture metadata emulates a previously shown but no longer retained key. The production
    // profile mutation API intentionally refuses this section; no broader access is added.
    nova.core.profile.set('backups', 'recovery_shown', 'public synthetic previously-shown fingerprint', 'settings');
    const d = await device(b, { serviceWorkers: 'block' }); const p = d.page; await p.goto(`${m.base}/`); await ready(p); await open(p);
    await p.locator('[data-action="backups-reveal"]').click();
    await p.getByLabel('I understand that the recovery key will be visible on this screen.').check(); await p.locator('[data-action="backups-confirm"]').click();
    await p.getByText('The recovery key is unavailable. Check the connection and try again from the console.', { exact: true }).waitFor();
    assert.equal(await p.locator('#settings-backups code').count(), 0);
    assert.equal((await m.send('POST', '/api/v1/backups/recovery-key', { confirm: true })).status, 409);
    assert.equal((await m.get('/api/v1/backups')).settings.encrypted_target, null);
    // Native role transition in this in-process synthetic node; no hub/device is contacted.
    const self = nova.core.mesh.devices.list()[0]!;
    nova.core.mesh.role.demote({ ...self, id: 'synthetic-next-hub', name: 'Synthetic next hub' }, 2, 'http://127.0.0.1:1');
    await p.waitForFunction(() => document.querySelector<HTMLInputElement>('#settings-backups [name="target"]')?.disabled === true);
    const status = await m.get('/api/v1/mesh/status'); assert.ok(status.replica); assert.equal(status.you.console, true);
    assert.equal(await p.locator('[data-action="backups-save"], [data-action="backups-reveal"]').count(), 0);
    const response = await m.send('PUT', '/api/v1/backups/settings', { keep: 8 }); assert.notEqual(response.status, 200);
  } finally {
    await b.close(); nova.scheduler.stop(); nova.server.closeAllConnections();
    if (nova.server.listening) await new Promise<void>(r => nova.server.close(() => r()));
    await nova.core.close(); rmSync(m.dir, { recursive: true, force: true });
  }
});
