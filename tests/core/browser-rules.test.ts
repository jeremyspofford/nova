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
