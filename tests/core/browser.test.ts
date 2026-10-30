// M5c without a browser: the CDP client over a stand-in pipe, the plan rules (steps, declared
// hosts, where a plan's data goes), the evidence checkers, Nova's own re-fetch, the ledger's side
// of a worker that needs the person, the browser worker inside the core when there is no Chromium,
// who may take over, and the local form site. What needs Chromium is in tests/ui/m5c-*.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Cdp, CdpError, type Transport } from '../../src/core/browser/cdp.ts';
import { findChromium } from '../../src/core/browser/chromium.ts';
import { allowed, describe, hostEgress, hostOf, planEgress, validatePlan } from '../../src/core/browser/plan.ts';
import { checkers, htmlText, pngSize, refetch, taskDir } from '../../src/core/browser/evidence.ts';
import { parseInput } from '../../src/core/browser/worker.ts';
import { Db } from '../../src/core/db.ts';
import { Log } from '../../src/core/log.ts';
import { Ledger } from '../../src/core/ledger.ts';
import { Verifier } from '../../src/core/verify.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { ENVELOPE_VERSION, type Brief } from '../../src/core/envelope.ts';
import { CoreError } from '../../src/core/errors.ts';
import type { Worker } from '../../src/core/workers.ts';
import { startFormSite } from '../../scripts/form-site.js';
import { enroll, hub } from './mesh-support.ts';

// ---- the CDP client ---------------------------------------------------------------------------

function fakePipe() {
  const sent: any[] = [];
  let data: (c: string) => void = () => {};
  let closed: (why: string) => void = () => {};
  const t: Transport = {
    send: (m) => sent.push(JSON.parse(m)),
    onData: (fn) => { data = fn as (c: string) => void; },
    onClose: (fn) => { closed = fn; },
    close: () => closed('closed by Nova'),
  };
  return { t, sent, feed: (s: string) => data(s), drop: (why: string) => closed(why) };
}

test('CDP: answers find their commands by id, even split across chunks or sharing one', async () => {
  const p = fakePipe();
  const cdp = new Cdp(p.t);
  const a = cdp.send('Browser.getVersion');
  const b = cdp.send('Page.navigate', { url: 'http://127.0.0.1:1/' }, 'S1');
  assert.deepEqual(p.sent, [{ id: 1, method: 'Browser.getVersion', params: {} }, { id: 2, method: 'Page.navigate', params: { url: 'http://127.0.0.1:1/' }, sessionId: 'S1' }]);
  const two = JSON.stringify({ id: 2, result: { frameId: 'F' } });
  p.feed(`${two.slice(0, 7)}`);
  p.feed(`${two.slice(7)}\0${JSON.stringify({ id: 1, result: { product: 'Chromium' } })}\0`);
  assert.deepEqual(await b, { frameId: 'F' });
  assert.deepEqual(await a, { product: 'Chromium' });
});

test('CDP: an error answer rejects with the method named; events carry their session', async () => {
  const p = fakePipe();
  const cdp = new Cdp(p.t);
  const seen: unknown[] = [];
  cdp.on('Fetch.requestPaused', (params, sid) => seen.push([params, sid]));
  const r = cdp.send('Page.navigate', { url: 'x' });
  p.feed(`${JSON.stringify({ id: 1, error: { code: -32000, message: 'Cannot navigate to invalid URL' } })}\0`);
  await assert.rejects(r, (e: unknown) => e instanceof CdpError && e.code === -32000 && /Page\.navigate: Cannot navigate/.test(e.message));
  p.feed(`${JSON.stringify({ method: 'Fetch.requestPaused', params: { requestId: 'R1' }, sessionId: 'S9' })}\0garbage\0`);
  assert.deepEqual(seen, [[{ requestId: 'R1' }, 'S9']]);
});

test('CDP: a closed pipe fails what is waiting and refuses what comes next; a silent browser times out', async () => {
  const p = fakePipe();
  const cdp = new Cdp(p.t, { timeoutMs: 50 });
  const waiting = cdp.send('Browser.getVersion', {}, undefined, { timeoutMs: 0 });
  const slow = cdp.send('Page.enable');
  await assert.rejects(slow, /no answer within/);
  p.drop('the browser closed its end');
  await assert.rejects(waiting, /connection closed \(the browser closed its end\)/);
  await assert.rejects(cdp.send('Page.enable'), /connection is closed/);
  assert.equal(cdp.closed, true);
});

// ---- Chromium -----------------------------------------------------------------------------------

test('Chromium: NOVA_CHROMIUM is used when it is there, and said plainly when it isn’t', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-chromium-'));
  const fake = join(dir, 'chrome');
  writeFileSync(fake, '#!/bin/sh\n');
  chmodSync(fake, 0o755);
  assert.deepEqual(findChromium({ NOVA_CHROMIUM: fake }), { path: fake, from: 'NOVA_CHROMIUM', detail: `Chromium at ${fake} (from NOVA_CHROMIUM).` });
  const missing = findChromium({ NOVA_CHROMIUM: join(dir, 'nothing-here'), CHROMIUM: fake });
  assert.equal(missing.path, null, 'a path the person named is never silently replaced');
  assert.match(missing.detail, /NOVA_CHROMIUM names .*nothing-here, and there is no runnable browser there/);
});

// ---- the plan -----------------------------------------------------------------------------------

test('plan: declared hosts decide what a URL may reach: port, subdomains, schemes', () => {
  const hosts = ['127.0.0.1:4321', 'example.test', '*.example.org', '[::1]:8080'];
  assert.equal(allowed('http://127.0.0.1:4321/form', hosts), true);
  assert.equal(allowed('http://127.0.0.1:4322/form', hosts), false, 'another port is another host');
  assert.equal(allowed('http://localhost:4321/', hosts), false, 'another name for the same machine is still another host');
  assert.equal(allowed('https://example.test/a', hosts), true);
  assert.equal(allowed('http://example.test:8000/a', hosts), true, 'no port declared: any port');
  assert.equal(allowed('https://www.example.test/', hosts), false, 'subdomains only when declared');
  assert.equal(allowed('https://a.example.org/', hosts), true);
  assert.equal(allowed('https://example.org/', hosts), false);
  assert.equal(allowed('http://[::1]:8080/', hosts), true);
  assert.equal(allowed('ws://127.0.0.1:4321/socket', hosts), true);
  assert.equal(allowed('file:///etc/passwd', hosts), false);
  assert.equal(allowed('javascript:alert(1)', hosts), false);
  assert.equal(hostOf('http://tracker.example.test/beacon?id=secret'), 'tracker.example.test:80', 'a refusal records the host, never the path or query');
});

test('plan: where a plan’s data goes, so local-only can refuse it', () => {
  for (const h of ['127.0.0.1:4321', 'localhost', '10.0.0.8', '192.168.1.20:80', '172.20.0.2', '100.101.102.103', '[::1]:80']) assert.equal(hostEgress(h), 'local', h);
  // A name proves nothing about where it leads, however local it sounds (M5 review).
  for (const h of ['example.test', '8.8.8.8', '172.32.0.1', 'intranet', 'example.com:443', 'printer.local', 'nas.home.arpa']) assert.equal(hostEgress(h), 'remote', h);
  assert.equal(planEgress({ allowed_hosts: ['127.0.0.1:1'], steps: [] }), 'local');
  assert.equal(planEgress({ allowed_hosts: ['127.0.0.1:1', 'example.test'], steps: [] }), 'remote');
});

test('plan: every problem is listed; a navigation outside the declared hosts is refused before it runs', () => {
  const ok = validatePlan({ allowed_hosts: ['127.0.0.1:4321'], steps: [{ do: 'navigate', url: 'http://127.0.0.1:4321/start' }, { do: 'person', why: 'Sign in.', done_when: '#account' }], verify: { expect: ['Welcome'] } });
  assert.equal(ok.steps.length, 2);
  assert.throws(() => validatePlan({ allowed_hosts: [], steps: [] }), (e: unknown) => e instanceof CoreError && e.details.length === 2);
  assert.throws(() => validatePlan({
    allowed_hosts: ['127.0.0.1:4321', 'not a host'],
    steps: [{ do: 'navigate', url: 'http://elsewhere.example.test/' }, { do: 'fill', selector: '#a' }, { do: 'dance' }, { do: 'person' }, { do: 'navigate', url: 'file:///etc/passwd' }],
    verify: { expect: [], url: 'http://elsewhere.example.test/done' },
  }), (e: unknown) => {
    const d = (e as CoreError).details.join('\n');
    for (const want of ['allowed_hosts[1] must be a host', 'steps[0].url is outside the allowed hosts (elsewhere.example.test:80)', 'steps[1].value must be text', 'steps[2].do must be one of', 'steps[3].why must say', 'steps[4].url must be an http(s) address', 'verify.expect must list', 'verify.url is outside the allowed hosts']) assert.ok(d.includes(want), `${want}\n${d}`);
    return true;
  });
  assert.equal(describe({ do: 'navigate', url: 'http://127.0.0.1:4321/start?x=1' }), 'Open 127.0.0.1/start');
  assert.equal(describe({ do: 'person', why: 'Sign in.' }), 'Sign in.');
  assert.equal(describe({ do: 'click', selector: '#next', label: 'Go on' }), 'Go on');
});

test('input: the person’s pointer and keys are checked before they reach the page', () => {
  assert.deepEqual(parseInput({ type: 'click', x: 0.5, y: 0.25 }), { type: 'click', x: 0.5, y: 0.25 });
  assert.deepEqual(parseInput({ type: 'key', key: 'Enter' }), { type: 'key', key: 'Enter' });
  assert.deepEqual(parseInput({ type: 'scroll', x: 0, y: 0, dy: 120 }), { type: 'scroll', x: 0, y: 0, dx: 0, dy: 120 });
  assert.throws(() => parseInput({ type: 'click', x: '1' }), /x must be a number/);
  assert.throws(() => parseInput({ type: 'key', key: 'F12' }), /key must be one of/);
  assert.throws(() => parseInput({ type: 'text', text: '' }), /text must be 1 to 2000/);
  assert.throws(() => parseInput({ type: 'eval' }), /type must be/);
});

// ---- evidence ------------------------------------------------------------------------------------

const brief = (id: string, inputs: Record<string, unknown>): Brief => ({
  envelope: ENVELOPE_VERSION, task_id: id, goal: 'Fill the form.', context_refs: [], constraints: {}, privacy_mode: 'local-only', approval_tier: 1,
  evidence_required: [{ kind: 'screenshot' }, { kind: 'url' }], idempotency_key: id, inputs,
});
// A real 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

test('evidence: a screenshot counts only if Nova took it for this very task', () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-evidence-'));
  const { screenshot } = checkers(home);
  const b = brief('task-1', {});
  mkdirSync(taskDir(home, 'task-1'), { recursive: true });
  writeFileSync(join(taskDir(home, 'task-1'), 'final.png'), PNG);
  mkdirSync(taskDir(home, 'task-2'), { recursive: true });
  writeFileSync(join(taskDir(home, 'task-2'), 'final.png'), PNG);
  writeFileSync(join(taskDir(home, 'task-1'), 'fake.png'), 'not a picture');
  assert.match(screenshot({ kind: 'screenshot', ref: 'workers/browser/task-1/final.png' }, b).why, /Nova took this screenshot itself at the end of the task: 1×1/);
  assert.equal(screenshot({ kind: 'screenshot', ref: 'workers/browser/task-1/final.png' }, b).ok, true);
  assert.equal(screenshot({ kind: 'screenshot', ref: 'workers/browser/task-2/final.png' }, b).ok, false, 'another task’s screenshot');
  assert.equal(screenshot({ kind: 'screenshot', ref: 'workers/browser/task-1/../task-2/final.png' }, b).ok, false);
  assert.equal(screenshot({ kind: 'screenshot', ref: 'workspace/shot.png' }, b).ok, false, 'a file a worker wrote anywhere else');
  assert.match(screenshot({ kind: 'screenshot', ref: 'workers/browser/task-1/fake.png' }, b).why, /isn’t a PNG/);
  assert.match(screenshot({ kind: 'screenshot', ref: 'workers/browser/task-1/gone.png' }, b).why, /isn’t there/);
  assert.deepEqual(pngSize(PNG), { width: 1, height: 1 });
  assert.throws(() => taskDir(home, '../escape'), /Not a task id/);
});

test('evidence: a link counts only if Nova read that page itself and it shows what the brief expects', () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-evidence-'));
  const { url } = checkers(home);
  const inputs = { allowed_hosts: ['127.0.0.1:4321'], steps: [], verify: { expect: ['Ada Example', 'Received'] } };
  const b = brief('task-1', inputs);
  const done = 'http://127.0.0.1:4321/done/R-1';
  assert.match(url({ kind: 'url', url: done }, b).why, /no read of its own/);
  mkdirSync(taskDir(home, 'task-1'), { recursive: true });
  const write = (reads: unknown[]) => writeFileSync(join(taskDir(home, 'task-1'), 'final-read.json'), JSON.stringify({ task_id: 'task-1', url: done, final_url: done, at: 'now', reads }));
  write([{ source: 'fetch', url: done, status: 200, text: 'Received  Name Ada\n Example' }]);
  assert.equal(url({ kind: 'url', url: done }, b).ok, true, 'whitespace is not a difference');
  assert.match(url({ kind: 'url', url: done }, b).why, /Nova fetched .* again itself \(HTTP 200\), and it shows “Ada Example”, “Received”/);
  write([{ source: 'fetch', url: done, text: '', error: 'refused' }, { source: 'dom', url: done, text: 'Received Ada Example' }]);
  assert.match(url({ kind: 'url', url: done }, b).why, /read the final page in its own browser, afresh/);
  write([{ source: 'fetch', url: done, status: 200, text: 'Received' }]);
  assert.match(url({ kind: 'url', url: done }, b).why, /doesn’t show “Ada Example”/);
  assert.match(url({ kind: 'url', url: 'http://127.0.0.1:4321/done/R-2' }, b).why, /Nova read .*R-1, not .*R-2/);
  assert.match(url({ kind: 'url', url: 'http://elsewhere.example.test/' }, b).why, /outside the hosts this task declared/);
  assert.match(url({ kind: 'url', url: done }, brief('task-1', { allowed_hosts: ['127.0.0.1:4321'] })).why, /didn’t say what the final page must show/);
  assert.equal(htmlText('<p>Ada&nbsp;&amp; <b>Bo</b></p><script>secret()</script>&#39;&#x41;').replace(/\s+/g, ' ').trim(), 'Ada & Bo \'A', 'tags and scripts go, entities are decoded');
});

test('evidence: Nova fetches the page again itself, following redirects only inside the declared hosts', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/hop') { res.writeHead(303, { location: '/done' }); res.end(); return; }
    if (req.url === '/away') { res.writeHead(302, { location: 'http://elsewhere.example.test/' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<h1>Received</h1><script>no()</script>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const r = await refetch(`http://${host}/hop`, [host]);
    assert.equal(r.status, 200);
    assert.equal(r.text.trim(), 'Received');
    const away = await refetch(`http://${host}/away`, [host]);
    assert.match(away.error!, /led outside the declared hosts \(elsewhere\.example\.test\)/);
  } finally {
    server.close();
  }
});

// ---- the ledger's side ------------------------------------------------------------------------

test('ledger: a running worker that needs the person waits as Needs you, and carries on after', async () => {
  const db = new Db(':memory:');
  db.migrate();
  const root = mkdtempSync(join(tmpdir(), 'nova-person-'));
  const ws = new Workspace(join(root, 'workspace'));
  let release: () => void = () => {};
  const asked = new Promise<void>((r) => { release = r; });
  let ledger!: Ledger;
  const worker: Worker = {
    id: 'hands', name: 'Hands', about: 'test', egress: 'none', evidence: ['read_back'], health: () => ({ ok: true }),
    run: async (b) => {
      ledger.needsPerson(b.task_id, 'Needs you: sign in.');
      await asked;
      ledger.note(b.task_id, 'takeover_ended', { by: 'console', duration_ms: 5 });
      ledger.personDone(b.task_id, 'You handed back.');
      return { envelope: ENVELOPE_VERSION, task_id: b.task_id, status: 'failed', summary: 'stopped here', evidence: [], artifacts: [], blockers: [], usage: { duration_ms: 1 }, follow_up_suggestions: [] };
    },
  };
  ledger = new Ledger({ db, log: new Log(db, null), verifier: new Verifier(ws), workers: [worker], defaultPrivacy: () => 'local-only' });
  const t = ledger.create({ title: 'Sign in somewhere', owner: 'hands', goal: 'Signed in.', origin: { kind: 'user' }, evidence_required: [{ kind: 'read_back', target: 'x' }] });
  for (let i = 0; i < 50 && ledger.get(t.id).state !== 'waiting'; i++) await new Promise((r) => setTimeout(r, 5));
  const waiting = ledger.get(t.id);
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.user_visibility, 'attention');
  assert.equal(waiting.reason, 'Needs you: sign in.');
  assert.throws(() => ledger.retry(t.id), /still running: it is waiting for you to do a step/);
  release();
  await ledger.idle();
  const kinds = ledger.events(t.id).map((e) => e.kind);
  assert.deepEqual(kinds, ['created', 'dispatched', 'needs_person', 'takeover_ended', 'person_done', 'reported', 'failed']);
  assert.throws(() => ledger.needsPerson(t.id, 'again'), /Only a running task can ask for you/);
});

test('ledger: after a restart, a task that waited for the person starts again from the beginning', () => {
  const db = new Db(':memory:');
  db.migrate();
  const ws = new Workspace(join(mkdtempSync(join(tmpdir(), 'nova-person-')), 'workspace'));
  const hang: Worker = { id: 'hands', name: 'Hands', about: 'test', egress: 'none', evidence: ['read_back'], health: () => ({ ok: true }), run: () => new Promise(() => {}) };
  const make = () => new Ledger({ db, log: new Log(db, null), verifier: new Verifier(ws), workers: [hang], defaultPrivacy: () => 'local-only' });
  const first = make();
  const t = first.create({ title: 'Sign in somewhere', owner: 'hands', goal: 'Signed in.', origin: { kind: 'user' }, evidence_required: [{ kind: 'read_back', target: 'x' }] });
  // As the running worker would have, before the process went away.
  db.run(`UPDATE task SET state = 'waiting', reason = 'Needs you: sign in.', attempts = 1 WHERE id = ?`, t.id);
  db.run(`INSERT INTO task_event (task_id, at, kind, from_state, to_state, detail) VALUES (?, ?, 'needs_person', 'active', 'waiting', NULL)`, t.id, new Date().toISOString());
  db.run(`INSERT INTO task_event (task_id, at, kind, from_state, to_state, detail) VALUES (?, ?, 'takeover_started', NULL, NULL, NULL)`, t.id, new Date().toISOString());
  const second = make();
  const r = second.recover();
  assert.ok(r.requeued.includes(t.id));
  assert.match((second.events(t.id).find((e) => e.kind === 'recovered')!.detail as { reason: string }).reason, /restarted while this waited for you/);
});

// ---- inside the core -------------------------------------------------------------------------

const plan = (host = '127.0.0.1:4321') => ({ allowed_hosts: [host], steps: [{ do: 'navigate', url: `http://${host}/start` }], verify: { expect: ['Received'] } });
const task = (inputs: unknown) => ({ title: 'Sign up', owner: 'browser', goal: 'Signed up.', evidence_required: [{ kind: 'screenshot' }, { kind: 'url' }], inputs });

test('core: with no Chromium, browser work says so plainly; bad plans and remote hosts are refused when delegated', async () => {
  const saved = process.env.NOVA_CHROMIUM;
  process.env.NOVA_CHROMIUM = '/nonexistent/chromium';
  const h = await hub({ mesh: false });
  try {
    const health = (await h.c('GET', '/health')).body;
    assert.equal(health.checks.browser.available, false);
    assert.match(health.checks.browser.detail, /NOVA_CHROMIUM names \/nonexistent\/chromium/);
    const w = (await h.c('GET', '/workers')).body.find((x: { id: string }) => x.id === 'browser');
    assert.deepEqual([w.egress, w.evidence], ['remote', ['screenshot', 'url']]);

    assert.equal((await h.c('PUT', '/profile/privacy/default', { value: 'local-only' })).status, 200);
    const bad = await h.c('POST', '/tasks', task({ allowed_hosts: ['127.0.0.1:4321'], steps: [{ do: 'navigate', url: 'http://elsewhere.example.test/' }] }));
    assert.equal(bad.status, 400);
    assert.match(bad.body.details.join(' '), /outside the allowed hosts/);
    const remote = await h.c('POST', '/tasks', task(plan('example.test')));
    assert.equal(remote.status, 400);
    assert.match(remote.body.error, /Browser sends data off your devices, and this task is local-only/);

    const r = await h.c('POST', '/tasks', task(plan()));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await h.core.ledger.idle();
    const t = (await h.c('GET', `/tasks/${r.body.id}`)).body;
    assert.equal(t.state, 'failed');
    assert.match(t.reason, /NOVA_CHROMIUM names \/nonexistent\/chromium, and there is no runnable browser there/);
    assert.equal((await h.c('GET', `/browser/tasks/${t.id}`)).body.live, false);
    assert.equal((await h.c('POST', `/browser/tasks/${t.id}/takeover`)).status, 404);
    assert.match((await h.c('GET', `/browser/tasks/${t.id}/screenshot`)).body.error, /no screenshot/);
  } finally {
    if (saved === undefined) delete process.env.NOVA_CHROMIUM; else process.env.NOVA_CHROMIUM = saved;
    await h.stop();
  }
});

test('core: only the console and devices allowed to approve may take over, drive or hand back', async () => {
  const h = await hub();
  try {
    const { token } = await enroll(h, { name: 'Example phone', kind: 'phone' });
    const phone = (method: string, path: string, body?: unknown) => fetch(`${h.mesh}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-nova': '1' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await phone('GET', '/browser/tasks/some-task')).status, 200, 'a phone may watch');
    for (const action of ['takeover', 'input', 'handback']) {
      const r = await phone('POST', `/browser/tasks/some-task/${action}`, { type: 'key', key: 'Enter' });
      assert.equal(r.status, 403, action);
      assert.match((await r.json()).error, /Only the hub’s own screen, or a device you’ve allowed to approve/);
    }
    assert.equal((await h.c('POST', '/browser/tasks/some-task/takeover')).status, 404, 'the console gets past the door, and is told there is no browser');
  } finally {
    await h.stop();
  }
});

// ---- the local form site ---------------------------------------------------------------------

test('form site: the form, the step only a person can do, and the record Nova checks against', async () => {
  const site = await startFormSite();
  const go = async (path: string, form?: Record<string, string>) => {
    const r = await fetch(site.url + path, { method: form ? 'POST' : 'GET', redirect: 'manual', ...(form ? { body: new URLSearchParams(form), headers: { 'content-type': 'application/x-www-form-urlencoded' } } : {}) });
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  };
  try {
    const start = await go('/start');
    assert.equal(start.status, 303);
    const base = start.location!.replace(/\/details$/, '');
    assert.match((await go(`${base}/details`)).text, /id="name"/);
    assert.equal((await go(`${base}/details`, { name: 'Ada Example', email: 'ada@example.test' })).location, `${base}/check`);
    const check = await go(`${base}/check`);
    assert.match(check.text, /A person must do this step/);
    const [draft] = site.drafts();
    assert.equal(check.text.includes(`>${draft!.code}<`), false, 'the code is drawn letter by letter, not written out');
    assert.equal((await go(`${base}/plan`)).location, `${base}/check`, 'no skipping the person’s step');
    assert.equal((await go(`${base}/check`, { code: 'WRONG' })).location, `${base}/check?wrong=1`);
    assert.equal((await go(`${base}/check`, { code: draft!.code.toLowerCase() })).location, `${base}/plan`);
    await go(`${base}/plan`, { plan: 'plus', note: 'Mornings.' });
    const sent = await go(`${base}/submit`, {});
    assert.match(sent.location!, /^\/done\/R-[0-9a-f]{8}$/);
    assert.match((await go(sent.location!)).text, /Received[\s\S]*Ada Example[\s\S]*Checked by a person<\/dt><dd id="done-person">Yes/);
    const records = JSON.parse((await go('/records')).text);
    assert.deepEqual(records.map((r: any) => [r.name, r.email, r.plan, r.person_checked]), [['Ada Example', 'ada@example.test', 'plus', true]]);
    assert.match((await go('/leaky')).text, new RegExp(`http://localhost:${site.port}/pixel\\.png`));
  } finally {
    await site.close();
  }
});
