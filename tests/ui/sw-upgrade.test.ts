// The service worker's cache name stopped being a hand-bumped number (nova-shell-v70) and became a
// hash of the shell (src/sw-version.js). A browser that installed the last numbered worker must
// upgrade cleanly: the served worker differs, so the browser installs it, and its activate step
// deletes nova-shell-v70 (and any older numbered cache) while keeping other apps' caches. The new
// cache holds the whole shell. Production createNova; only the old worker script is pinned, from
// the last numbered ui/sw.js (tests/support/fixtures/sw-v70.js.txt). Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { RequestListener } from 'node:http';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { shellHash, shellPaths } from '../../src/sw-version.js';
import { ROOT, blank, browser, device, finishSetup, ready, until } from './support.ts';

const legacy = readFileSync(new URL('../support/fixtures/sw-v70.js.txt', import.meta.url), 'utf8');
const versionOf = (sw: string) => /const VERSION = '([^']+)'/.exec(sw)![1]!;

test('a browser on the numbered nova-shell-v70 worker upgrades to the hash-named one and loses the old cache', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-sw-upgrade-');
  const nova = createNova(loadConfig({ ...m.env, NOVA_AGENT_CMD: 'unused-example-agent', NOVA_AGENT_EGRESS: 'none' }));
  await new Promise<void>((r) => nova.server.listen(0, '127.0.0.1', r));
  m.base = `http://127.0.0.1:${(nova.server.address() as AddressInfo).port}`;
  const normal = nova.server.listeners('request')[0] as RequestListener;
  let serveLegacy = true;
  // Files the old worker's shell names that Nova no longer ships (the tiled mark, mark-1024.webp,
  // replaced by mark.svg on 2026-11-10). A browser on v70 cached them when it installed; here the
  // old worker installs now, so it gets a stand-in for each, or its addAll would fail.
  const current = shellPaths(readFileSync(join(ROOT, 'ui/sw.js'), 'utf8')) as string[];
  const gone = (shellPaths(legacy) as string[]).filter((path) => !current.includes(path));
  const serve: RequestListener = (req, res) => {
    if (serveLegacy && req.url === '/sw.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }); res.end(legacy); }
    else if (serveLegacy && gone.includes(req.url ?? '')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(); }
    else normal.call(nova.server, req, res);
  };
  nova.server.removeListener('request', normal); nova.server.on('request', serve);
  try {
    assert.equal(versionOf(legacy), 'nova-shell-v70');
    await finishSetup(m);
    const d = await device(b, { width: 390, height: 844, touch: true });
    const p = d.page;
    await p.goto(`${m.base}/`); await ready(p);
    await p.evaluate(() => navigator.serviceWorker.ready);
    await p.waitForFunction(() => !!navigator.serviceWorker.controller);
    assert.deepEqual(await Promise.all(d.ctx.serviceWorkers().map((w) => w.evaluate('VERSION'))), ['nova-shell-v70'], 'the numbered worker is installed first');
    // Its install filled nova-shell-v70 with the shell. An older numbered cache and another app's are there too.
    await until(p, async () => !!(await (await caches.open('nova-shell-v70')).match('/js/app.js')));
    await p.evaluate(async () => {
      await (await caches.open('nova-shell-v3')).put('/api/v1/tasks', new Response('[]', { headers: { 'content-type': 'application/json' } }));
      await (await caches.open('other-app-public-example')).put('/unrelated-public-example', new Response('synthetic-unrelated-cache-sentinel'));
    });
    const before = await p.evaluate(() => caches.keys());
    assert.ok(before.includes('nova-shell-v70') && before.includes('nova-shell-v3') && before.includes('other-app-public-example'), `before: ${before}`);

    // Now the server sends the worker it ships: the same file, its name filled in from the shell.
    serveLegacy = false;
    const served = await (await fetch(`${m.base}/sw.js`)).text();
    const next = versionOf(served);
    assert.equal(next, `nova-shell-${shellHash(join(ROOT, 'ui'))}`, 'the served name is the hash of the current shell');
    await p.evaluate(async () => {
      const registration = (await navigator.serviceWorker.getRegistration())!;
      const previous = registration.active;
      const changed = new Promise<void>((resolve) => {
        const check = () => { if (registration.active && registration.active !== previous && registration.active.state === 'activated' && navigator.serviceWorker.controller === registration.active) resolve(); };
        const installing = () => { registration.installing?.addEventListener('statechange', check); check(); };
        registration.addEventListener('updatefound', installing);
        navigator.serviceWorker.addEventListener('controllerchange', check);
        installing();
      });
      await registration.update(); await changed;
    });
    await until(p, async (v: string) => { const keys = await caches.keys(); return keys.includes(v) && !keys.includes('nova-shell-v70') && !keys.includes('nova-shell-v3'); }, next);
    const after = await p.evaluate(() => caches.keys());
    assert.ok(!after.includes('nova-shell-v70'), 'the numbered cache is gone');
    assert.ok(!after.includes('nova-shell-v3'), 'and the older one');
    assert.ok(after.includes(next), 'the hash-named cache is there');
    assert.equal(await p.evaluate(async () => (await (await caches.open('other-app-public-example')).match('/unrelated-public-example'))!.text()), 'synthetic-unrelated-cache-sentinel', 'another app’s cache is kept');
    assert.ok((await Promise.all(d.ctx.serviceWorkers().map((w) => w.evaluate('VERSION').catch(() => null)))).includes(next), 'the running worker uses the hash name');

    // The new cache holds the whole shell.
    const missing = await p.evaluate(async ({ v, paths }) => { const c = await caches.open(v); const out: string[] = []; for (const path of paths) if (!(await c.match(path))) out.push(path); return out; }, { v: next, paths: shellPaths(served) as string[] });
    assert.deepEqual(missing, [], 'every SHELL file is in the new cache');

    // The same build asked again (a restart, a reload): nothing new is installed.
    const again = await p.evaluate(async () => { const r = (await navigator.serviceWorker.getRegistration())!; await r.update(); return { installing: !!r.installing, waiting: !!r.waiting }; });
    assert.deepEqual(again, { installing: false, waiting: false }, 'an unchanged shell is not reinstalled');
    assert.deepEqual(d.errors, [], 'no browser errors');
  } finally {
    await b.close();
    await new Promise<void>((r) => { nova.server.close(() => r()); nova.server.closeAllConnections(); });
  }
});
