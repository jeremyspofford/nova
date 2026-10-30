// M5 gate, part 1 (ROADMAP-AND-GATES): the same brief executed by two different providers through
// the envelope, with the evidence verified for both. The other part, takeover and hand-back
// mid-task, is tests/ui/m5c-takeover.test.ts (it needs Chromium).
//
// The real server as its own process with the egress tripwire. The same brief ("make the failing
// test in calc/ pass") goes to a coding agent (Claude Code's stand-in, speaking its stream-json and
// really editing files) and to a chat model (an OpenAI-compatible stand-in answering in the JSON
// files contract). For each, Nova runs the test itself, checks the diff, and only then copies the
// result back. A provider that claims success without doing the work fails with the verifier's
// reason, for each class. Each call has a receipt with that provider's egress, and a local-only
// task refuses the remote one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blank, stop, until } from './support.ts';
import { filesReply, startFakeOpenAI } from '../../scripts/stand-ins/fake-openai.js';
import { BROKEN_SUM, FAKE_CLAUDE, FIXED_SUM, calcTask, script, writeCalc } from '../support/providers.ts';

test('M5 gate: one brief, two providers (a coding agent and a chat model), evidence verified by Nova for both', { timeout: 120_000 }, async () => {
  const m = blank('nova-m5-gate-');
  // The chat model's answer: honest (the real fix) unless told to lie.
  let honest = true;
  const model = await startFakeOpenAI({
    model: 'example-coder',
    reply: () => (honest ? filesReply([{ path: 'calc/sum.mjs', content: FIXED_SUM }], 'sum subtracted; it adds now.') : filesReply([], 'Fixed it, the test passes.')),
  });
  const nova = await m.start();
  const api = (p: string) => `/api/v1${p}`;
  const settled = (id: string) => until<any>(() => m.get(api(`/tasks/${id}`)), (t) => ['done', 'failed', 'cancelled'].includes(t.state) || (t.state === 'waiting' && /OK/.test(t.reason ?? '')), 800);
  const sum = () => readFileSync(join(m.home, 'workspace', 'calc', 'sum.mjs'), 'utf8');
  // Submit the brief to a provider, give the OK the test command needs, and wait for the end.
  const run = async (owner: string, over: Record<string, unknown> = {}) => {
    const created = await m.send('POST', api('/tasks'), calcTask(owner, over));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const asking = await settled(created.body.id);
    assert.equal(asking.state, 'waiting', 'Nova asks before it runs the brief’s test command');
    assert.equal((await m.send('POST', api(`/tasks/${created.body.id}/approve`), {})).status, 200);
    return until<any>(() => m.get(api(`/tasks/${created.body.id}`)), (t) => ['done', 'failed', 'cancelled'].includes(t.state), 800);
  };
  try {
    writeCalc(join(m.home, 'workspace'));
    await m.send('PUT', api('/profile/privacy/default'), { value: 'cloud-allowed' });

    // Two providers of different classes, set up and turned on (tier 2).
    assert.equal((await m.send('PUT', api('/providers/claude-code/config'), { config: { command: `node ${FAKE_CLAUDE} --script ${script('honest')}` } })).status, 200);
    assert.equal((await m.send('POST', api('/providers/claude-code/enable'), { approved: true })).body.enabled, true);
    assert.equal((await m.send('PUT', api('/providers/openai-compatible/config'), { config: { base_url: model.url, model: 'example-coder' } })).status, 200);
    assert.equal((await m.send('POST', api('/providers/openai-compatible/enable'), { approved: true })).body.enabled, true);

    const results: Record<string, any> = {};
    for (const owner of ['claude-code', 'openai-compatible']) {
      writeCalc(join(m.home, 'workspace')); // the same starting point for each
      assert.equal(sum(), BROKEN_SUM);
      const t = await run(owner);
      assert.equal(t.state, 'done', `${owner}: ${t.reason}`);
      assert.equal(t.owner, owner);
      assert.ok(t.verification.ok, `${owner}: verified`);
      const kinds = t.verification.checks.map((c: { requirement: { kind: string } }) => c.requirement.kind).sort();
      assert.deepEqual(kinds, ['file_diff', 'test_result'], `${owner}: both checks, Nova’s own`);
      assert.ok(t.verification.checks.every((c: { ok: boolean }) => c.ok));
      assert.equal(sum(), FIXED_SUM, `${owner}: the fix was copied back after verification`);
      results[owner] = t;
    }

    // The receipts say who each call went to and where the data went.
    const egress = async (id: string) => (await m.get(api(`/receipts?task_id=${id}`))).map((r: { egress: string }) => r.egress);
    assert.deepEqual(await egress(results['claude-code'].id), ['remote:anthropic']);
    assert.deepEqual(await egress(results['openai-compatible'].id), ['local']);

    // A provider that says it worked when it didn't: failed, with Nova's reason, for each class.
    await m.send('PUT', api('/providers/claude-code/config'), { config: { command: `node ${FAKE_CLAUDE} --script ${script('liar')}` } });
    honest = false;
    for (const owner of ['claude-code', 'openai-compatible']) {
      writeCalc(join(m.home, 'workspace'));
      const t = await run(owner);
      assert.equal(t.state, 'failed', `${owner} claimed success without doing it`);
      assert.match(String(t.reason), /test|change|diff/i, `${owner}: the verifier’s reason: ${t.reason}`);
      assert.equal(sum(), BROKEN_SUM, `${owner}: nothing unverified was copied back`);
    }

    // Local-only: the remote provider is refused in plain words; the local model may still run it.
    const refused = await m.send('POST', api('/tasks'), calcTask('claude-code', { privacy_mode: 'local-only' }));
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /sends data off your devices, and this task is local-only/);
    honest = true;
    writeCalc(join(m.home, 'workspace'));
    const local = await run('openai-compatible', { privacy_mode: 'local-only' });
    assert.equal(local.state, 'done', local.reason);

    assert.equal(readFileSync(m.egress, 'utf8'), '', 'nothing tried to leave this machine');
  } finally {
    await stop(nova);
    await model.close();
  }
});
