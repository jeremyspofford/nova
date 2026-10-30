// M5a, through the real server as its own process, with the egress tripwire: providers set up and
// turned on over the API, the calc/ brief done by the Claude Code stand-in and verified by Nova,
// local-only refusing a remote provider in plain words, Era 2's chat unchanged until the person
// picks another chat model and then going through it, and an n8n round trip with a signed callback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blank, stop, until } from './support.ts';
import { startFakeOpenAI } from '../../scripts/stand-ins/fake-openai.js';
import { startFakeN8n } from '../../scripts/stand-ins/fake-n8n.js';
import { FAKE_CLAUDE, FIXED_SUM, ROOT, calcTask, script, writeCalc } from '../support/providers.ts';

const SECRET = 'example-signing-secret-for-the-test';

test('M5a: providers over the API — a verified coding task, privacy in plain words, chat through the registry, n8n signed both ways', async () => {
  const m = blank('nova-m5a-');
  const fake = await startFakeOpenAI({ model: 'example-chat', reply: () => 'Hello from the local model.' });
  const nova = await m.start({ NOVA_AGENT_CMD: `FAKE_DELAY=1 node ${join(ROOT, 'scripts/fake-agent.js')}`, NOVA_AGENT_EGRESS: 'none', NOVA_SECRET_N8N_SIGNING_SECRET: SECRET });
  let n8n: Awaited<ReturnType<typeof startFakeN8n>> | null = null;
  const api = (p: string) => `/api/v1${p}`;
  const settled = (id: string) => until<any>(() => m.get(api(`/tasks/${id}`)), (t) => ['done', 'failed', 'waiting', 'cancelled'].includes(t.state), 400);
  const chat = async (text: string) => {
    const { body } = await m.send('POST', '/api/sessions', { text });
    const s = await until<any>(() => m.get(`/api/sessions/${body.id}`), (x) => x.live === null && x.session.turns[0]?.state !== 'open', 400);
    return { id: body.id as string, turn: s.session.turns[0] };
  };
  try {
    writeCalc(join(m.home, 'workspace'));
    await m.send('PUT', api('/profile/privacy/default'), { value: 'cloud-allowed' });
    const list = await m.get(api('/providers'));
    assert.deepEqual(list.providers.map((p: { id: string }) => p.id).sort(), ['claude-code', 'codex', 'custom-cli', 'n8n', 'openai-compatible']);
    assert.equal(list.chat.current, 'custom-cli');
    assert.equal((await m.send('PUT', api('/profile/providers/chat'), { value: 'codex' })).status, 400, 'provider settings go through /providers, checked');

    // 1. Claude Code (stand-in), turned on with an OK, does the calc/ brief; Nova checks it.
    assert.equal((await m.send('PUT', api('/providers/claude-code/config'), { config: { command: `node ${FAKE_CLAUDE} --script ${script('honest')}` } })).status, 200);
    assert.equal((await m.send('POST', api('/tasks'), calcTask('claude-code'))).body.error, 'Claude Code is turned off. Turn it on in Settings › Providers first.');
    assert.equal((await m.send('POST', api('/providers/claude-code/enable'), {})).status, 403);
    assert.equal((await m.send('POST', api('/providers/claude-code/enable'), { approved: true })).body.enabled, true);
    const created = await m.send('POST', api('/tasks'), calcTask('claude-code'));
    assert.equal(created.status, 201);
    // Once Claude Code has finished, Nova asks before running the test on what it wrote.
    assert.match((await settled(created.body.id)).reason, /Nova needs your OK to run `node --test calc\/sum.test.mjs`\. This runs code the provider wrote/);
    assert.deepEqual((await m.get(api(`/providers/tasks/${created.body.id}/test-run`))).files.map((f: { path: string }) => f.path), ['calc/sum.mjs']);
    await m.send('POST', api(`/providers/tasks/${created.body.id}/test-run`), {});
    await until<any>(() => m.get(api(`/tasks/${created.body.id}`)), (x) => x.state !== 'waiting', 400);
    const done = await settled(created.body.id);
    assert.equal(done.state, 'done', done.reason);
    assert.ok(done.verification.checks.every((c: { ok: boolean }) => c.ok));
    assert.equal(readFileSync(join(m.home, 'workspace', 'calc', 'sum.mjs'), 'utf8'), FIXED_SUM);
    const receipts = await m.get(api(`/receipts?task_id=${created.body.id}`));
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].egress, 'remote:anthropic');

    // 2. Local-only refuses it, and says why.
    const refused = await m.send('POST', api('/tasks'), calcTask('claude-code', { privacy_mode: 'local-only' }));
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Claude Code sends data off your devices, and this task is local-only/);

    // 3. Chat: agent_cmd as before, until the person picks the local model; then through it.
    const before = await chat('hello');
    assert.equal(before.turn.state, 'done');
    assert.equal((await m.get(api(`/receipts?session_id=${before.id}`)))[0].provider, 'node', 'Era 2’s receipt, unchanged');
    await m.send('PUT', api('/providers/openai-compatible/config'), { config: { base_url: fake.url, model: 'example-chat' } });
    assert.equal((await m.send('PUT', api('/providers/choice'), { for: 'chat', id: 'openai-compatible' })).status, 409, 'it must be on first');
    await m.send('POST', api('/providers/openai-compatible/enable'), { approved: true });
    assert.equal((await m.send('POST', api('/providers/openai-compatible/check'), {})).body.health.state, 'ready');
    assert.equal((await m.send('PUT', api('/providers/choice'), { for: 'chat', id: 'openai-compatible' })).body.chat.current, 'openai-compatible');
    const after = await chat('hello again');
    assert.equal(after.turn.state, 'done');
    assert.match(JSON.stringify(after.turn.items), /Hello from the local model\./);
    const r = (await m.get(api(`/receipts?session_id=${after.id}`)))[0];
    assert.equal(r.provider, 'openai-compatible');
    assert.equal(r.egress, 'local');
    assert.match(fake.requests.at(-1)!.body.messages[1].content, /hello again/);

    // 4. A chat model elsewhere, under local-only: nothing is sent, and Nova says why.
    await m.send('PUT', api('/profile/privacy/default'), { value: 'local-only' });
    await m.send('PUT', api('/providers/openai-compatible/config'), { config: { base_url: 'https://models.example/v1' } });
    const held = await chat('anything');
    assert.equal(held.turn.state, 'error');
    assert.match(JSON.stringify(held.turn.items), /privacy setting is local-only, and the model I chat with \(Local model \(Ollama or compatible\)\) sends conversations off your devices/);
    assert.equal(readFileSync(m.egress, 'utf8'), '', 'nothing left this machine');

    // 5. n8n: a signed brief out, a signed callback in through the token webhook.
    const token = (await m.send('PUT', api('/providers/n8n/config'), { config: { webhook_url: 'http://127.0.0.1:9/webhook/x' } })).body.token as string;
    assert.match(token, /.{30,}/);
    n8n = await startFakeN8n({ secret: SECRET, nova: m.base, token });
    await m.send('PUT', api('/providers/n8n/config'), { config: { webhook_url: n8n.url } });
    assert.equal((await m.send('POST', api('/providers/n8n/enable'), { approved: true })).body.enabled, true);
    const job = await m.send('POST', api('/tasks'), { title: 'Run the example workflow', owner: 'n8n', goal: 'The example workflow ran.', evidence_required: [{ kind: 'confirmation' }], privacy_mode: 'local-only' });
    const ran = await settled(job.body.id);
    assert.equal(ran.state, 'done', ran.reason);
    assert.equal(n8n.received[0]!.signed, true);
    assert.match(ran.verification.checks[0].why, /signed with the shared secret/);
    const triggers = await m.get(api('/triggers'));
    assert.ok(triggers.some((t: { source: string }) => t.source === 'webhook:n8n-callback'));
    assert.equal((await m.send('POST', api('/hooks/n8n-callback'), { task_id: job.body.id }, { 'x-nova-hook-token': 'nope' })).status, 403);
    assert.equal((await m.get(api('/health'))).checks.workers.workers.some((w: { id: string }) => w.id === 'n8n'), true);
  } finally {
    await stop(nova);
    await fake.close();
    await n8n?.close();
  }
});
