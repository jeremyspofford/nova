// The worker never acts on a page someone has taken over (M5 review, minor 6). It used to check
// for a takeover, then make the three CDP calls that act (find the frame, make Nova's own world,
// evaluate), so a takeover that began between the check and the last call still saw the worker
// click. Here a stand-in browser speaks just enough CDP for the worker to run a plan, and starts a
// takeover at the worst moment: while Nova's world is being made for the click. The click must
// wait for the hand-back. No Chromium needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { Cdp, type Transport } from '../../src/core/browser/cdp.ts';
import { Browser } from '../../src/core/browser/worker.ts';
import type { Launched } from '../../src/core/browser/chromium.ts';
import { Db } from '../../src/core/db.ts';
import { Log } from '../../src/core/log.ts';
import { ENVELOPE_VERSION, type Brief } from '../../src/core/envelope.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex').toString('base64');

// A browser that answers what the worker asks; `on(method)` lets the test step in before an answer.
function standIn(hook: (method: string, params: Record<string, unknown>) => Promise<void> | void) {
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
