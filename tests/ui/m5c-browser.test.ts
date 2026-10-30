// M5c, browser work without a person: Nova's own browser worker drives Chromium over CDP through
// the local form site and the task ends Verified, with a screenshot in its folder and the final
// page read again by Nova; the site's own record says what was sent. A page that reaches hosts the
// task didn't declare (an image, a fetch, a WebSocket) gets nothing through, and each refusal is in
// the task's record. Runs where Chromium can start (scripts/ui-test.sh), never skipped in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stop } from '../acceptance/support.ts';
import { blank, browser, finishSetup } from './support.ts';
import { browserEnv, browserTask, delegate, events, formPlan, settled, startFormSite, waitTask } from './m5c-support.ts';

test('M5c: a browser task fills the form on its own and ends Verified, checked by Nova itself', { timeout: 120_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  await b.close();
  const site = await startFormSite();
  const m = blank('nova-ui-m5c-run-');
  const nova = await m.start(browserEnv());
  try {
    await finishSetup(m);
    const health = await m.get('/api/v1/browser');
    assert.equal(health.chromium.available, true, health.chromium.detail);

    const r = await delegate(m, formPlan(site, { person: false }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.privacy_mode, 'local-only', 'a local site is fine for a local-only task');
    assert.equal(r.body.approval_tier, 2, 'sending a form asks first');
    const task = await waitTask(m, r.body.id, settled);
    assert.equal(task.state, 'done', task.reason ?? '');
    assert.equal(task.verification!.ok, true);
    const why = Object.fromEntries(task.verification!.checks.map((c) => [c.requirement.kind, c.why]));
    assert.match(why.screenshot!, /Nova took this screenshot itself/);
    assert.match(why.url!, /Nova fetched .*\/records again itself/);

    // Checked independently of Nova: the site's own record, and the screenshot on disk.
    assert.equal(site.records.length, 1);
    assert.deepEqual({ name: site.records[0].name, email: site.records[0].email, plan: site.records[0].plan, note: site.records[0].note },
      { name: 'Ada Example', email: 'ada@example.test', plan: 'plus', note: 'Mornings are best.' });
    const png = join(m.home, 'workers', 'browser', task.id, 'final.png');
    assert.ok(existsSync(png), 'the screenshot is in the task’s folder');
    assert.equal(readFileSync(png).subarray(1, 4).toString(), 'PNG');
    const shot = await fetch(`${m.base}/api/v1/browser/tasks/${task.id}/screenshot`);
    assert.equal(shot.headers.get('content-type'), 'image/png');
    assert.equal(shot.headers.get('cache-control'), 'no-store');

    // The page read was screened by the ingest gate as it was taken (Amendment 2026-10-30-C Part 3):
    // its verdict is kept with it, before any model could ever read it.
    const reads = JSON.parse(readFileSync(join(m.home, 'workers', 'browser', task.id, 'reads.json'), 'utf8')) as { screen?: { id: string; verdict: string } }[];
    assert.ok(reads.length > 0 && reads.every((x) => x.screen && /^(pass|quarantine|block)$/.test(x.screen.verdict)), JSON.stringify(reads));
    const screen = await m.get(`/api/v1/ingest/screens/${reads[0]!.screen!.id}`);
    assert.equal(screen.kind, 'web');

    const ev = await events(m, task.id);
    assert.equal(ev.filter((e) => e.kind === 'step').length, 9, 'every step is in the record');
    // The form reaches nothing else. (Chromium's own calls home are refused at the proxy and
    // recorded too; they aren't the page's.)
    assert.deepEqual(ev.filter((e) => e.kind === 'blocked_request' && e.detail.via !== 'proxy').map((e) => e.detail), [], 'the form reaches nothing else');
    assert.ok(ev.filter((e) => e.kind === 'blocked_request' && e.detail.via === 'proxy').every((e) => e.detail.by === 'browser'));
    assert.equal((await m.get(`/api/v1/browser/tasks/${task.id}`)).live, false, 'its browser is closed');
  } finally {
    await stop(nova);
    await site.close();
  }
});

test('M5c: hosts a task didn’t declare are refused and recorded; the plan can’t name one', { timeout: 120_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  await b.close();
  const site = await startFormSite();
  const m = blank('nova-ui-m5c-blocked-');
  const nova = await m.start(browserEnv());
  try {
    await finishSetup(m);
    const plan = { allowed_hosts: [site.host], steps: [{ do: 'navigate', url: `${site.url}/leaky` }, { do: 'read', selector: '#leaky-status', expect: 'Loaded' }], verify: { expect: ['A page that reaches elsewhere'] } };
    const r = await m.send('POST', '/api/v1/tasks', browserTask(plan, 'Open the leaky page'));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const task = await waitTask(m, r.body.id, settled);
    assert.equal(task.state, 'done', task.reason ?? '');
    const ev = await events(m, task.id);
    const blocked = ev.filter((e) => e.kind === 'blocked_request').map((e) => e.detail);
    const hosts = blocked.map((d) => d.host);
    assert.ok(hosts.includes(`localhost:${site.port}`), `the image's other host is refused: ${JSON.stringify(blocked)}`);
    assert.ok(hosts.includes('tracker.example.test:80'), 'the fetch is refused');
    assert.match(task.report.summary, /Refused \d+ hosts? the task didn’t declare/);
    // Nothing got through: the site never heard from the other name.
    await new Promise((r) => setTimeout(r, 500));
    const leaked = site.hits.filter((h: { path: string }) => h.path === '/pixel.png' || h.path === '/socket');
    assert.deepEqual(leaked, [], 'no request reached the site under the undeclared name');

    // A plan that names a host outside its own list is refused when it is delegated.
    const bad = await m.send('POST', '/api/v1/tasks', browserTask({ allowed_hosts: [site.host], steps: [{ do: 'navigate', url: 'http://elsewhere.example.test/' }] }, 'Go elsewhere'));
    assert.equal(bad.status, 400);
    assert.match(JSON.stringify(bad.body.details), /outside the allowed hosts \(elsewhere\.example\.test:80\)/);
    // And a remote host is refused for a local-only task, saying why.
    const remote = await m.send('POST', '/api/v1/tasks', browserTask({ allowed_hosts: ['example.test'], steps: [{ do: 'navigate', url: 'https://example.test/' }], verify: { expect: ['Example'] } }, 'Go remote'));
    assert.equal(remote.status, 400);
    assert.match(remote.body.error, /sends data off your devices, and this task is local-only/);
  } finally {
    await stop(nova);
    await site.close();
  }
});
