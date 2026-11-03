// The worker never acts on a page someone has taken over (M5 review, minor 6). It used to check
// for a takeover, then make the three CDP calls that act (find the frame, make Nova's own world,
// evaluate), so a takeover that began between the check and the last call still saw the worker
// click. Here a stand-in browser speaks just enough CDP for the worker to run a plan, and starts a
// takeover at the worst moment: while Nova's world is being made for the click. The click must
// wait for the hand-back. No Chromium needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { Cdp, type Transport } from '../../src/core/browser/cdp.ts';
import { Browser } from '../../src/core/browser/worker.ts';
import { Session } from '../../src/core/browser/session.ts';
import type { Launched } from '../../src/core/browser/chromium.ts';
import { Db } from '../../src/core/db.ts';
import { Log } from '../../src/core/log.ts';
import { ENVELOPE_VERSION, type Brief } from '../../src/core/envelope.ts';
import { createCore } from '../../src/core/index.ts';
import { until } from './connector-support.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex').toString('base64');

// A browser that answers what the worker asks; `on(method)` lets the test step in before an answer.
function standIn(hook: (method: string, params: Record<string, unknown>) => Promise<void> | void, rejectMethod?: string) {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  let data: (c: string) => void = () => {};
  let closed: (why: string) => void = () => {};
  const reply = (m: Record<string, unknown>) => setImmediate(() => data(`${JSON.stringify(m)}\0`));
  const answer = (method: string, params: Record<string, unknown>): unknown => {
    switch (method) {
      case 'Page.getFrameTree': return { frameTree: { frame: { id: 'F' } } };
      case 'Page.createIsolatedWorld': return { executionContextId: 7 };
      case 'Page.navigate': return { frameId: 'F' };
      case 'Page.captureScreenshot': return { data: PNG };
      case 'Runtime.evaluate': {
        const e = String(params.expression);
        if (e === 'document.readyState') return { result: { value: 'complete' } };
        if (e.startsWith('!!document.querySelector')) return { result: { value: true } };
        if (e.startsWith('document.body')) return { result: { value: 'Received' } };
        return { result: { value: 'ok' } };
      }
      default: return {};
    }
  };
  const t: Transport = {
    send: (raw) => {
      const m = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
      sent.push({ method: m.method, params: m.params });
      void (async () => {
        await hook(m.method, m.params);
        if (m.method === rejectMethod && !m.sessionId) {
          reply({ id: m.id, error: { message: 'fixture initialization failed' } });
          return;
        }
        reply({ id: m.id, result: answer(m.method, m.params), ...(m.sessionId ? { sessionId: m.sessionId } : {}) });
        // The first page shows up once auto-attach is on.
        if (m.method === 'Target.setAutoAttach' && !m.sessionId) {
          reply({ method: 'Target.attachedToTarget', params: { sessionId: 'P', targetInfo: { targetId: 'T', type: 'page' }, waitingForDebugger: false } });
        }
      })();
    },
    onData: (fn) => { data = fn as (c: string) => void; },
    onClose: (fn) => { closed = fn; },
    close: () => closed('closed by Nova'),
  };
  const launch = async (): Promise<Launched> => {
    const cdp = new Cdp(t);
    return { cdp, proc: {} as ChildProcess, profile: '', stderr: () => '', close: async () => cdp.close() };
  };
  return { sent, launch };
}

test('a takeover that starts while the worker gets ready to click: the click waits for the hand-back', async () => {
  let s!: ReturnType<Browser['sessions']['get']>;
  let browser!: Browser;
  let armed = false;
  let handed = false;
  let looks = 0;
  const fake = standIn(async (method, params) => {
    // The plan looks for #send twice (the wait step, then the click step finding its element);
    // the world made right after the second look is the click's own: the person takes over now.
    if (method === 'Runtime.evaluate' && String(params.expression) === '!!document.querySelector("#send")' && ++looks === 2) armed = true;
    if (method === 'Page.createIsolatedWorld' && armed && !handed) {
      armed = false;
      s = browser.sessions.get('task-act-1')!;
      browser.takeOver('task-act-1', { key: 'console', label: 'The hub’s own screen' });
      setTimeout(() => {
        handed = true;
        clicksWhileHeld = fake.sent.filter((x) => x.method === 'Runtime.evaluate' && String(x.params.expression).includes('el.click()')).length;
        browser.handBack('task-act-1', { key: 'console', label: 'The hub’s own screen' });
      }, 300);
    }
  });
  let clicksWhileHeld = -1;
  const db = new Db(':memory:');
  db.migrate();
  browser = new Browser({ home: mkdtempSync(join(tmpdir(), 'nova-act-')), log: new Log(db, null), env: { NOVA_CHROMIUM: process.execPath }, launch: fake.launch });
  const brief: Brief = {
    envelope: ENVELOPE_VERSION, task_id: 'task-act-1', goal: 'Send it.', context_refs: [], constraints: {}, privacy_mode: 'local-only', approval_tier: 2,
    evidence_required: [{ kind: 'url' }], idempotency_key: 'k',
    inputs: { allowed_hosts: ['127.0.0.1:4321'], steps: [{ do: 'navigate', url: 'http://127.0.0.1:4321/form' }, { do: 'wait', selector: '#send' }, { do: 'click', selector: '#send' }], verify: { url: 'http://127.0.0.1:4321/records', expect: ['Received'] } },
  };
  const run = browser.worker.run(brief, new AbortController().signal);
  const report = (await run) as { status: string; summary: string };
  assert.equal(report.status, 'done', report.summary);
  assert.equal(clicksWhileHeld, 0, 'nothing was clicked while the person held the browser');
  assert.equal(fake.sent.filter((x) => x.method === 'Runtime.evaluate' && String(x.params.expression).includes('el.click()')).length, 1, 'the click happened once, after the hand-back');
  assert.ok(s, 'the takeover happened mid-step');
  await browser.close();
});

// ---- a device that may no longer hold the browser (M5 review, minor 7) ---------------------------

test('a device that is revoked, or may no longer approve, loses the browser at once; the step waits for someone else', async () => {
  const saved = process.env.NOVA_CHROMIUM;
  process.env.NOVA_CHROMIUM = process.execPath;
  const fake = standIn(() => {});
  const core = createCore({ home: mkdtempSync(join(tmpdir(), 'nova-release-')), version: '0.1.0', trustedOrigin: () => true, browserLaunch: fake.launch });
  try {
    const ended: { by: string; how: string }[] = [];
    core.ledger.on('note', (n: { kind: string; detail: { by: string; how: string } }) => { if (n.kind === 'takeover_ended') ended.push(n.detail); });
    const t = core.ledger.create({
      title: 'Sign in on the example site', owner: 'browser', goal: 'Signed in.', origin: { kind: 'user' }, evidence_required: [{ kind: 'url' }],
      inputs: { allowed_hosts: ['127.0.0.1:4321'], steps: [{ do: 'navigate', url: 'http://127.0.0.1:4321/' }, { do: 'person', why: 'Sign in.' }], verify: { url: 'http://127.0.0.1:4321/account', expect: ['Received'] } },
    });
    await until(() => core.browser.view(t.id), (v) => 'mode' in v && v.mode === 'needs_person');
    const phone = { key: 'device:phone-1', label: 'Example phone' };
    for (const [event, detail] of [['revoked', { id: 'phone-1' }], ['change', { action: 'can_approve', device: { id: 'phone-1', can_approve: false } }]] as const) {
      core.browser.takeOver(t.id, phone);
      assert.equal((core.browser.view(t.id) as { holder: { key: string } }).holder.key, 'device:phone-1');
      core.mesh.devices.emit(event, detail);
      const v = core.browser.view(t.id) as { mode: string; holder: unknown; asked: string };
      assert.deepEqual([v.mode, v.holder, v.asked], ['needs_person', null, 'Sign in.'], event);
      assert.match(ended.at(-1)!.how, event === 'revoked' ? /its device was removed/ : /its device may no longer take over/);
    }
    // Someone who still may can carry on.
    core.browser.takeOver(t.id, { key: 'console', label: 'The hub’s own screen' });
    core.browser.handBack(t.id, { key: 'console', label: 'The hub’s own screen' });
    await until(() => core.browser.view(t.id).live, (live) => !live);
    assert.ok(core.ledger.events(t.id).some((e) => e.kind === 'person_done'), 'the worker carried on past the step');
  } finally {
    if (saved === undefined) delete process.env.NOVA_CHROMIUM; else process.env.NOVA_CHROMIUM = saved;
    await core.close();
  }
});

// A closed mode revokes interaction immediately, but every close caller must still await
// the launched browser's cleanup (including a close that starts from a lost CDP connection).
for (const first of ['caller', 'transport'] as const) {
  test(`session close waits for profile cleanup after ${first} starts closing`, async () => {
    const fake = standIn(() => {});
    const profile = mkdtempSync(join(tmpdir(), 'nova-close-profile-'));
    const cleanup = Promise.withResolvers<void>();
    let launched!: Launched;
    let closes = 0;
    const session = new Session({
      taskId: 'task-close-1', chromium: process.execPath, hosts: [], sandbox: false,
      launch: async () => {
        launched = await fake.launch();
        return { ...launched, profile, close: async () => {
          closes++;
          await cleanup.promise;
          await launched.close();
          rmSync(profile, { recursive: true, force: true });
        } };
      },
    });
    let initial: Promise<void> | undefined;
    let reentrant: Promise<void> | undefined;
    session.once('closed', () => { reentrant = session.close(); });
    try {
      await session.open();
      if (first === 'caller') initial = session.close();
      else launched.cdp.close();
      const repeated = session.close();
      let completed = false;
      void Promise.all([reentrant, repeated]).then(() => { completed = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(session.mode, 'closed', 'interaction is revoked before cleanup finishes');
      assert.equal(existsSync(profile), true, 'the fixture holds physical cleanup pending');
      assert.equal(completed, false, 'reentrant and repeated close must await physical cleanup');
      cleanup.resolve();
      await Promise.all([initial, reentrant, repeated]);
      assert.equal(existsSync(profile), false, 'every close promise observes profile removal');
      assert.equal(closes, 1, 'one physical cleanup owns the session');
    } finally {
      cleanup.resolve();
      await initial;
      await session.close();
      rmSync(profile, { recursive: true, force: true });
    }
  });
}


// Reclaim the owned listening address: a connect error is not a reliable close oracle
// on every developer network, but a still-listening refuser prevents this bind.
async function assertRefuserClosed(address: string): Promise<void> {
  const url = new URL(address);
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(url.port), url.hostname, resolve);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('close during launch retains cleanup ownership and never restores working mode', async () => {
  const fake = standIn(() => {});
  const entered = Promise.withResolvers<void>();
  const launching = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>();
  const releaseCleanup = Promise.withResolvers<void>();
  const profile = mkdtempSync(join(tmpdir(), 'nova-launch-close-'));
  const launched = await fake.launch();
  let physicalCloses = 0;
  let refuser = '';
  const session = new Session({
    taskId: 'task-launch-close', chromium: process.execPath, hosts: [], sandbox: false,
    launch: async (options) => {
      refuser = options.refuser;
      entered.resolve();
      await launching.promise;
      return { ...launched, profile, close: async () => {
        physicalCloses++;
        cleaning.resolve();
        await releaseCleanup.promise;
        await launched.close();
        rmSync(profile, { recursive: true, force: true });
      } };
    },
  });
  const opening = session.open().then(() => null, (error: unknown) => error);
  let closing: Promise<void> | undefined;
  try {
    await entered.promise;
    closing = session.close('aborted while launching');
    assert.equal(session.mode, 'closed', 'authority is revoked synchronously');
    let completed = false;
    void closing.then(() => { completed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(completed, false, 'close retains the resource handoff from pending launch');
    launching.resolve();
    await cleaning.promise;
    assert.equal(completed, false, 'close also waits for late browser cleanup');
    assert.equal(existsSync(profile), true);
    await assert.rejects(assertRefuserClosed(refuser), { code: 'EADDRINUSE' }, 'the refuser is still owned during browser cleanup');
    releaseCleanup.resolve();
    assert.match(String(await opening), /closed.*starting/i, 'open cannot succeed after closure');
    await closing;
    await session.close('worker finally');
    assert.equal(session.mode, 'closed');
    assert.equal(physicalCloses, 1);
    assert.equal(launched.cdp.closed, true);
    assert.equal(existsSync(profile), false);
    await assertRefuserClosed(refuser);
  } finally {
    launching.resolve();
    releaseCleanup.resolve();
    await opening;
    await closing;
    await session.close();
    await launched.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('open failure after acquiring the browser waits for cleanup without a circular close wait', async () => {
  const fake = standIn(() => {}, 'Target.setAutoAttach');
  const profile = mkdtempSync(join(tmpdir(), 'nova-open-failure-'));
  const launched = await fake.launch();
  let physicalCloses = 0;
  let refuser = '';
  const session = new Session({
    taskId: 'task-open-failure', chromium: process.execPath, hosts: [], sandbox: false,
    launch: async (options) => {
      refuser = options.refuser;
      return { ...launched, profile, close: async () => {
        physicalCloses++;
        await launched.close();
        rmSync(profile, { recursive: true, force: true });
      } };
    },
  });
  try {
    await assert.rejects(session.open(), /fixture initialization failed/);
    assert.equal(session.mode, 'closed', 'failed initialization closes the session');
    assert.equal(physicalCloses, 1, 'open failure owns cleanup before returning');
    assert.equal(launched.cdp.closed, true);
    assert.equal(existsSync(profile), false);
    await assertRefuserClosed(refuser);
    await session.close();
    assert.equal(physicalCloses, 1, 'later close shares the completed cleanup');
  } finally {
    await session.close();
    await launched.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('worker abort during launch retains its session until the late browser is physically closed', async () => {
  const fake = standIn(() => {});
  const launched = await fake.launch();
  const entered = Promise.withResolvers<void>();
  const launching = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>();
  const releaseCleanup = Promise.withResolvers<void>();
  let physicalCloses = 0;
  const home = mkdtempSync(join(tmpdir(), 'nova-worker-launch-close-'));
  const db = new Db(':memory:');
  db.migrate();
  const browser = new Browser({ home, log: new Log(db, null), env: { NOVA_CHROMIUM: process.execPath }, launch: async () => {
    entered.resolve();
    await launching.promise;
    return { ...launched, close: async () => {
      physicalCloses++;
      cleaning.resolve();
      await releaseCleanup.promise;
      await launched.close();
    } };
  } });
  const controller = new AbortController();
  const reason = new Error('fixture abort during launch');
  const brief: Brief = {
    envelope: ENVELOPE_VERSION, task_id: 'task-worker-launch-close', goal: 'Look at the fixture.', context_refs: [], constraints: {}, privacy_mode: 'local-only', approval_tier: 0,
    evidence_required: [{ kind: 'url' }], idempotency_key: 'launch-close',
    inputs: { allowed_hosts: ['127.0.0.1:4321'], steps: [{ do: 'navigate', url: 'http://127.0.0.1:4321/' }], verify: { url: 'http://127.0.0.1:4321/', expect: ['Received'] } },
  };
  const running = Promise.resolve(browser.worker.run(brief, controller.signal)).then(() => null, (error: unknown) => error);
  try {
    await entered.promise;
    const session = browser.sessions.get(brief.task_id)!;
    controller.abort(reason);
    assert.equal(session.mode, 'closed');
    launching.resolve();
    await cleaning.promise;
    assert.equal(browser.sessions.get(brief.task_id), session, 'worker ownership survives pending physical cleanup');
    releaseCleanup.resolve();
    assert.equal(await running, reason, 'the original abort is preserved');
    assert.equal(browser.sessions.has(brief.task_id), false, 'ownership is released after physical cleanup');
    assert.equal(session.mode, 'closed');
    assert.equal(physicalCloses, 1);
    assert.equal(launched.cdp.closed, true);
  } finally {
    launching.resolve();
    releaseCleanup.resolve();
    await running;
    await browser.close();
    await launched.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});


test('launch rejection after close still releases the acquired refuser', async () => {
  const entered = Promise.withResolvers<void>();
  const launching = Promise.withResolvers<Launched>();
  const failure = new Error('fixture launch failed');
  let refuser = '';
  const session = new Session({
    taskId: 'task-launch-failure', chromium: process.execPath, hosts: [], sandbox: false,
    launch: async (options) => {
      refuser = options.refuser;
      entered.resolve();
      return launching.promise;
    },
  });
  const opening = session.open().then(() => null, (error: unknown) => error);
  try {
    await entered.promise;
    const closing = session.close();
    launching.reject(failure);
    assert.equal(await opening, failure, 'launch failure survives cleanup');
    await closing;
    assert.equal(session.mode, 'closed');
    await assertRefuserClosed(refuser);
  } finally {
    launching.reject(failure);
    await opening;
    await session.close();
  }
});
