// Every actual app view needs a visible safe door in both arrangements. A newly registered
// view extends the independent app.js oracle automatically; DESTINATIONS is never the oracle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Page } from 'playwright-core';
import { registeredViews, missingViews } from '../support/navigation-registry.js';
import { routeOf } from '../../ui/js/nav.js';
import { stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup } from './support.ts';
import { drawn, press, trackDocument, assertRetainedDocument, documentRequests, type Door, type Step } from './navigation-support.ts';

type ControlEvidence = { tag: string; id: string; text: string; ariaLabel: string | null; action: string | null; form: string | null; name: string | null; type: string | null };
type CrawlState = { path: string; view: string; steps: Step[]; sections: string[]; links: Door[]; headings: string[]; controls: ControlEvidence[] };
type Report = {
  layout: string; registered: string[]; reached: Record<string, Step[]>; states: CrawlState[];
  doors: Record<string, Door[]>; required: { homeTopology: boolean; devicesTopology: boolean; captureCategory: boolean; backupControls: boolean; healthCosts: boolean; healthDiagnostics: boolean };
  requiredPaths: Record<string, Step[]>; forbidden: string[]; documentRequests?: string[]; healthMesh?: boolean; attempting?: Step[]; missing?: string[]; error?: string;
};
const at = (page: Page) => new URL(page.url()).pathname + new URL(page.url()).hash;

async function doors(page: Page): Promise<Door[]> {
  const found = await page.locator('a[href]').evaluateAll(links => links.filter(a => {
    const el = a as HTMLAnchorElement;
    return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && !el.closest('[inert], [aria-hidden="true"], form') && !el.hasAttribute('download') && el.target !== '_blank' && el.origin === location.origin;
  }).map(a => ({ href: a.getAttribute('href')!, label: (a.textContent ?? '').replace(/\s+/g, ' ').trim() || a.getAttribute('aria-label') || '', section: a.closest('[id]')?.id ?? '' })));
  return found.filter(d => !routeOf(new URL(d.href, page.url()).pathname).unknown && !d.href.startsWith('#'));
}

for (const [layout, width, touch] of [['phone', 390, true], ['rail', 1440, false]] as const) {
  test(`navigation reachability and required homes: ${layout}`, { timeout: 180_000 }, async () => {
    const b = await browser();
    assert.notEqual(typeof b, 'string', 'The reachability gate requires a real browser');
    if (typeof b === 'string') throw new Error(b);
    const m = blank(`nova-navigation-${layout}-`);
    const nova = await m.start({ NOVA_AGENT_CMD: 'node scripts/fake-agent.js', NOVA_AGENT_EGRESS: 'none' });
    const report: Report = { layout, registered: registeredViews(), reached: {}, states: [], doors: {}, required: { homeTopology: false, devicesTopology: false, captureCategory: false, backupControls: false, healthCosts: false, healthDiagnostics: false }, requiredPaths: {}, forbidden: [] };
    const output = process.env.NOVA_NAV_EVIDENCE ?? (process.env.NOVA_UI_SHOTS ? join(process.env.NOVA_UI_SHOTS, 'navigation') : null);
    const evidence = output ? resolve(output) : null;
    let crawlPage: Page | undefined;
    if (evidence) mkdirSync(evidence, { recursive: true });
    try {
      await finishSetup(m);
      const backupTarget = join(m.dir, 'backups');
      const encryptedTarget = join(m.dir, 'encrypted');
      mkdirSync(backupTarget, { mode: 0o700 }); mkdirSync(encryptedTarget, { mode: 0o700 });
      assert.equal((await m.send('PUT', '/api/v1/backups/settings', { target: backupTarget, encrypted_target: encryptedTarget })).status, 200);
      // One neutral conversation supplies a finite representative of the /c/:id family.
      writeFileSync(join(m.home, 'sessions', '2026-11-02-nav001.jsonl'), [
        { ts: '2026-11-02T12:00:00Z', type: 'session', id: '2026-11-02-nav001', title: 'Navigation example', v: 1 },
        // A historical report exercises the real renderer's /schedules alias link without
        // starting or creating scheduled work. Its former schedule need not still be kept.
        { ts: '2026-11-02T12:01:00Z', type: 'handoff', id: 'navigation-report', name: 'Navigation schedule', schedule: 'navigation-example', text: 'A synthetic completed report.', ok: true },
      ].map(event => JSON.stringify(event)).join('\n') + '\n');
      const d = await device(b, { width, height: 900, touch, serviceWorkers: 'block' });
      await d.ctx.route('**/*', async route => {
        const req = route.request();
        if (new URL(req.url()).origin !== m.base || req.method() !== 'GET') {
          report.forbidden.push(`${req.method()} ${req.url()}`); await route.abort();
        } else await route.continue();
      });
      const page = d.page;
      crawlPage = page;
      trackDocument(page);
      await page.goto(`${m.base}/`); // The sole document navigation per layout.
      await drawn(page);
      await page.waitForSelector('#toc a[href="/c/2026-11-02-nav001"]', { state: 'attached' });
      report.healthMesh = await page.evaluate(async () => { const { store } = await import(String('/js/surfaces.js')); return !!store.health.checks.mesh; });
      report.required.homeTopology = await page.locator('#home .device-mesh-card a[href="/topology"], #aside .device-mesh-card a[href="/topology"]').filter({ visible: true }).count() === 1 && await page.locator('#home .device-mesh-card a[href="/topology"], #aside .device-mesh-card a[href="/topology"]').filter({ visible: true }).innerText() === 'Machines and services';
      if (evidence) {
        await page.screenshot({ path: join(evidence, `${layout}-home.png`), fullPage: true });
        const card = page.locator('#home .device-mesh-card, #aside .device-mesh-card').filter({ visible: true }).first();
        await card.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(evidence, `${layout}-home-devices.png`), fullPage: true });
      }
      const queue: Step[][] = [[]];
      const seen = new Set<string>();
      const queued = new Set<string>(['/']);
      const buttons = new Set<string>();
      async function home() {
        if (await page.locator('#drawer-close').isVisible()) await press(page, { button: '#drawer-close', label: 'Close conversations' }, touch);
        // A phone's Home is a row in the navigation drawer: open it when Home isn't on screen.
        if (!await page.locator('a[href="/"]').filter({ visible: true }).count()) await press(page, { button: '#nav-menu', label: 'Navigation' }, touch);
        // The phone's open More sheet covers its trigger. Leave through a real visible link.
        if (await page.locator('#more').isVisible()) {
          const exit = page.locator('#more a').first();
          await press(page, { href: (await exit.getAttribute('href'))!, label: 'Leave More', section: 'more' }, touch);
        }
        await press(page, { href: '/', label: 'Home', section: '' }, touch);
      }
      let current: Step[] = [];
      while (queue.length) {
        const path = queue.shift()!;
        if (current.length || at(page) !== '/') await home();
        report.attempting = path;
        for (const step of path) await press(page, step, touch);
        current = path;
        const key = at(page) + (await page.locator('#more').isVisible() ? '|More' : '') + (await page.locator('#sidebar').isVisible() ? '|Conversations' : '') + (await page.locator('.app.nav-open').count() ? '|Navigation' : '');
        if (seen.has(key)) continue;
        seen.add(key);
        const view = await page.getAttribute('body', 'data-view');
        assert.ok(view, 'rendered route identifies its active view');
        report.reached[view] ??= path;
        const links = await doors(page);
        const sections = await page.locator('#settings-view .settings-pane:not([hidden]) [id]').evaluateAll(es => es.filter(e => (e as HTMLElement).checkVisibility()).map(e => e.id));
        const headings = await page.locator('h1, h2, h3, h4').evaluateAll(es => es.filter(e => (e as HTMLElement).checkVisibility()).map(e => e.textContent?.trim() ?? ''));
        // Metadata only: never input values, saved credentials, capture contents or user text.
        const controls = await page.locator('a[href], button, input, select, textarea, summary, form').evaluateAll(es => es.filter(e => (e as HTMLElement).checkVisibility()).map(e => ({
          tag: e.tagName.toLowerCase(), id: e.id,
          text: e.matches('a, button, summary') ? (e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 180) : '',
          ariaLabel: e.getAttribute('aria-label'), action: e.getAttribute('data-action'),
          form: e.getAttribute('data-form'), name: e.getAttribute('name'), type: e.getAttribute('type'),
        })));
        report.states.push({ path: key, view, steps: path, sections, links, headings, controls });
        report.doors[key] = links;
        if (view === 'health') {
          // Inspect the surface reached through the ordinary Home crawl, without saving or
          // downloading here. Native attachment behavior belongs to the dedicated UI gate.
          await page.locator('[data-work-costs-state="ready"]').waitFor();
          const form = page.locator('[data-work-limits]');
          report.required.healthCosts = await form.locator('input[type="number"]').count() === 6
            && await form.locator('input[type="checkbox"]').count() === 6
            && /Month to date/i.test(await page.locator('.work-costs').innerText())
            && await form.locator('[data-save-work-limits]').isEnabled();
          const download = page.locator('[data-download-diagnostics]');
          report.required.healthDiagnostics = await download.isVisible()
            && await download.getAttribute('href') === '/api/v1/diagnostics'
            && await download.getAttribute('download') === '';
          report.requiredPaths.healthCosts = path;
          report.requiredPaths.healthDiagnostics = path;
          if (evidence) await page.screenshot({ path: join(evidence, `${layout}-health-costs-diagnostics.png`), fullPage: true });
        }
        if (view === 'settings') {
          if (key === '/settings' && evidence) {
            const captureEntry = page.locator('#settings-nav a[data-cat="capture"]');
            if (await captureEntry.isVisible()) await captureEntry.scrollIntoViewIfNeeded();
            await page.screenshot({ path: join(evidence, `${layout}-settings-list.png`), fullPage: true });
          }
          const capture = page.locator('#settings-nav a[data-cat="capture"][href="/settings#capture"]');
          if (await capture.isVisible()) report.required.captureCategory = true;
          if (key.startsWith('/settings#devices')) {
            report.required.devicesTopology = links.some(l => l.href === '/topology' && l.label === 'Machines and services');
            if (evidence) await page.screenshot({ path: join(evidence, `${layout}-settings-devices.png`), fullPage: true });
          }
          if (key === '/settings#backups') {
            const backup = page.locator('#settings-backups');
            report.required.backupControls = await backup.locator('input[name="target"], input[name="keep"], input[name="encrypted_target"]').count() === 3
              && await backup.locator('input:disabled').count() === 0
              && await backup.locator('[data-action="backups-save"], [data-action="backups-reveal"]').count() === 2;
            assert.equal(await page.evaluate(async () => (await import(String('/js/surfaces.js'))).store.mesh?.you?.console), true, 'reveal affordance uses actual console principal');
            assert.equal(await backup.locator('code').count(), 0, 'crawl never reveals a key');
            report.requiredPaths.backupControls = path;
            if (evidence) await page.screenshot({ path: join(evidence, `${layout}-settings-backups.png`), fullPage: true });
          }
          if (key.startsWith('/settings#capture') && evidence) await page.screenshot({ path: join(evidence, `${layout}-settings-capture.png`), fullPage: true });
        }
        for (const link of links) {
          const url = new URL(link.href, m.base);
          const target = url.pathname + url.hash;
          if (!queued.has(target)) { queued.add(target); queue.push([...path, link]); }
        }
        for (const [selector, label] of [['#more-btn[aria-expanded="false"]', 'More'], ['#nav-menu[aria-expanded="false"]', 'Navigation'], ['#menu', 'Conversations'], ['#nav-all', 'All conversations'], ['#new-chat', 'New conversation']] as const) {
          // Behind an open drawer the page is inert: its buttons aren't doors from here.
          if (!buttons.has(selector) && await page.locator(selector).isVisible() && !await page.locator(selector).evaluate((e) => !!e.closest('[inert]'))) { buttons.add(selector); queue.push([...path, { button: selector, label }]); }
        }
        assert.ok(seen.size < 120, 'Safe crawl must stay bounded');
      }
      // Check the specified homes independently, including the actual click from each home.
      // Merely reaching Topology through Health or Services cannot satisfy these contracts.
      const topologyDoor = report.states.find(s => s.path === '/')?.links.find(l => l.href === '/topology');
      if (report.required.homeTopology && topologyDoor) {
        await home();
        await press(page, topologyDoor, touch);
        assert.equal(await page.getAttribute('body', 'data-view'), 'topology');
        report.requiredPaths.homeTopology = [topologyDoor];
      }
      const devices = report.states.find(s => s.path === '/settings#devices');
      if (report.required.devicesTopology && devices) {
        await home();
        for (const step of devices.steps) await press(page, step, touch);
        const door = devices.links.find(l => l.href === '/topology')!;
        await press(page, door, touch);
        assert.equal(await page.getAttribute('body', 'data-view'), 'topology');
        report.requiredPaths.devicesTopology = [...devices.steps, door];
      }
      const settings = report.states.find(s => s.path === '/settings');
      if (report.required.captureCategory && settings) {
        await home();
        for (const step of settings.steps) await press(page, step, touch);
        const category: Door = { href: '/settings#capture', label: 'Capture', section: 'settings-nav' };
        await press(page, category, touch);
        assert.ok(await page.locator('#settings-capture #capture').isVisible(), 'Capture category opens its existing settings section');
        const openCapture: Door = { href: '/capture', label: 'Open Capture', section: 'capture' };
        await press(page, openCapture, touch);
        assert.equal(await page.getAttribute('body', 'data-view'), 'capture');
        report.requiredPaths.captureCategory = [...settings.steps, category, openCapture];
      }
      report.missing = missingViews(report.registered, Object.keys(report.reached));
      console.log(`NAVIGATION ${layout}: registered=${report.registered.length} reached=${Object.keys(report.reached).length} missing=${JSON.stringify(report.missing)} required=${JSON.stringify(report.required)} states=${report.states.length}`);
      assert.deepEqual(report.forbidden, [], 'crawl never submits or leaves the isolated app');
      assert.deepEqual(d.errors, [], 'no browser errors');
      await assertRetainedDocument(page);
      console.log(`DOCUMENT ${layout}: main-document requests=${documentRequests(page).length}`);
      for (const family of ['/new', '/c/2026-11-02-nav001', '/schedules#sc-navigation-example']) assert.ok(report.states.some(s => s.path === family), `actual conversation family: ${family}`);
      assert.deepEqual(report.missing, [], 'every production registered view has a rendered door');
      assert.deepEqual(report.required, { homeTopology: true, captureCategory: true, devicesTopology: true, backupControls: true, healthCosts: true, healthDiagnostics: true }, 'required ordinary Home and Settings doors');
      assert.equal(readFileSync(m.egress, 'utf8'), '', 'no external Core egress');
    } catch (error) {
      report.error = String(error); console.log(`NAVIGATION FAILED ${layout}: ${report.error}`); throw error;
    } finally {
      if (crawlPage) report.documentRequests = documentRequests(crawlPage);
      if (evidence) writeFileSync(join(evidence, `${layout}-report.json`), JSON.stringify(report, null, 2));
      await b.close(); await stop(nova); rmSync(m.dir, { recursive: true, force: true });
    }
  });
}
