// Chaos pass, providers (M7 plan §3): the local model dies mid-call, a CLI agent crashes or hangs,
// a provider answers garbage. Each is detected, said in plain words as a problem with its
// playbook, and repaired by Nova where that is safe. Stand-ins only; nothing leaves the machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_CLAUDE, calcTask, writeCalc } from '../support/providers.ts';
import { INSTALLED, modelsCore, say } from '../support/models.ts';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { startFakeOpenAI } from '../../scripts/stand-ins/fake-openai.js';
import { open, world } from '../core/resilience-support.ts';
import { problemWith, repairs, settle } from './support.ts';

const diffOnly = (owner: string) => ({ ...calcTask(owner, { inputs: {}, evidence_required: [{ kind: 'file_diff', target: 'workspace:calc/sum.mjs' }] }), origin: { kind: 'user' } }) as never;

function scriptFile(s: unknown): string {
  const f = join(mkdtempSync(join(tmpdir(), 'nova-chaos-script-')), 'script.json');
  writeFileSync(f, JSON.stringify(s));
  return f;
}

test('the local model dies mid-call: the work waits (local-only), a problem with its playbook, and it heals when the model is back', { timeout: 60_000 }, async () => {
  // A runtime that lists its model, then goes away entirely in the middle of the first chat.
  const srv = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const json = (o: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/version') return json({ version: '0.0.1' });
    if (req.url === '/api/tags') return json({ models: [{ name: 'example-mid:8b', size: 5e9, digest: 'a'.repeat(64), details: { parameter_size: '8B' }, capabilities: ['completion'] }] });
    if (req.url === '/api/chat') { srv.close(); srv.closeAllConnections(); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  const { core } = modelsCore(`http://127.0.0.1:${port}`, { privacy: 'local-only' });
  let back: Awaited<ReturnType<typeof startFakeOllama>> | null = null;
  try {
    await core.models.assign('reasoner', { model: 'example-mid:8b' });
    await assert.rejects(core.models.infer({ role: 'reasoner', messages: say('hi'), privacy_mode: 'local-only' }), /Waiting on local capacity/);
    const p = await problemWith(core, 'local-model-down');
    assert.match(p.message, /isn’t answering/);
    const first = await repairs(core, p.id);
    assert.equal(first[0]!.ok, false, 'the automatic check finds it still down');

    // It comes back on the same address: the repair finds it answering and closes the problem.
    back = await startFakeOllama({ models: INSTALLED.concat([{ name: 'example-mid:8b', size: 5e9, parameter_size: '8B', family: 'example', capabilities: ['completion'] }]), port });
    const r = await core.resilience.playbooks.attempt(p.id, 'person');
    assert.equal(r.ok, true, r.said);
    assert.equal(core.log.problems({ open: true }).some((x) => x.id === p.id), false);
  } finally {
    await core.close();
    srv.close();
    await back?.close();
  }
});

test('a CLI agent that crashes mid-task: failed in plain words, a problem with its playbook, the worker checked again', async () => {
  const w = world('nova-chaos-crash-');
  const core = open(w.home);
  try {
    writeCalc(core.workspace.root);
    core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
    // It starts, says something, then is killed outright (its own shell kills it).
    core.providers.configure('claude-code', { command: `node ${FAKE_CLAUDE} --script ${scriptFile({ steps: [{ say: 'Starting.' }, { run: 'kill -9 $PPID' }], result: 'never reached' })}` });
    core.providers.enable('claude-code', { approved: true });
    const t = await settle(core, core.ledger.create(diffOnly('claude-code')).id);
    assert.equal(t.state, 'failed', t.reason ?? '');
    const p = await problemWith(core, 'provider-failed', { subject: 'claude-code' });
    assert.equal(p.task_id, t.id);
    const r = await repairs(core, p.id);
    assert.equal(r[0]!.name, 'recheck-worker');
    assert.equal(r[0]!.ok, true, r[0]!.said);
    assert.match(r[0]!.said, /answers again.*retry or cancel/);
  } finally {
    await core.close();
  }
});

test('a CLI agent that hangs is stopped at its time limit, said plainly, with the playbook', { timeout: 60_000 }, async () => {
  const w = world('nova-chaos-hang-');
  const core = open(w.home);
  try {
    writeCalc(core.workspace.root);
    core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
    core.providers.configure('claude-code', { command: `node ${FAKE_CLAUDE} --script ${scriptFile({ delay_ms: 120_000, steps: [], result: 'too late' })}`, timeout_s: 5 });
    core.providers.enable('claude-code', { approved: true });
    const started = Date.now();
    const t = await settle(core, core.ledger.create(diffOnly('claude-code')).id, undefined, 45_000);
    assert.equal(t.state, 'failed', t.reason ?? '');
    assert.match(t.reason!, /took longer than 5 s and was stopped/);
    assert.ok(Date.now() - started < 30_000, 'it didn’t wait for the hang');
    await problemWith(core, 'provider-failed', { subject: 'claude-code' });
  } finally {
    await core.close();
  }
});

test('a provider that answers garbage: nothing is applied, the task fails in plain words, with the playbook', async () => {
  const fake = await startFakeOpenAI({ model: 'm', reply: () => '}}} not the files contract {{{' });
  const w = world('nova-chaos-garbage-');
  const core = open(w.home);
  try {
    writeCalc(core.workspace.root);
    core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
    core.providers.configure('openai-compatible', { base_url: fake.url, model: 'm' });
    core.providers.enable('openai-compatible', { approved: true });
    const t = await settle(core, core.ledger.create(diffOnly('openai-compatible')).id);
    assert.equal(t.state, 'failed', t.reason ?? '');
    const p = await problemWith(core, 'provider-failed', { subject: 'openai-compatible' });
    assert.equal(p.task_id, t.id);
  } finally {
    await core.close();
    await fake.close();
  }
});
