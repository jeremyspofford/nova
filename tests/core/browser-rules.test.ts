// Browser plans after the M5 review, without a browser: what a plan may change outside (it never
// reruns by itself once it typed, chose, clicked or handed the page to the person), which plans ask
// first (filling in and sending a form is tier 2), which plans can be proven done at all (a `url`
// requirement needs `verify.expect`; a plan with outside effects needs `url` evidence on a page the
// plan names, `verify.url`), how the `url` checker weighs Nova's own re-fetch against the page's
// DOM, and what counts as a local host (only addresses, never a name that merely sounds local).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser } from '../../src/core/browser/worker.ts';
import { checkers, taskDir } from '../../src/core/browser/evidence.ts';
import { hostEgress } from '../../src/core/browser/plan.ts';
import { Db } from '../../src/core/db.ts';
import { Log } from '../../src/core/log.ts';
import { ENVELOPE_VERSION, type Brief } from '../../src/core/envelope.ts';
import { hub } from './mesh-support.ts';

const SITE = '127.0.0.1:4321';
const nav = { do: 'navigate', url: `http://${SITE}/start` };
const read = { do: 'read', selector: '#status' };
const form = (over: Record<string, unknown> = {}) => ({
  allowed_hosts: [SITE],
  steps: [nav, { do: 'fill', selector: '#name', value: 'Ada Example' }, { do: 'click', selector: '#submit' }, read],
  verify: { url: `http://${SITE}/records`, expect: ['Ada Example'] },
  ...over,
});
const brief = (inputs: unknown, evidence = [{ kind: 'screenshot' }, { kind: 'url' }]): Brief => ({
  envelope: ENVELOPE_VERSION, task_id: 'task-1', goal: 'Sign up.', context_refs: [], constraints: {}, privacy_mode: 'local-only', approval_tier: 1,
  evidence_required: evidence as Brief['evidence_required'], idempotency_key: 'k', inputs: inputs as Record<string, unknown>,
});

function worker() {
  const db = new Db(':memory:');
  db.migrate();
  return new Browser({ home: mkdtempSync(join(tmpdir(), 'nova-rules-')), log: new Log(db, null) }).worker;
}

test('effects: a plan that types, chooses, clicks or hands the page to the person is external; one that only looks is not', () => {
  const w = worker();
  assert.equal(w.effects!(brief({ allowed_hosts: [SITE], steps: [nav, read], verify: { expect: ['x'] } })), 'none');
  assert.equal(w.effects!(brief(form())), 'external');
  assert.equal(w.effects!(brief({ ...form(), steps: [nav, { do: 'person', why: 'Sign in.' }, read] })), 'external');
  assert.equal(w.effects!(brief({ ...form(), steps: [nav, { do: 'select', selector: '#plan', value: 'plus' }] })), 'external');
  assert.equal(w.commits!(brief(form())), false);
  assert.equal(w.commits!(brief({ ...form(), steps: [nav, { do: 'fill', selector: '#name', value: 'Ada' }, { do: 'click', selector: '#submit', commits: true }] })), true);
});

test('tiers: filling in and sending a form asks first; looking, or a step only you do, doesn’t', async () => {
  const w = worker();
  assert.equal(w.minTier!({ inputs: form(), evidence_required: [{ kind: 'url' }] }), 2);
  assert.equal(w.minTier!({ inputs: { ...form(), steps: [nav, { do: 'select', selector: '#plan', value: 'plus' }] }, evidence_required: [{ kind: 'url' }] }), 2);
  assert.equal(w.minTier!({ inputs: { allowed_hosts: [SITE], steps: [nav, read] }, evidence_required: [{ kind: 'url' }] }), 0);
  assert.equal(w.minTier!({ inputs: { ...form(), steps: [nav, { do: 'person', why: 'Sign in.' }] }, evidence_required: [{ kind: 'url' }] }), 0);

  const h = await hub({ mesh: false });
  try {
    const task = (inputs: unknown) => ({ title: 'Sign up', owner: 'browser', goal: 'Signed up.', evidence_required: [{ kind: 'screenshot' }, { kind: 'url' }], inputs });
    const r = await h.c('POST', '/tasks', task(form()));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.approval_tier, r.body.state, r.body.reason], [2, 'waiting', 'Needs your OK before it runs.']);
  } finally {
    await h.stop();
  }
});

test('provable: a url requirement needs verify.expect; a plan with outside effects needs url evidence on a page it names', async () => {
  const saved = process.env.NOVA_CHROMIUM;
  process.env.NOVA_CHROMIUM = '/nonexistent/chromium';
  const h = await hub({ mesh: false });
  try {
    const task = (inputs: unknown, evidence = [{ kind: 'screenshot' }, { kind: 'url' }]) => ({ title: 'Sign up', owner: 'browser', goal: 'Signed up.', evidence_required: evidence, inputs });
    const refused = async (body: unknown, why: RegExp) => {
      const r = await h.c('POST', '/tasks', body);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.details.join(' '), why);
    };
    await refused(task({ allowed_hosts: [SITE], steps: [nav, read] }), /url requirement can’t be proven without inputs\.verify\.expect/);
    await refused(task(form(), [{ kind: 'screenshot' }]), /add \{kind: "url"\} to evidence_required: a screenshot alone can’t show it happened/);
    await refused(task(form({ verify: { expect: ['Ada Example'] } })), /inputs\.verify\.url must name the page that shows it happened/);
    await refused(task(form({ verify: undefined })), /inputs\.verify\.url must name the page/);
    // Looking only: a screenshot is enough, and so is the page it ends on.
    assert.equal((await h.c('POST', '/tasks', task({ allowed_hosts: [SITE], steps: [nav, read] }, [{ kind: 'screenshot' }]))).status, 201);
    assert.equal((await h.c('POST', '/tasks', task({ allowed_hosts: [SITE], steps: [nav, read], verify: { expect: ['Welcome'] } }))).status, 201);
    assert.equal((await h.c('POST', '/tasks', task(form()))).status, 201);
  } finally {
    if (saved === undefined) delete process.env.NOVA_CHROMIUM; else process.env.NOVA_CHROMIUM = saved;
    await h.stop();
  }
});

test('the url checker: Nova’s own re-fetch decides when there is one; a page with outside effects can’t prove itself', () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-rules-ev-'));
  const { url } = checkers(home);
  mkdirSync(taskDir(home, 'task-1'), { recursive: true });
  const write = (u: string, reads: unknown[]) => writeFileSync(join(taskDir(home, 'task-1'), 'final-read.json'), JSON.stringify({ task_id: 'task-1', url: u, final_url: u, at: 'now', reads }));
  const looking = brief({ allowed_hosts: [SITE], steps: [nav, read], verify: { expect: ['Received'] } });
  const done = `http://${SITE}/done/R-1`;

  // The page's own view says one thing; Nova's fetch of the same page says another: the fetch wins.
  write(done, [{ source: 'fetch', url: done, status: 200, text: 'Please sign in' }, { source: 'dom', url: done, text: 'Received' }]);
  const r = url({ kind: 'url', url: done }, looking);
  assert.equal(r.ok, false, r.why);
  assert.match(r.why, /fetched .* again itself .*doesn’t show “Received”/);
  // With no fetch to be had, a page that only looked may stand on its fresh DOM read.
  write(done, [{ source: 'fetch', url: done, text: '', error: 'refused' }, { source: 'dom', url: done, text: 'Received' }]);
  assert.equal(url({ kind: 'url', url: done }, looking).ok, true);

  // A plan with outside effects: only a fetch of the page the plan named.
  const sending = brief(form());
  const records = `http://${SITE}/records`;
  write(records, [{ source: 'fetch', url: records, text: '', error: 'refused' }, { source: 'dom', url: records, text: 'Ada Example' }]);
  assert.match(url({ kind: 'url', url: records }, sending).why, /couldn’t fetch .* again itself, and a page that sent something can’t vouch for itself/);
  write(done, [{ source: 'fetch', url: done, status: 200, text: 'Ada Example' }]);
  assert.match(url({ kind: 'url', url: done }, sending).why, /the page the plan named, http:\/\/127\.0\.0\.1:4321\/records; not .*done/);
  write(records, [{ source: 'fetch', url: records, status: 200, text: '[{"name":"Ada Example"}]' }]);
  assert.equal(url({ kind: 'url', url: records }, sending).ok, true);
});

test('local: only addresses on this network count; a name that sounds local proves nothing', () => {
  for (const h of ['printer.local', 'nas.home.arpa', 'router.local:80', '*.home.arpa']) assert.equal(hostEgress(h), 'remote', h);
  for (const h of ['localhost', 'app.localhost', '127.0.0.1:4321', '192.168.1.20', '[::1]:80', '[fd00::1]']) assert.equal(hostEgress(h), 'local', h);
});
