// Removing Home doors, live Caps freshness, validation, retained edits or native download must fail.
// Production createNova, real Caps/profile/routes; private homes and fake local runtime only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Browser, Page } from 'playwright-core';
import type { RequestListener } from 'node:http';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { MARKER } from '../../src/core/diagnostics/index.ts';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { hubHardware } from '../support/models.ts';
import { blank, browser, webkitBrowser, device, finishSetup, still, until } from './support.ts';
import { drawn, trackDocument, documentRequests } from './navigation-support.ts';
import { diagnosticsPaint } from './health-diagnostics-visual.ts';

const require = createRequire(import.meta.url);
// createNova reads package.json: the diagnostics name its version.
const VERSION: string = require('../../package.json').version;
const axe = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const names = ['task.iterations', 'task.tokens', 'task.usd', 'day.iterations', 'day.tokens', 'day.usd'];
const values = ['31', '4100', '0.75', '62', '8200', '1.50'];
const canaries = ['synthetic-private-memory-health-a672', 'synthetic-private-chat-health-b593', 'synthetic-secret-health-c184+/='];
const files = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter(d => d.isFile()).map(d => join(d.parentPath, d.name)).sort();
async function healthFromHome(p: Page, touch: boolean) {
  const door = p.locator('#home a[href="/health"], #aside a[href="/health"]').filter({ visible: true }).first();
  assert.ok(await door.isVisible(), 'Home has a visible Health door');
  if (touch) await door.tap(); else await door.click();
  await drawn(p);
  assert.equal(new URL(p.url()).pathname, '/health');
  await p.locator('[data-work-costs-state="ready"]').waitFor({ timeout: 3000 });
  assert.equal(await p.locator('[data-work-limits] input[type="number"]').count(), 6);
  assert.match(await p.locator('.work-costs').innerText(), /Month to date/i);
  assert.equal(await p.locator('[data-download-diagnostics]').getAttribute('href'), '/api/v1/diagnostics');
}

// Include the actual outer panels: the WCAG-tag component scan alone misses duplicate landmarks.
async function healthLandmarks(p: Page, label: string) {
  const violations = await p.evaluate(async () => (await (window as any).axe.run({ include: ['#health-view'] }, { runOnly: { type: 'rule', values: ['landmark-unique'] } })).violations.map((v: any) => ({ id: v.id, targets: v.nodes.map((n: any) => n.target) })));
  console.log(`HEALTH LANDMARK ${label} ${JSON.stringify(violations)}`);
  assert.deepEqual(violations, [], 'actual Health has no duplicate named landmarks');
  for (const name of ['Work costs', 'Diagnostics']) assert.equal(await p.getByRole('region', { name, exact: true }).count(), 1, `one named region for ${name}`);
  const duplicateIds = await p.evaluate(() => {
    const panels = ['#h-work-costs', '#h-diagnostics'].map(id => document.querySelector(id)!.parentElement!);
    return panels.flatMap(panel => [...panel.querySelectorAll('[id]')].map(e => e.id)).filter(id => document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length !== 1);
  });
  assert.deepEqual(duplicateIds, [], 'all new-surface IDs are unique in the actual document');
}

// A real installed-worker upgrade, with only the old static worker response pinned. All API
// replies and the download still come from production createNova and its private fixture stores.
async function diagnosticsWorkerUpgrade(b: Browser, m: ReturnType<typeof blank>, nova: ReturnType<typeof createNova>) {
  const legacy = readFileSync(new URL('../support/fixtures/health-sw-v14.js.txt', import.meta.url), 'utf8');
  const current = readFileSync(new URL('../../ui/sw.js', import.meta.url), 'utf8');
  const oldVersion = /const VERSION = '([^']+)'/.exec(legacy)![1]!;
  const newVersion = /const VERSION = '([^']+)'/.exec(current)![1]!;
  const normal = nova.server.listeners('request')[0] as RequestListener;
  let serveLegacy = true;
  const serve: RequestListener = (req, res) => {
    if (req.url?.startsWith('/sw.js')) console.log(`HEALTH SW script request ${req.url}; legacy=${serveLegacy}`);
    if (serveLegacy && req.url === '/sw.js') { res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' }); res.end(legacy); }
    else normal.call(nova.server, req, res);
  };
  nova.server.removeListener('request', normal); nova.server.on('request', serve);
  const d = await device(b, { width: 390, height: 844, touch: true, serviceWorkers: 'allow' });
  const p = d.page;
  const pageErrors: string[] = []; p.on('pageerror', error => pageErrors.push(error.message));
  const port = (nova.server.address() as AddressInfo).port; let stopped = false;
  try {
    trackDocument(p); await p.goto(`${m.base}/`); await drawn(p);
    await p.evaluate(() => navigator.serviceWorker.ready);
    await p.waitForFunction(() => !!navigator.serviceWorker.controller);
    const initialWorkers = await Promise.all(d.ctx.serviceWorkers().map(w => w.evaluate('VERSION')));
    assert.deepEqual(initialWorkers, [oldVersion], 'the real pre-change worker is installed before seeding its owned cache');
    console.log('HEALTH initial installed worker versions', initialWorkers);
    await p.evaluate(async (version) => {
      const cache = await caches.open(version);
      for (const path of ['/api/v1/diagnostics', '/api/v1/diagnostics?example=1']) await cache.put(path, new Response('{"example":"synthetic-legacy-diagnostic-cache"}', { headers: { 'content-type': 'application/json' } }));
    }, oldVersion);
    assert.ok(await p.evaluate(async version => !!(await (await caches.open(version)).match('/api/v1/diagnostics')), oldVersion), 'legacy owned cache actually contains the synthetic diagnostic entry');
    await p.evaluate(async () => { const unrelated = await caches.open('other-app-public-example'); await unrelated.put('/unrelated-public-example', new Response('synthetic-unrelated-cache-sentinel')); });
    assert.notEqual(newVersion, oldVersion, 'diagnostics privacy policy migrates the installed owned cache');
    serveLegacy = false;
    await p.evaluate(async () => {
      const registration = (await navigator.serviceWorker.getRegistration())!;
      const previous = registration.active;
      const changed = new Promise<void>(resolve => {
        const check = () => { if (registration.active && registration.active !== previous && registration.active.state === 'activated' && navigator.serviceWorker.controller === registration.active) resolve(); };
        const installing = () => { registration.installing?.addEventListener('statechange', check); check(); };
        registration.addEventListener('updatefound', installing);
        navigator.serviceWorker.addEventListener('controllerchange', check);
        installing();
      });
      await registration.update(); await changed;
    });
    await until(p, async ({ oldVersion, newVersion }) => { const keys = await caches.keys(); return keys.includes(newVersion) && !keys.includes(oldVersion); }, { oldVersion, newVersion });
    assert.equal(await p.evaluate(() => caches.has('other-app-public-example')), true, 'worker upgrade preserves an unrelated cache');
    assert.equal(await p.evaluate(async () => (await (await caches.open('other-app-public-example')).match('/unrelated-public-example'))!.text()), 'synthetic-unrelated-cache-sentinel');
    await healthFromHome(p, true);
    const before = files(m.home);
    const downloading = p.waitForEvent('download'); await p.locator('[data-download-diagnostics]').tap();
    const downloaded = JSON.parse(readFileSync((await (await downloading).path())!, 'utf8'));
    assert.equal(downloaded.about.nova, VERSION); assert.equal(downloaded.redaction.marker, MARKER);
    assert.deepEqual(files(m.home), before, 'installed-worker native download leaves no server bundle');
    for (const path of ['/api/v1/diagnostics', '/api/v1/diagnostics?example=1']) {
      const response = await p.evaluate(async path => { const r = await fetch(path); const body = await r.json(); return { status: r.status, cache: r.headers.get('cache-control'), nova: body.about.nova }; }, path);
      assert.equal(response.status, 200); assert.match(response.cache!, /no-store/); assert.equal(response.nova, VERSION);
    }
    // A later positive cache write is the barrier: the policy must still retain an eligible
    // ordinary API answer, without retaining any prior diagnostics response/query variant.
    await p.evaluate(async () => { const r = await fetch('/api/v1/tasks?limit=100'); await r.json(); });
    await until(p, async () => !!(await caches.match('/api/v1/tasks?limit=100')));
    console.log('HEALTH upgraded worker versions', await Promise.all(d.ctx.serviceWorkers().map(w => w.evaluate('VERSION').catch(e => String(e)))));
    const finalCaches = await p.evaluate(() => caches.keys());
    assert.ok(!finalCaches.includes(oldVersion), 'legacy owned cache remains absent after the new worker serves diagnostics');
    console.log('HEALTH cache names before diagnostic assertion', finalCaches);
    assert.deepEqual(await p.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) for (const key of await (await caches.open(name)).keys()) if (new URL(key.url).pathname === '/api/v1/diagnostics') urls.push(key.url);
      return urls;
    }), [], 'current diagnostics and query variants never enter any browser cache');
    assert.deepEqual(d.errors, [], 'no browser errors before the intentional installed-worker outage');
    await new Promise<void>((resolve, reject) => { nova.server.close(error => error ? reject(error) : resolve()); nova.server.closeAllConnections(); });
    stopped = true;
    await d.ctx.setOffline(true);
    const cached = await p.evaluate(async () => { const r = await fetch('/api/v1/tasks?limit=100'); return { status: r.status, stale: r.headers.get('x-nova-offline'), body: await r.json() }; });
    assert.equal(cached.status, 200); assert.equal(cached.stale, '1'); assert.ok(Array.isArray(cached.body), 'ordinary cacheable API retains offline behavior');
    for (const path of ['/api/v1/diagnostics', '/api/v1/diagnostics?example=1']) {
      const denied = await p.evaluate(async path => { const r = await fetch(path); return { status: r.status, stale: r.headers.get('x-nova-offline'), text: await r.text() }; }, path);
      assert.equal(denied.status, 503); assert.equal(denied.stale, '1'); assert.ok(!denied.text.includes('synthetic-legacy-diagnostic-cache'));
    }
    assert.deepEqual(pageErrors, [], 'no JavaScript errors during the owned worker outage');
    console.log('HEALTH installed SW expected outage console messages', [...new Set(d.errors)]);
    console.log(`HEALTH installed SW ${oldVersion} → ${newVersion}: legacy owned diagnostic cache removed; native attachment; current/query responses never cached; diagnostics offline 503; ordinary tasks offline 200`);
  } finally {
    try { await d.ctx.close(); } finally {
      nova.server.removeListener('request', serve); nova.server.on('request', normal);
      if (stopped) await new Promise<void>(resolve => nova.server.listen(port, '127.0.0.1', resolve));
    }
  }
}

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`Health app: ${engine} Home spend refresh, save, freshness, SSE draft island and native diagnostics`, { timeout: 180_000 }, async () => {
    const b = await launch();
    if (typeof b === 'string') throw new Error(b);
    console.log(`HEALTH RUNTIME ${engine}=${b.version()} node=${process.version}`);
    const m = blank(`nova-health-app-${engine}-`);
    const previousHome = process.env.HOME;
    process.env.HOME = m.env.HOME;
    const runtime = await startFakeOllama({ models: [] });
    const nova = createNova(loadConfig({ ...m.env, NOVA_AGENT_CMD: 'unused-synthetic-agent', NOVA_AGENT_EGRESS: 'none', NOVA_TZ: 'UTC' }), { agent: async () => ({ text: 'Synthetic conversation completed.', aborted: false, usage: { tokens_in: 1200, tokens_out: 300, cost_usd: 0.125 } }), models: { ollamaUrl: runtime.url, hardware: async () => hubHardware(), watchMs: 100, wakePollMs: 50 } });
    await new Promise<void>(r => nova.server.listen(0, '127.0.0.1', r));
    m.base = `http://127.0.0.1:${(nova.server.address() as AddressInfo).port}`;
    const out = process.env.NOVA_HEALTH_APP_SHOTS ? join(process.env.NOVA_HEALTH_APP_SHOTS, engine) : null;
    if (out) mkdirSync(out, { recursive: true });
    try {
      await finishSetup(m);
      nova.core.memory.remember({ kind: 'fact', content: canaries[0]!, recorded_by: 'person' });
      nova.store.append('2026-11-03-abc123', { type: 'user', text: canaries[1] });
      nova.core.vault.put('provider/HEALTH_FIXTURE', canaries[2]!);
      nova.core.log.write('info', 'example', `Fixture key ${canaries[2]}`);
      for (const [posture, width, height, touch] of [['phone', 390, 844, true], ['desktop', 1440, 900, false], ['tablet', 820, 1180, true], ['halfopen', 842, 675, true]] as const) {
        const d = await device(b, { width, height, touch, scheme: 'dark', serviceWorkers: 'block' });
        await d.ctx.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
        if (posture === 'halfopen') await d.ctx.addInitScript(() => Object.defineProperty(navigator, 'devicePosture', { value: Object.assign(new EventTarget(), { type: 'folded' }) }));
        const p = d.page;
        await d.ctx.route('**/*', route => new URL(route.request().url()).origin === m.base ? route.continue() : route.abort());
        trackDocument(p);
        await p.goto(`${m.base}/`);
        await drawn(p);
        assert.equal(await p.evaluate(() => navigator.onLine), false, 'browser network hint is deliberately false while the actual local Core answers');
        assert.equal(await p.locator('#banner').isVisible(), false, 'live Core responses override the browser network hint');
        assert.notEqual(await p.locator('.status-icon[data-presence]').first().getAttribute('data-state'), 'offline', 'live Core is not shown as an offline orb');
        await healthFromHome(p, touch);
        await p.evaluate(axe);
        await healthLandmarks(p, `${engine}/${posture}/Home-entry`);
        // The build stamp: Health says which commit is running, and when it was built or started.
        const build = await m.get('/api/v1/version');
        await until(p, (w: string) => !!document.querySelector('[data-build-stamp]')?.textContent?.includes(w), build.words);
        assert.match(await p.locator('[data-build-stamp]').innerText(), build.built_at ? /Built \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\./ : /Started \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\./);
        // Conversation metering emits no Caps/profile/task event. Leaving and reopening Health
        // must read current usage, even in one visible document with an unsaved limits draft.
        const previousMonth = (await m.get('/api/v1/caps')).month;
        if (posture === 'phone') assert.equal(previousMonth.total.tokens_in, 0, 'startup has no usage');
        const draft = p.locator('[data-work-limits] [name="task.tokens"]');
        await p.locator('[name="task.tokens.unlimited"]').uncheck();
        await draft.fill('9876');
        // On a phone, Home is in the navigation drawer.
        const menu = p.locator('#nav-menu');
        if (await menu.isVisible()) { if (touch) await menu.tap(); else await menu.click(); }
        const home = p.locator('a[data-dest="home"]').filter({ visible: true }).first();
        if (touch) await home.tap(); else await home.click();
        await drawn(p);
        assert.equal(new URL(p.url()).pathname, '/');
        let conversationCapsReads = 0;
        const countCaps = (r: import('playwright-core').Request) => { if (r.url().endsWith('/api/v1/caps')) conversationCapsReads++; };
        p.on('request', countCaps);
        const session = nova.runner.createSession('Synthetic Health usage regression');
        await new Promise<void>((resolve, reject) => {
          const completed = (id: string, event: { type: string; message?: string }) => {
            if (id !== session || !['done', 'error'].includes(event.type)) return;
            nova.runner.off('event', completed);
            if (event.type === 'error') reject(new Error(event.message)); else resolve();
          };
          nova.runner.on('event', completed);
          nova.runner.send(session, 'Complete this benign synthetic conversation.');
        });
        const currentMonth = (await m.get('/api/v1/caps')).month;
        assert.equal(currentMonth.total.tokens_in, previousMonth.total.tokens_in + 1200);
        assert.equal(currentMonth.total.tokens_out, previousMonth.total.tokens_out + 300);
        assert.equal(currentMonth.total.usd, previousMonth.total.usd + 0.125);
        assert.equal(currentMonth.providers[0].provider, 'unused-synthetic-agent');
        assert.equal(conversationCapsReads, 0, 'conversation completion does not mask entry refresh');
        p.off('request', countCaps);
        await healthFromHome(p, touch);
        const expectedTokens = (currentMonth.total.tokens_in + currentMonth.total.tokens_out).toLocaleString('en-US');
        await p.waitForFunction(expected => document.querySelector('.work-cost-providers')?.textContent?.includes(expected), `${expectedTokens} tokens`, { timeout: 3000 });
        assert.match(await p.locator('.work-costs > .card-line').first().innerText(), new RegExp(`${expectedTokens} tokens`));
        assert.match(await p.locator('.work-costs > .card-lead').innerText(), new RegExp(String(currentMonth.total.usd)));
        assert.match(await p.locator('.work-cost-providers').innerText(), /unused-synthetic-agent · unused-synthetic-agent/);
        assert.equal(await draft.inputValue(), '9876', 'Health entry refresh preserves the unsaved limits draft');
        assert.equal(await p.evaluate(() => document.visibilityState), 'visible');
        assert.equal(documentRequests(p).length, 1, 'usage refreshed through Home in the same document');
        console.log(`HEALTH ENTRY ${engine}/${posture}: real conversation ${expectedTokens} tokens, $${currentMonth.total.usd}; actual Home return; draft retained; no reload/visibility/profile/save trigger`);
        if (posture === 'halfopen') assert.match((await p.locator('body').getAttribute('data-posture'))!, /^half-open-/);
        const form = p.locator('[data-work-limits]');
        for (let i = 0; i < names.length; i++) {
          await form.locator(`[name="${names[i]}.unlimited"]`).uncheck();
          await form.locator(`[name="${names[i]}"]`).fill(values[i]!);
        }
        await form.locator('[data-save-work-limits]').click();
        await p.locator('[data-work-costs-state="success"]').waitFor();
        let saved = await m.get('/api/v1/caps');
        assert.deepEqual(saved.limits, { task: { iterations: 31, tokens: 4100, usd: 0.75 }, day: { iterations: 62, tokens: 8200, usd: 1.5 } });
        await p.reload();
        await p.locator('[data-work-costs-state="ready"]').waitFor();
        if (posture === 'halfopen') assert.match((await p.locator('body').getAttribute('data-posture'))!, /^half-open-/);
        for (let i = 0; i < names.length; i++) assert.equal(Number(await form.locator(`[name="${names[i]}"]`).inputValue()), Number(values[i]));
        // A background read must keep loaded facts in place above the live form.
        await still(p);
        const formTop = await form.evaluate(e => e.getBoundingClientRect().top);
        let releaseFacts!: () => void;
        const factsHeld = new Promise<void>(r => { releaseFacts = r; });
        await p.route('**/api/v1/caps', async route => { await factsHeld; await route.continue(); });
        const factsRead = p.waitForRequest(r => r.url().endsWith('/api/v1/caps'));
        nova.core.profile.set('user', 'name', 'Fixture background facts', 'settings');
        await factsRead;
        assert.equal(await form.evaluate(e => e.getBoundingClientRect().top), formTop, 'background Caps read does not move form controls');
        assert.equal(await form.locator('[data-save-work-limits]').isEnabled(), true, 'a previously live view keeps its Save affordance during passive revalidation');
        const factsDone = p.waitForResponse(r => r.url().endsWith('/api/v1/caps'));
        releaseFacts(); await factsDone; await p.unroute('**/api/v1/caps');
        for (const name of names) await form.locator(`[name="${name}.unlimited"]`).check();
        await form.locator('[data-save-work-limits]').click();
        await p.locator('[data-work-costs-state="success"]').waitFor();
        assert.deepEqual((await m.get('/api/v1/caps')).limits, { task: { iterations: null, tokens: null, usd: null }, day: { iterations: null, tokens: null, usd: null } });
        for (let i = 0; i < names.length; i++) {
          await form.locator(`[name="${names[i]}.unlimited"]`).uncheck();
          assert.equal(Number(await form.locator(`[name="${names[i]}"]`).inputValue()), Number(values[i]), 'all six Unlimited toggles retain numeric drafts');
        }
        await form.locator('[data-save-work-limits]').click();
        await p.locator('[data-work-costs-state="success"]').waitFor();
        let puts = 0;
        p.on('request', r => { if (r.method() === 'PUT' && r.url().endsWith('/caps/limits')) puts++; });
        await form.evaluate(async form => {
          const { store } = await import(String('/js/surfaces.js'));
          (window as any).__limitEvents = [];
          for (const type of ['input', 'change', 'pointerdown', 'click', 'submit']) form.addEventListener(type, event => {
            const target = event.target as HTMLInputElement;
            const events = (window as any).__limitEvents;
            events.push({ type, target: target.name || target.tagName, value: target.value, fresh: store.capsState, mode: form.closest('.work-costs')?.getAttribute('data-work-costs-state'), disabled: form.querySelector<HTMLButtonElement>('[data-save-work-limits]')?.disabled });
            if (events.length > 50) events.shift();
          }, true);
        });
        if (posture === 'desktop') {
          const invalid = form.locator('[name="task.iterations"]'); await invalid.fill('0');
          let finishPointerRefresh!: () => void;
          const pointerHeld = new Promise<void>(resolve => { finishPointerRefresh = resolve; });
          await p.route('**/api/v1/caps', async route => { await pointerHeld; await route.continue(); });
          const save = form.locator('[data-save-work-limits]'); await save.scrollIntoViewIfNeeded();
          assert.equal(await save.isEnabled(), true, 'Save is live before the controlled pointer press');
          const bounds = (await save.boundingBox())!;
          await p.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await p.mouse.down();
          const pointerRefresh = p.waitForRequest(r => r.url().endsWith('/api/v1/caps'));
          const pointerResponse = p.waitForResponse(r => r.url().endsWith('/api/v1/caps'));
          nova.core.profile.set('user', 'name', 'Fixture refresh during Save press', 'settings'); await pointerRefresh;
          try {
            await p.mouse.up();
            console.log('HEALTH controlled Save pointer trace', await p.evaluate(() => (window as any).__limitEvents));
            assert.equal(await invalid.getAttribute('aria-invalid'), 'true', 'background revalidation cannot swallow a real Save press before validation');
            assert.equal(puts, 0, 'invalid press during revalidation sends no PUT');
          } finally { finishPointerRefresh(); await pointerResponse; await p.unrouteAll({ behavior: 'wait' }); }
          await invalid.fill('31');
        }
        const field = form.locator('[name="task.tokens"]');
        for (let i = 0; i < names.length; i++) {
          const input = form.locator(`[name="${names[i]}"]`);
          for (const invalid of ['', '0', '-1', '1e309', ...(names[i]!.endsWith('.usd') ? [] : ['1.5'])]) {
            await input.fill(invalid);
            await form.locator('[data-save-work-limits]').click();
            const invalidAttribute = await input.getAttribute('aria-invalid');
            if (invalidAttribute !== 'true') console.log('LIMIT VALIDATION TRACE', await p.evaluate(() => (window as any).__limitEvents), { name: names[i], expected: invalid, value: await input.inputValue(), mode: await p.locator('.work-costs').getAttribute('data-work-costs-state'), notice: await p.locator('[data-work-costs-notice]').textContent() });
            assert.equal(invalidAttribute, 'true', `${names[i]} invalid ${invalid}`);
            await input.dispatchEvent('change');
            assert.equal(await input.getAttribute('aria-invalid'), 'true', 'an unchanged trailing change event cannot erase validation');
            await input.fill(values[i]!);
          }
        }
        assert.equal(puts, 0, 'invalid entries never send a PUT');
        assert.deepEqual((await m.get('/api/v1/caps')).limits, saved.limits, 'invalid input cannot disable a cap');
        // Explicit Unlimited is the only null. Switching it back retains the prior numeric draft.
        await field.fill('4321');
        await form.locator('[name="task.tokens.unlimited"]').check();
        await form.locator('[data-save-work-limits]').click();
        await p.locator('[data-work-costs-state="success"]').waitFor();
        assert.equal((await m.get('/api/v1/caps')).limits.task.tokens, null);
        await form.locator('[name="task.tokens.unlimited"]').uncheck();
        assert.equal(await field.inputValue(), '4321');
        await field.fill('12');
        await field.focus();
        await p.keyboard.press('Home');
        await p.keyboard.press('ArrowRight');
        await field.evaluate(e => { (window as any).__healthField = e; (window as any).__healthBlur = 0; e.addEventListener('blur', () => { (window as any).__healthBlur++; }); });
        const caretRefresh = p.waitForResponse(r => r.url().endsWith('/api/v1/caps') && r.request().method() === 'GET');
        nova.core.profile.set('user', 'name', 'Fixture name refreshed', 'settings');
        await caretRefresh;
        await p.keyboard.insertText('3');
        assert.equal(await field.inputValue(), '132', 'native number input retains its caret across SSE');
        assert.equal(await field.evaluate(e => document.activeElement === e && e === (window as any).__healthField), true);
        assert.equal(await p.evaluate(() => (window as any).__healthBlur), 0, 'refresh never disconnects or blurs the editing island');
        await field.fill('1');
        await p.keyboard.press('End');
        await p.keyboard.insertText('e');
        assert.equal(await field.inputValue(), '', 'an unfinished exponent has an empty DOM value');
        const partialRefresh = p.waitForResponse(r => r.url().endsWith('/api/v1/caps') && r.request().method() === 'GET');
        nova.core.profile.set('user', 'name', 'Fixture partial exponent refreshed', 'settings');
        await partialRefresh;
        await p.keyboard.insertText('2');
        assert.equal(Number(await field.inputValue()), 100, 'native partial numeric buffer survives SSE without a value rewrite');
        assert.equal(await p.evaluate(() => (window as any).__healthBlur), 0);
        await field.fill('54321');
        // Delay a real PUT's response, edit during flight and reject duplicate submit.
        let release!: () => void;
        let arrived!: () => void;
        const entered = new Promise<void>(r => { arrived = r; });
        const held = new Promise<void>(r => { release = r; });
        await p.route('**/api/v1/caps/limits', async route => { const response = await route.fetch(); arrived(); await held; await route.fulfill({ response }); });
        const beforeSave = puts;
        await form.locator('[data-save-work-limits]').click();
        await entered;
        assert.equal(await form.locator('[data-save-work-limits]').isDisabled(), true);
        await field.fill('65432');
        await form.evaluate((e: HTMLFormElement) => e.requestSubmit());
        release();
        await p.locator('[data-work-costs-state="success"]').waitFor();
        assert.equal(puts, beforeSave + 1);
        assert.equal((await m.get('/api/v1/caps')).limits.task.tokens, 54321);
        assert.equal(await field.inputValue(), '65432', 'newer edits survive older save response');
        await p.unroute('**/api/v1/caps/limits');
        // Drain the real prior profile event through a live read before introducing a new
        // failure; an independently newer live response may legitimately restore freshness.
        const beforeLostRefresh = p.waitForResponse(r => r.url().endsWith('/api/v1/caps'));
        nova.core.profile.set('user', 'name', 'Fixture before lost PUT', 'settings');
        await beforeLostRefresh;
        await p.waitForFunction(() => !(document.querySelector('[data-save-work-limits]') as HTMLButtonElement)?.disabled);
        const beforeLostSave = (await m.get('/api/v1/caps')).limits;
        const lostPutRequests: string[] = [];
        p.on('requestfailed', r => { if (r.method() === 'PUT' && r.url().endsWith('/caps/limits')) lostPutRequests.push(r.failure()?.errorText ?? ''); });
        await p.route('**/api/v1/caps/limits', route => route.abort('connectionrefused'));
        // Every state the panel passes through, with whether Save could be pressed then: a passive
        // live read (task, profile or sync events) may legitimately restore freshness right after
        // the failure, so the test checks the transition happened rather than racing to see it.
        await p.evaluate(() => {
          const seen: string[] = ((window as unknown as { __costStates: string[] }).__costStates = []);
          const note = () => { const s = document.querySelector('.work-costs')?.getAttribute('data-work-costs-state') ?? ''; const save = document.querySelector('[data-save-work-limits]') as HTMLButtonElement | null; const v = `${s}:${save?.disabled ? 'disabled' : 'enabled'}`; if (seen.at(-1) !== v) seen.push(v); };
          new MutationObserver(note).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-work-costs-state', 'disabled'] });
        });
        await form.locator('[data-save-work-limits]').click();
        await p.waitForFunction(() => (window as unknown as { __costStates: string[] }).__costStates.some(s => s.startsWith('unavailable:')));
        const states = await p.evaluate(() => (window as unknown as { __costStates: string[] }).__costStates);
        assert.ok(states.includes('unavailable:disabled'), `a failed mutation connection invalidates freshness and disables Save until a live read: ${states.join(' → ')}`);
        assert.ok(!states.some(s => s.startsWith('success:')), 'a lost save never shows as saved');
        assert.deepEqual((await m.get('/api/v1/caps')).limits, beforeLostSave);
        await p.unroute('**/api/v1/caps/limits');
        // Retry if the page still says unavailable; a newer live read may already have restored it.
        // Checked and pressed in one step in the page, so it can't vanish between the two.
        await p.evaluate(() => (document.querySelector('[data-retry-work-costs]') as HTMLButtonElement | null)?.click());
        await p.locator('[data-work-costs-state="ready"]').waitFor();
        const beforeRefusal = (await m.get('/api/v1/caps')).limits;
        await p.route('**/api/v1/caps/limits', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Synthetic save refused"}' }));
        await form.locator('[data-save-work-limits]').click();
        await p.locator('[data-work-costs-state="save-error"]').waitFor();
        assert.equal(await field.inputValue(), '65432');
        const refusalNotice = await p.locator('[data-work-costs-notice]').innerText();
        if (!refusalNotice) console.log('REFUSAL DIAGNOSTIC', await p.locator('.work-costs').evaluate(e => ({ state: e.getAttribute('data-work-costs-state'), notice: e.querySelector('[data-work-costs-notice]')?.outerHTML })));
        assert.match(refusalNotice, /Synthetic save refused/);
        let finishRefresh!: () => void;
        const pendingRefresh = new Promise<void>(r => { finishRefresh = r; });
        await p.route('**/api/v1/caps', async route => { await pendingRefresh; await route.continue(); });
        const refreshing = p.waitForRequest(r => r.url().endsWith('/api/v1/caps'));
        nova.core.profile.set('user', 'name', 'Fixture refresh after refusal', 'settings');
        await refreshing;
        assert.match(await p.locator('[data-work-costs-notice]').innerText(), /Synthetic save refused/, 'a background read does not erase a save refusal');
        assert.equal(await form.locator('[data-save-work-limits]').isEnabled(), true, 'known-live Caps retain the retry affordance while the mutation refusal stays visible');
        const refreshed = p.waitForResponse(r => r.url().endsWith('/api/v1/caps'));
        finishRefresh(); await refreshed;
        await p.unroute('**/api/v1/caps');
        assert.deepEqual((await m.get('/api/v1/caps')).limits, beforeRefusal);
        await p.unroute('**/api/v1/caps/limits');
        await form.locator('[data-save-work-limits]').click();
        await p.locator('[data-work-costs-state="success"]').waitFor();
        assert.equal((await m.get('/api/v1/caps')).limits.task.tokens, 65432);
        // Failed or cache-served Caps must remain locked even though profile is healthy.
        for (const failure of ['failed', 'cached'] as const) {
          saved = await m.get('/api/v1/caps');
          await p.route('**/api/v1/caps', route => failure === 'failed' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic Caps outage' }) }) : route.fulfill({ status: 200, contentType: 'application/json', headers: { 'x-nova-offline': '1' }, body: JSON.stringify(saved) }));
          nova.core.profile.set('user', 'name', `Fixture ${failure}`, 'settings');
          await p.locator('[data-work-costs-state="unavailable"]').waitFor();
          assert.equal(await form.locator('[data-save-work-limits]').isDisabled(), true);
          assert.equal(await field.inputValue(), '65432');
          assert.match(await p.locator('.work-costs').innerText(), /unavailable|saved earlier|could not/i);
          await p.unroute('**/api/v1/caps');
          let finishRetry!: () => void;
          const retryHeld = new Promise<void>(resolve => { finishRetry = resolve; });
          await p.route('**/api/v1/caps', async route => { await retryHeld; await route.continue(); });
          const retryRequested = p.waitForRequest(r => r.url().endsWith('/api/v1/caps'));
          await p.getByRole('button', { name: 'Retry work costs', exact: true }).click(); await retryRequested;
          assert.equal(await form.locator('[data-save-work-limits]').isDisabled(), true, 'starting a retry cannot make a failed/stale view writable');
          assert.equal(await field.isDisabled(), true);
          const beforeRetryPut: number = puts; await form.evaluate((e: HTMLFormElement) => e.requestSubmit());
          assert.equal(puts, beforeRetryPut, 'untrusted pending retry cannot PUT');
          const retried = p.waitForResponse(r => r.url().endsWith('/api/v1/caps'));
          finishRetry(); await retried; await p.unrouteAll({ behavior: 'wait' });
          await p.locator('[data-work-costs-state="ready"]').waitFor();
        }
        // A fresh Home-start context proves genuinely unloaded data. Cached WebKit crashes
        // on a second reload even with pinned pre-change frontend bytes (retained probe).
        // The main context above still proves a real save/readback/reload in both engines.
        const unloaded = await device(b, { width, height, touch, scheme: 'dark', serviceWorkers: 'block' });
        if (posture === 'halfopen') await unloaded.ctx.addInitScript(() => Object.defineProperty(navigator, 'devicePosture', { value: Object.assign(new EventTarget(), { type: 'folded' }) }));
        let initiallyUnavailable = true;
        await unloaded.ctx.route('**/*', route => new URL(route.request().url()).origin !== m.base ? route.abort() : initiallyUnavailable && new URL(route.request().url()).pathname === '/api/v1/caps' ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic initial outage"}' }) : route.continue());
        trackDocument(unloaded.page);
        const liveCoreStream = unloaded.page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/events');
        await unloaded.page.goto(`${m.base}/`);
        await drawn(unloaded.page);
        const unloadedDoor = unloaded.page.locator('#home a[href="/health"], #aside a[href="/health"]').filter({ visible: true }).first();
        if (touch) await unloadedDoor.tap(); else await unloadedDoor.click();
        await unloaded.page.locator('[data-work-costs-state="unavailable"]').waitFor();
        assert.equal(await unloaded.page.locator('[data-save-work-limits]').isDisabled(), true);
        assert.equal(await unloaded.page.locator('[name="task.tokens"]').inputValue(), '');
        // Only Caps fails. A local endpoint refusal must not declare the live Core offline
        // or remove the native action that can help diagnose that very partial failure.
        assert.equal((await unloaded.page.request.get(`${m.base}/api/health`)).status(), 200);
        assert.equal((await unloaded.page.request.get(`${m.base}/api/v1/health`)).status(), 200);
        const liveStream = await liveCoreStream;
        assert.equal(liveStream.status(), 200);
        assert.match(liveStream.headers()['content-type']!, /text\/event-stream/);
        assert.equal(await unloaded.page.locator('#banner').isVisible(), false, 'Caps-only failure does not claim the live Core is unreachable');
        assert.notEqual(await unloaded.page.locator('.status-icon[data-presence]').first().getAttribute('data-state'), 'offline');
        const partialDiagnostics = unloaded.page.locator('[data-download-diagnostics]');
        assert.equal(await partialDiagnostics.getAttribute('href'), '/api/v1/diagnostics');
        assert.equal(await partialDiagnostics.getAttribute('download'), '');
        const partialDownloading = unloaded.page.waitForEvent('download');
        if (touch) await partialDiagnostics.tap(); else await partialDiagnostics.click();
        const partialDownload = await partialDownloading;
        const partialBundle = JSON.parse(readFileSync((await partialDownload.path())!, 'utf8'));
        assert.equal(partialBundle.redaction.marker, MARKER);
        assert.equal(partialBundle.about.nova, VERSION);
        assert.equal(documentRequests(unloaded.page).filter(url => new URL(url).pathname !== '/api/v1/diagnostics').length, 1, 'native partial-failure diagnostics retains the Home-start document');
        console.log(`HEALTH PARTIAL ${engine}/${posture}: Caps503/unavailable/Save disabled; actual health200/Core SSE200; truthful live banner/orb; native diagnostics JSON`);
        initiallyUnavailable = false;
        await unloaded.page.getByRole('button', { name: 'Retry work costs', exact: true }).click();
        await unloaded.page.locator('[data-work-costs-state="ready"]').waitFor();
        const offlineField = unloaded.page.locator('[name="task.tokens"]');
        await offlineField.fill('65433');
        const beforeOffline = (await m.get('/api/v1/caps')).limits;
        const offlineRequests: string[] = []; let offlinePuts = 0;
        unloaded.page.on('requestfailed', r => { if (r.url().endsWith('/api/v1/caps')) offlineRequests.push(r.failure()?.errorText ?? ''); });
        unloaded.page.on('request', r => { if (r.method() === 'PUT' && r.url().endsWith('/caps/limits')) offlinePuts++; });
        await unloaded.ctx.setOffline(true);
        // A browser may omit its offline hint when the hint was already false. Exercise
        // the native form submit entry point without racing a newly disabled button; the
        // same application guard must probe before PUT or reject an already known outage.
        await unloaded.page.locator('[data-work-limits]').evaluate((form: HTMLFormElement) => form.requestSubmit());
        await unloaded.page.locator('[data-work-costs-state="unavailable"]').waitFor();
        assert.equal(await unloaded.page.locator('[data-save-work-limits]').isDisabled(), true);
        assert.equal(await offlineField.inputValue(), '65433');
        await unloaded.page.locator('[data-work-limits]').evaluate((form: HTMLFormElement) => form.requestSubmit());
        assert.deepEqual((await m.get('/api/v1/caps')).limits, beforeOffline, 'offline preflight cannot persist a mutation');
        assert.ok(offlineRequests.length > 0, 'the real offline Caps probe/preflight failed');
        assert.ok(offlineRequests[0]); assert.equal(offlinePuts, 0, 'no PUT follows a failed offline preflight');
        const reconnect = unloaded.page.waitForResponse(r => r.url().endsWith('/api/v1/caps'));
        await unloaded.ctx.setOffline(false);
        const manualRetry = await unloaded.page.evaluate(() => !navigator.onLine && !!document.querySelector('[data-retry-work-costs]'));
        if (manualRetry) await unloaded.page.getByRole('button', { name: 'Retry work costs', exact: true }).click();
        await reconnect;
        await unloaded.page.waitForFunction(() => !(document.querySelector('[data-save-work-limits]') as HTMLButtonElement)?.disabled);
        assert.equal(await offlineField.inputValue(), '65433', 'reconnection preserves unsaved offline edits');
        assert.equal(unloaded.errors.filter(error => /Failed to load resource:.*503/.test(error)).length, 2, 'initial Home read and actual Health-entry retry both observe the fixture outage');
        const offlineErrors = unloaded.errors.filter(error => offlineRequests.some(reason => error === `Failed to load resource: ${reason}`));
        console.log(`HEALTH ${engine}/${posture} expected offline request failures: ${JSON.stringify(offlineRequests)}; manualRetry=${manualRetry}`);
        // WebKit may omit a console error for this failure; requestfailed above is the
        // authoritative observed request, while unexpected console/page errors still fail.
        assert.deepEqual(unloaded.errors.filter(error => !/Failed to load resource:.*503/.test(error) && !offlineErrors.includes(error)), [], 'no unexpected browser errors outside intentional outage/offline failures');
        await unloaded.ctx.close();
        const beforeDownload = files(m.home);
        // Chromium does not emit a Page response event for native attachments. Observe the
        // actual production HTTP response at the server, without fetching/intercepting the file.
        let attachmentHeaders: string | undefined;
        const observe = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => { if (req.url === '/api/v1/diagnostics') res.once('finish', () => { attachmentHeaders = (res as typeof res & { _header: string })._header; }); };
        nova.server.on('request', observe);
        const downloading = p.waitForEvent('download');
        const link = p.locator('[data-download-diagnostics]');
        assert.equal(await link.getAttribute('download'), '');
        if (touch) await link.tap(); else { await link.focus(); await p.keyboard.press('Enter'); }
        const download = await downloading;
        nova.server.off('request', observe);
        assert.ok(attachmentHeaders, 'native request finished on the real server');
        assert.match(attachmentHeaders, /cache-control:.*no-store/i);
        assert.match(attachmentHeaders, /content-type:.*application\/json/i);
        assert.match(attachmentHeaders, /content-disposition: attachment; filename="nova-diagnostics-.*\.json"/i);
        assert.match(download.suggestedFilename(), /^nova-diagnostics-.*\.json$/);
        const text = readFileSync((await download.path())!, 'utf8');
        const bundle = JSON.parse(text);
        assert.equal(bundle.about.nova, VERSION);
        assert.equal(bundle.redaction.marker, MARKER);
        assert.ok(text.includes(MARKER));
        assert.doesNotMatch(text, /https?:\/\/(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/);
        for (const canary of canaries) assert.ok(!text.includes(canary), 'no fixture secret or excluded content');
        assert.deepEqual(files(m.home), beforeDownload, 'no retained diagnostics bundle');
        assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.equal(documentRequests(p).filter(url => new URL(url).pathname !== '/api/v1/diagnostics').length, 2, 'only initial Home and the deliberate save-proof reload; native attachment is not an SPA route');
        await p.evaluate(axe);
        const accessibility = await p.evaluate(async () => (await (window as any).axe.run({ include: ['.work-costs', '.diagnostics-download'] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map((v: any) => ({ id: v.id, impact: v.impact, targets: v.nodes.map((n: any) => n.target) })));
        assert.deepEqual(accessibility, [], 'bounded WCAG AA check of the two new surfaces');
        await healthLandmarks(p, `${engine}/${posture}/after-save-reload-SSE`);
        console.log(`HEALTH ${engine}/${posture}: Home tap/click; six finite and null saves; invalid no PUT; reload; zero-blur SSE/caret; in-flight ordering; save failure; stale/failed/unloaded and real offline/reconnect retry; native JSON/headers/no retention; axe new surfaces=0`);
        // An explicit case list narrows only Diagnostics witness artifacts; every functional
        // engine/posture assertion above still runs. Normal capture runs retain the full matrix.
        const witnesses = process.env.NOVA_HEALTH_DIAGNOSTICS_WITNESSES?.split(',');
        if (out && (!witnesses || witnesses.includes(`${engine}/${posture}`))) {
          for (const part of witnesses ? ['diagnostics-download'] : ['work-costs', 'diagnostics-download']) {
            if (part === 'diagnostics-download') {
              // Include the panel's heading, then wait for native scroll/action stability.
              // An animation-only check can accept the first offscreen raster before text paints.
              await p.locator('.diagnostics-download').evaluate(e => e.parentElement!.scrollIntoView({ block: 'start' }));
              await p.locator('#h-diagnostics').scrollIntoViewIfNeeded();
              await p.locator('[data-download-diagnostics]').scrollIntoViewIfNeeded();
            } else await p.locator(`.${part}`).evaluate(e => e.scrollIntoView({ block: 'start' }));
            await still(p);
            const png = await p.screenshot({ path: join(out, `app-${part}-${posture}.png`), animations: 'disabled', caret: 'hide' });
            if (part === 'diagnostics-download') {
              const painted = await diagnosticsPaint(p, png);
              writeFileSync(join(out, `diagnostics-${posture}-audit.json`), JSON.stringify(painted, null, 2));
              console.log(`HEALTH VISUAL ${engine}/${posture} ${JSON.stringify(painted)}`);
              assert.deepEqual(painted.failures, [], 'Diagnostics title, disclosure and action must be painted and unobscured');
            }
          }
          if (!witnesses) { await form.locator('[data-save-work-limits]').scrollIntoViewIfNeeded(); await still(p); await p.screenshot({ path: join(out, `app-limits-action-${posture}.png`), animations: 'disabled', caret: 'hide' }); }
          const specimen = await d.ctx.newPage();
          for (const entry of witnesses ? ['diagnostics'] : ['work-costs', 'diagnostics']) { await specimen.goto(`${m.base}/styleguide?entry=${entry}`); await specimen.locator(`#sg-${entry}`).waitFor(); await specimen.locator(`#${entry}-state`).selectOption(entry === 'work-costs' ? 'configured' : 'available'); await specimen.locator(entry === 'work-costs' ? '.work-costs' : '.diagnostics-download').evaluate(e => e.scrollIntoView({ block: 'start' })); await still(specimen); await specimen.screenshot({ path: join(out, `styleguide-${entry}-${posture}.png`), animations: 'disabled', caret: 'hide' }); }
          await specimen.close();
        }
        const expectedOutages = d.errors.filter(error => /Failed to load resource:.*50[03]/.test(error));
        assert.equal(expectedOutages.length, 2, 'deliberate fixture save 500 and read 503 are visible browser errors');
        const lostMutation = d.errors.filter(error => lostPutRequests.some(reason => error === `Failed to load resource: ${reason}`));
        assert.equal(lostPutRequests.length, 1, 'the deliberate lost PUT is observed through requestfailed');
        assert.deepEqual(d.errors.filter(error => !expectedOutages.includes(error) && !lostMutation.includes(error)), [], 'no unexpected browser errors');
        await d.ctx.close();
        if (engine === 'chromium' && posture === 'phone') await diagnosticsWorkerUpgrade(b, m, nova);
      }
      assert.equal(readFileSync(m.egress, 'utf8'), '');
    } finally {
      await b.close();
      nova.scheduler.stop();
      await new Promise<void>((r, reject) => { nova.server.close(e => e ? reject(e) : r()); nova.server.closeAllConnections(); });
      await nova.core.close();
      await runtime.close();
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      rmSync(m.dir, { recursive: true, force: true });
    }
  });
}
