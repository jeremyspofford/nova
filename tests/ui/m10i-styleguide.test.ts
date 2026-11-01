import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { stop } from '../acceptance/support.ts';
import { browser, device } from './support.ts';
import { seeded } from './m9-support.ts';

test('M10i: topology has a named styleguide entry and semantic machine controls', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const { m, nova } = await seeded('nova-m10i-styleguide-');
  try {
    const d = await device(b, { width: 1440, height: 900, serviceWorkers: 'block' });
    await d.page.goto(`${m.base}/styleguide?entry=topology`);
    await d.page.locator('#sg-ds').waitFor();
    assert.equal(await d.page.getByRole('heading', { name: 'Topology', exact: true }).count(), 1, 'missing named topology entry');
    assert.equal(await d.page.locator('#sg-topology button[data-topology-machine]').count(), 3);
    assert.deepEqual(d.errors, []);
  } finally {
    await b.close();
    await stop(nova);
    rmSync(m.dir, { recursive: true, force: true });
  }
});

// Removing escaping, dropping a source reason, using desktop geometry on a phone, or wiring
// a specimen to a live mutation must fail this gate.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, webkitBrowser, still } from './support.ts';
import type { Page } from 'playwright-core';

const SIZES = {
  desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844, touch: true },
  tablet: { width: 820, height: 1180, touch: true }, halfopen: { width: 1100, height: 900, touch: true },
};
const STATES = ['overview', 'attention', 'attention-service', 'machine', 'service', 'capture', 'empty', 'loading', 'failed', 'long-names', 'approval-service', 'approval-capture', 'rollback-service', 'rollback-capture'];

async function noOverflow(page: Page, label: string) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: page overflow`);
  assert.deepEqual(await page.locator('#sg-topology').evaluate((root) => [...root.querySelectorAll<HTMLElement>('button, .topology-name, .topology-meta, dd, .sheet-line')].filter((el) => el.clientWidth && el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent)), [], `${label}: clipped text`);
}

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`M10i: ${engine} all packages, postures, states and safe local navigation`, { timeout: 300_000 }, async (t) => {
    const b = await launch();
    if (typeof b === 'string') return t.skip(b);
    const { m, nova } = await seeded(`nova-m10i-${engine}-`);
    const out = join(ROOT, 'docs/screenshots/m10i-styleguide', engine);
    if (process.env.NOVA_UI_SHOTS) mkdirSync(out, { recursive: true });
    try {
      for (const [size, dimensions] of Object.entries(SIZES)) {
        const d = await device(b, { ...dimensions, scheme: 'dark', serviceWorkers: 'block' });
        const p = d.page;
        const mutations: string[] = [];
        p.on('request', (r) => { if (!['GET', 'HEAD'].includes(r.method())) mutations.push(`${r.method()} ${r.url()}`); });
        await p.goto(`${m.base}/styleguide?entry=topology`);
        await p.locator('#sg-topology [data-topology-state="overview"]').waitFor();
        await p.locator('#sg-ds option').first().waitFor({ state: 'attached' });
        const packages = await p.locator('#sg-ds option').evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value));
        assert.equal(packages.length, 6, 'all installed starter packages are covered');
        for (const pkg of packages) {
          if (!['phone', 'desktop'].includes(size) && pkg !== 'orb-teal') continue;
          const response = p.waitForResponse((r) => r.url().includes('/preview.css') && r.status() === 200);
          await p.locator('#sg-ds').selectOption(pkg);
          const stylesheet = await (await response).text();
          await p.waitForFunction((css) => document.getElementById('ds')?.textContent === css && !document.getElementById('ds-boot'), stylesheet);
          await p.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
          await still(p);
          for (const state of STATES) {
            await p.locator('#topology-state').selectOption(state);
            await p.locator(`[data-topology-state="${state}"]`).waitFor();
            assert.equal(await p.locator('.sg-broken').count(), 0);
            await noOverflow(p, `${pkg}/${size}/${state}`);
            if (state === 'overview') {
              assert.equal(await p.locator('[data-topology-machine]').count(), 3);
              assert.equal(await p.locator('.topology-connections').isVisible(), size !== 'phone');
              assert.equal(await p.locator('.topology-machines').evaluate((e) => e.tagName), 'OL');
            }
            if (state === 'attention' || state === 'attention-service') {
              const text = await p.locator('.topology').innerText();
              assert.match(text, /Needs you/);
              assert.match(text, /Cluster: worker is ready/);
              assert.match(text, /Heartbeat: no response/);
              assert.match(text, /18 minutes old/);
              assert.equal(await p.locator('.topology [data-status="verified"]').count(), 0);
            }
            if (state.includes('approval') || state.includes('rollback')) {
              const capture = state.includes('capture');
              assert.equal(await p.locator('.approval-sheet').getAttribute('data-tier'), capture ? '3' : '2');
              assert.equal(await p.locator('[data-action="approve"]').isDisabled(), capture);
            }
            if (state === 'failed') {
              assert.match(await p.locator('.topology').innerText(), /last observation is 18 minutes old/i);
              assert.equal(await p.locator('.topology [data-status="failed"]').count(), 0, 'refresh failure does not claim Nova stopped');
            }
            // Opening detail must not turn an old heartbeat into a fresh healthy service.
            if (state === 'attention' || state === 'failed') {
              if (state === 'failed') await p.locator('[data-topology-return]').click();
              await p.locator('[data-topology-service="capture"]').click();
              const detail = p.locator('.topology');
              assert.match(await detail.innerText(), /18 minutes old/, `${state}: service retains the supplied age`);
              assert.match(await detail.innerText(), /Cluster: worker is ready/);
              assert.match(await detail.innerText(), /Heartbeat: no response/);
              assert.match(await detail.innerText(), /Current service health is unknown/);
              assert.equal(await detail.locator('[data-status="needs-you"]').count(), 1);
              assert.equal(await detail.locator('[data-status="quiet"]').count(), 0, 'old service status cannot imply fresh health');
              assert.match(await detail.locator('.topology-versions').innerText(), /Previously reported: Serving on this machine/);
              assert.equal(await detail.getByText('Serving on this machine', { exact: true }).count(), 0);
              await noOverflow(p, `${pkg}/${size}/${state}/service`);
              await p.locator('#topology-state').selectOption(state);
            }
            if (process.env.NOVA_UI_SHOTS && pkg === 'orb-teal') {
              await p.screenshot({ path: join(out, `${state}-${size}.png`), fullPage: true, animations: 'disabled', caret: 'hide' });
              if (engine === 'chromium' && ['desktop', 'phone'].includes(size) && ['overview', 'machine', 'service', 'attention-service'].includes(state)) await p.locator('.topology').screenshot({ path: join(out, `specimen-${state}-${size}.png`), animations: 'disabled', caret: 'hide' });
            }
          }
        }
        await p.locator('#topology-state').selectOption('long-names');
        await p.locator('[data-topology-machine="home"]').click();
        await noOverflow(p, `${engine}/${size}/long-services`);
        assert.match(await p.locator('[data-topology-service="notes"]').innerText(), /shared reference library/);
        await p.locator('[data-topology-service="notes"]').click();
        await noOverflow(p, `${engine}/${size}/long-versions`);
        // Keyboard activation goes into services, then versions; Back restores the originating control.
        await p.locator('#topology-state').selectOption('overview');
        const hub = p.locator('[data-topology-machine="home"]');
        await p.locator('#topology-state').focus();
        await p.keyboard.press('Tab');
        assert.equal(await hub.evaluate((e) => e === document.activeElement), true, 'Tab reaches the first machine');
        assert.notEqual(await hub.evaluate((e) => getComputedStyle(e).outlineStyle), 'none');
        await p.keyboard.press('Enter');
        await p.locator('[data-topology-service="notes"]').waitFor();
        await p.keyboard.press('Tab'); // from focused heading, the first row is next
        assert.equal(await p.locator('[data-topology-service="notes"]').evaluate((e) => e === document.activeElement), true, 'Tab reaches the first service');
        await p.keyboard.press('Enter');
        await p.locator('[data-topology-action="promote"]').click();
        await p.locator('.approval-sheet[data-tier="2"]').waitFor();
        await p.locator('[data-action="approve"]').click();
        assert.match(await p.locator('[data-topology-notice]').innerText(), /No change was made/);
        await p.locator('[data-topology-back]').click();
        await p.locator('[data-topology-action="rollback"]').click();
        assert.match(await p.locator('.sheet-title').innerText(), /Roll back/);
        await p.locator('[data-action="close-sheet"]').click();
        await p.locator('[data-topology-back]').click();
        assert.equal(await p.locator('[data-topology-service="notes"]').evaluate((e) => e === document.activeElement), true);
        await p.locator('[data-topology-back]').click();
        assert.equal(await hub.evaluate((e) => e === document.activeElement), true);
        await p.locator('#topology-state').selectOption('capture');
        await p.locator('[data-topology-action="promote"]').click();
        assert.equal(await p.locator('[data-action="approve"]').isDisabled(), true);
        await p.locator('[name="confirm"]').check();
        assert.equal(await p.locator('[data-action="approve"]').isEnabled(), true);
        await p.locator('[data-action="approve"]').click();
        assert.match(await p.locator('[data-topology-notice]').innerText(), /No change was made/);
        assert.deepEqual(mutations, [], 'demonstrations make no mutation requests');
        assert.deepEqual(d.errors, [], `${engine}/${size} browser errors`);
        await d.ctx.close();
      }
    } finally {
      await b.close(); await stop(nova); rmSync(m.dir, { recursive: true, force: true });
    }
  });
}

test('M10i: renderer escapes all display strings and identifiers, without mutating its input', async () => {
  const path = '../../ui/js/topology-view.js';
  const { renderTopology } = await import(path);
  const attack = '<img src=x onerror="window.injected=1">';
  const machine = { id: attack, name: attack, roles: [attack], status: 'needs-you', age: attack, observations: [{ source: attack, reason: attack, age: attack }], services: [{ id: attack, name: attack, status: 'quiet', placement: attack, capture: false, versions: [{ name: attack, role: attack, detail: attack }] }] };
  const input = { machines: [machine], selectedMachine: attack, selectedService: attack, state: 'service' };
  const before = JSON.stringify(input);
  for (const args of [input, { ...input, selectedService: null }, { ...input, selectedMachine: null, selectedService: null }]) {
    const html = renderTopology(args);
    assert.ok(!html.includes('<img'), 'untrusted strings cannot create markup');
    assert.match(html, /&lt;img/);
    assert.ok(!html.includes('data-topology-machine="<'));
    assert.equal(renderTopology(args), html, 'rendering is deterministic');
  }
  assert.equal(JSON.stringify(input), before);
});

test('M10i: failed refresh retains the supplied age rather than inventing freshness', async () => {
  const path = '../../ui/js/topology-view.js';
  const { renderTopology } = await import(path);
  const html = renderTopology({ machines: [{ id: 'home', name: 'Home hub', age: 'Last observation is 47 minutes old', services: [] }], state: 'failed' });
  assert.match(html, /47 minutes old/);
  assert.ok(!html.includes('18 minutes'));
  assert.match(renderTopology({ machines: [], state: 'failed' }), /No earlier observation is available/);
});
