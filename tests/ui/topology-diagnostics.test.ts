import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventEmitter } from 'node:events';
import { browser, webkitBrowser, device } from './support.ts';
import { observeTopology } from './topology-diagnostics.ts';

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`topology diagnostics: ${engine} records failures without suppressing device errors and retains navigation-request sequences`, { timeout: 30_000 }, async () => {
    const b = await launch(); assert.notEqual(typeof b, 'string'); if (typeof b === 'string') throw Error(b);
    const d = await device(b, { serviceWorkers: 'block' }); const p = d.page;
    const observer = observeTopology(p);
    let release = () => {};
    try {
      await p.route('http://topology-diagnostic.test/**', route => route.fulfill(new URL(route.request().url()).pathname === '/owned-console.js'
        ? { contentType: 'application/javascript', body: `console.error('Failed to load resource: WebKit encountered an internal error');` }
        : { contentType: 'text/html', body: '<!doctype html><title>Owned diagnostic fixture</title><a href="#same-document">Same document</a>' }));
      let actualSequence = 0, sequenceAtFailure = 0, actualErrorText = '';
      p.on('request', r => { if (r.isNavigationRequest() && r.frame() === p.mainFrame()) actualSequence++; });
      p.on('requestfailed', r => { if (new URL(r.url()).pathname === '/owned-failure') { sequenceAtFailure = actualSequence; actualErrorText = r.failure()?.errorText ?? ''; } });
      observer.stage({ layout: 'phone', theme: 'orb-teal', stage: 'initial-map' });
      await p.goto('http://topology-diagnostic.test/?query=QUERY_CANARY#fragment=FRAGMENT_CANARY');
      await p.locator('a').click();
      assert.equal(observer.snapshot().navigationSequence, 1, 'SPA/hash navigation retains the actual document lifetime');
      let caught!: () => void, done!: () => void;
      const captured = new Promise<void>(r => { caught = r; }), held = new Promise<void>(r => { release = r; }), finished = new Promise<void>(r => { done = r; });
      await p.route('**/owned-failure*', async route => { caught(); await held; await route.abort('failed'); done(); });
      observer.stage({ layout: 'phone', theme: 'orb-teal', stage: 'held-read' });
      await p.evaluate(() => { void fetch('/owned-failure?token=QUERY_CANARY', { method: 'POST', headers: { 'x-canary': 'HEADER_CANARY' }, body: 'BODY_CANARY' }).catch(() => {}); });
      await captured;
      observer.stage({ layout: 'phone', theme: 'nova', stage: 'reload' });
      await p.reload();
      release(); await finished;
      const consoleSeen = p.waitForEvent('console', { predicate: m => m.text() === 'Failed to load resource: WebKit encountered an internal error' });
      await p.addScriptTag({ url: '/owned-console.js?token=LOCATION_CANARY' });
      const actualConsoleLocation = (await consoleSeen).location();
      // Console delivery is synchronized by the explicit browser event below, with no sleeps.
      const barrier = p.waitForEvent('console', { predicate: m => m.text() === 'done' });
      await p.evaluate(() => console.log('done')); await barrier;
      const s = observer.snapshot();
      assert.equal(s.navigationSequence, 2, 'reload makes a second main-document request');
      assert.equal(s.documents.length, 2);
      const failure = s.events.find(e => e.kind === 'requestfailed' && e.request?.path === '/owned-failure');
      assert.ok(failure?.kind === 'requestfailed', 'the actual failed request must be recorded');
      assert.ok(failure.request.started);
      assert.equal(failure.request.method, 'POST'); assert.equal(failure.request.resourceType, 'fetch');
      assert.equal(failure.request.started.navigationSequence, 1); assert.equal(failure.request.started.stage, 'held-read');
      assert.equal(failure.observed.navigationSequence, sequenceAtFailure, 'failure context follows actual event order, including WebKit canceling before the next document request'); assert.equal(failure.observed.stage, 'reload');
      assert.equal(failure.errorText, actualErrorText, 'browser error codes are diagnostic evidence, not opaque URLs');
      assert.ok(failure.observed.elapsedMs >= failure.request.started.elapsedMs);
      const consoleEvent = s.events.find(e => e.kind === 'console-error' && e.text === 'Failed to load resource: WebKit encountered an internal error');
      assert.ok(consoleEvent?.kind === 'console-error');
      assert.equal(consoleEvent.location.path, actualConsoleLocation.url ? new URL(actualConsoleLocation.url).pathname : ''); assert.equal(typeof consoleEvent.location.line, 'number');
      assert.ok(d.errors.includes('Failed to load resource: WebKit encountered an internal error'), 'the original error collector remains strict and unchanged');
      const json = JSON.stringify(s);
      for (const canary of ['QUERY_CANARY', 'FRAGMENT_CANARY', 'HEADER_CANARY', 'BODY_CANARY', 'LOCATION_CANARY']) assert.ok(!json.includes(canary), canary);
    } finally { release(); observer.dispose(); await b.close(); }
  });
}

test('topology diagnostics: bounded output redacts URL credentials and opaque URLs, and disposal detaches all listeners', { timeout: 30_000 }, async () => {
  const b = await browser(); assert.notEqual(typeof b, 'string'); if (typeof b === 'string') throw Error(b);
  const p = await b.newPage();
  const names = ['request', 'requestfinished', 'requestfailed', 'console'] as const;
  const emitter = p as unknown as EventEmitter;
  const before = names.map(n => emitter.listenerCount(n));
  const observer = observeTopology(p);
  try {
    await p.route('http://topology-diagnostic.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Owned fixture</title>' }));
    await p.goto('http://topology-diagnostic.test/');
    await p.evaluate(() => {
      for (let i = 0; i < 80; i++) console.error(`entry-${i} http://USER_CANARY:PASS_CANARY@example.test/safe-path?token=QUERY_CANARY#FRAGMENT_CANARY /relative?token=RELATIVE_CANARY url=/prefixed?token=PREFIX_CANARY#PREFIX_FRAGMENT //USER2_CANARY:PASS2_CANARY@example.test/path?QUERY2_CANARY //bad[INVALID_CANARY file:/tmp/FILE_CANARY blob:https://example.test/BLOB_CANARY data:text/plain,DATA_CANARY ${'x'.repeat(1000)}`);
    });
    const barrier = p.waitForEvent('console', { predicate: m => m.text() === 'done' });
    await p.evaluate(() => console.log('done')); await barrier;
    const s = observer.snapshot();
    assert.equal(s.events.length, 32); assert.equal(s.counts.consoleErrors, 80); assert.equal(s.counts.evictedEvents, 48);
    const json = JSON.stringify(s);
    assert.ok(json.includes('/safe-path')); assert.ok(json.length < 32000, 'snapshot size is bounded independently of console text size');
    for (const canary of ['USER_CANARY', 'PASS_CANARY', 'QUERY_CANARY', 'FRAGMENT_CANARY', 'BLOB_CANARY', 'DATA_CANARY', 'RELATIVE_CANARY', 'USER2_CANARY', 'PASS2_CANARY', 'QUERY2_CANARY', 'INVALID_CANARY', 'FILE_CANARY', 'PREFIX_CANARY', 'PREFIX_FRAGMENT']) assert.ok(!json.includes(canary), canary);
    for (let i = 1; i < 35; i++) await p.goto(`http://topology-diagnostic.test/document-${i}?token=QUERY_CANARY`);
    const documents = observer.snapshot();
    assert.equal(documents.navigationSequence, 35); assert.equal(documents.documents.length, 32); assert.equal(documents.counts.evictedDocuments, 3);
    let abortFirst!: () => Promise<void>;
    let firstCaught!: () => void;
    const firstRoute = new Promise<void>(resolve => { firstCaught = resolve; });
    await p.route('**/pending/**', route => {
      if (new URL(route.request().url()).pathname === '/pending/0') { abortFirst = () => route.abort('failed'); firstCaught(); }
    });
    const requestBarrier = p.waitForEvent('request', { predicate: r => new URL(r.url()).pathname === '/pending/79' });
    await p.evaluate(() => { for (let i = 0; i < 80; i++) void fetch(`/pending/${i}?token=QUERY_CANARY`).catch(() => {}); });
    await requestBarrier; await firstRoute;
    const pending = observer.snapshot(); assert.equal(pending.inFlight.length, 32); assert.ok(pending.counts.evictedPending >= 48);
    const failed = p.waitForEvent('requestfailed', { predicate: r => new URL(r.url()).pathname === '/pending/0' });
    await abortFirst(); await failed;
    const evicted = observer.snapshot().events.find(e => e.kind === 'requestfailed' && e.request.path === '/pending/0');
    assert.ok(evicted?.kind === 'requestfailed'); assert.equal(evicted.request.started, null, 'evicted start metadata stays unknown');
    observer.dispose(); observer.dispose();
    assert.deepEqual(names.map(n => emitter.listenerCount(n)), before, 'disposal removes only its own listeners');
    assert.deepEqual(observer.snapshot().inFlight, []);
    const after = JSON.stringify(observer.snapshot());
    const afterDispose = p.waitForEvent('console', { predicate: m => m.text() === 'after-dispose' });
    await p.evaluate(() => console.error('after-dispose')); await afterDispose;
    assert.equal(JSON.stringify(observer.snapshot()), after, 'disposed observers collect no further events');
  } finally { observer.dispose(); await b.close(); }
});
