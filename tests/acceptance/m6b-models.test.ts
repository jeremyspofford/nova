// M6b over the API, with the real server as its own process and the egress tripwire: the model
// manager on a fixed hub-class hardware reading and the stand-in Ollama. Roles are recommended and
// assigned from installed models (transcription said to have no runtime); chat goes through the
// local reasoner by role with one receipt per call; a download is a tier-2 task Nova checks itself.
// Then the local reasoner goes down: local-only chat and a local-only task wait "on local
// capacity", the person is told, the stand-in "cloud" gets zero requests; capacity returns and the
// task runs. Last, under local-preferred the cloud steps in, and the receipt says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blank, stop, until } from './support.ts';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { filesReply, startFakeOpenAI } from '../../scripts/stand-ins/fake-openai.js';
import { CONTRACT_SYSTEM } from '../../src/core/providers/prompt.ts';
import { INSTALLED, LIBRARY, hardwareFile } from '../support/models.ts';
import { FIXED_SUM, calcTask, writeCalc } from '../support/providers.ts';

test('M6b: models by role over the API — recommend and assign, chat with receipts, a verified download, an outage that never reaches the cloud', { timeout: 120_000 }, async () => {
  const reply = (req: { messages?: { role: string; content: string }[] }) =>
    req.messages?.[0]?.content === CONTRACT_SYSTEM ? filesReply([{ path: 'calc/sum.mjs', content: FIXED_SUM }], 'sum subtracted; it adds now.') : 'Hello from the local reasoner.';
  let ollama = await startFakeOllama({ models: INSTALLED, library: LIBRARY, reply });
  const port = ollama.port;
  const cloud = await startFakeOpenAI({ model: 'cloud-model', reply: () => 'Answer from the cloud stand-in.' });
  const m = blank('nova-m6b-');
  const nova = await m.start({ NOVA_OLLAMA_URL: ollama.url, NOVA_HARDWARE_FILE: hardwareFile(m.dir), NOVA_MODELS_WATCH_MS: '150' });
  const api = (p: string) => `/api/v1${p}`;
  const chat = async (text: string) => {
    const { body } = await m.send('POST', '/api/sessions', { text });
    const s = await until<any>(() => m.get(`/api/sessions/${body.id}`), (x) => x.live === null && x.session.turns[0]?.state !== 'open', 400);
    return { id: body.id as string, turn: s.session.turns[0] };
  };
  try {
    writeCalc(join(m.home, 'workspace'));
    assert.equal((await m.get(api('/profile'))).privacy.default ?? 'local-only', 'local-only');

    // 1. The hardware, the recommendation, transcription said plainly; settings only through /models.
    const view = await m.get(api('/models'));
    assert.match(view.devices[0].words, /Example GPU 24GB \(24 GB\) · 32 GB memory · 20 threads/);
    assert.equal(view.standout, 'accept');
    assert.equal(view.roles.find((r: { role: string }) => r.role === 'reasoner').recommended.model, 'example-deep:32b');
    assert.match(view.roles.find((r: { role: string }) => r.role === 'transcriber').words, /no transcription runtime/);
    assert.equal((await m.send('PUT', api('/profile/models/role.reasoner'), { value: { device: 'hub', model: 'x' } })).status, 400, 'models are set through /models, checked');
    const accepted = await m.send('POST', api('/models/roles/accept'), {});
    assert.deepEqual(accepted.body.assigned, ['triage-text', 'reasoner', 'embedder']);

    // 2. Chat through the local reasoner, by role: one receipt per call, egress local.
    assert.equal((await m.send('PUT', api('/providers/openai-compatible/config'), { config: { role: 'reasoner' } })).status, 200);
    assert.equal((await m.send('POST', api('/providers/openai-compatible/enable'), { approved: true })).body.egress.coarse, 'local');
    assert.equal((await m.send('PUT', api('/providers/choice'), { for: 'chat', id: 'openai-compatible' })).body.chat.current, 'openai-compatible');
    const hello = await chat('hello');
    assert.equal(hello.turn.state, 'done', JSON.stringify(hello.turn.items));
    assert.match(JSON.stringify(hello.turn.items), /Hello from the local reasoner/);
    const receipts = await m.get(api(`/receipts?session_id=${hello.id}`));
    assert.equal(receipts.length, 1, 'one receipt for the one call');
    assert.deepEqual([receipts[0].provider, receipts[0].model, receipts[0].egress], ['ollama', 'example-deep:32b', 'local']);
    assert.ok(receipts[0].context_items.some((c: { kind: string }) => c.kind === 'session'), 'the runner’s context items, kept');

    // 3. A download: tier 2, then Nova reads the digest back itself.
    const pull = await m.send('POST', api('/models/pull'), { model: 'nomic-embed-text' });
    assert.equal(pull.status, 201);
    assert.equal((await until<any>(() => m.get(api(`/tasks/${pull.body.id}`)), (t) => t.state === 'waiting', 200)).reason, 'Needs your OK before it runs.');
    await m.send('POST', api(`/tasks/${pull.body.id}/approve`), {});
    const pulled = await until<any>(() => m.get(api(`/tasks/${pull.body.id}`)), (t) => ['done', 'failed'].includes(t.state), 400);
    assert.equal(pulled.state, 'done', pulled.reason);
    assert.match(pulled.verification.checks[0].why, /Nova read nomic-embed-text from the runtime itself/);

    // 4. A cloud model is set, but the setting is local-only: it is never used.
    assert.equal((await m.send('PUT', api('/models/cloud'), { cloud: { name: 'Example cloud', base_url: cloud.url, model: 'cloud-model' } })).status, 400, 'a new address needs an explicit OK');
    assert.equal((await m.send('PUT', api('/models/cloud'), { cloud: { name: 'Example cloud', base_url: cloud.url, model: 'cloud-model' }, confirm: true })).status, 200);
    const asked = await m.send('POST', api('/models/infer'), { role: 'reasoner', messages: [{ role: 'user', content: 'hi' }], privacy_mode: 'cloud-allowed' });
    assert.equal(asked.body.served_by, 'local', 'a caller can only tighten the setting, never loosen it');

    // 5. The midday outage: the stand-in stops.
    await ollama.close();
    const refused = await m.send('POST', api('/models/infer'), { role: 'reasoner', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /^Waiting on local capacity: .*This is local-only, so it stays on your devices/);
    const down = await chat('are you there?');
    assert.equal(down.turn.state, 'error');
    assert.match(JSON.stringify(down.turn.items), /Waiting on local capacity/);
    const task = await m.send('POST', api('/tasks'), calcTask('openai-compatible', { privacy_mode: 'local-only' }));
    assert.equal(task.status, 201, JSON.stringify(task.body));
    const waiting = await until<any>(() => m.get(api(`/tasks/${task.body.id}`)), (t) => t.state === 'waiting', 400);
    assert.match(waiting.reason, /Waiting on local capacity/);
    const told = await until<any>(() => m.get(api('/messages')), (ms) => ms.some((x: { text: string }) => /is waiting\. Waiting on local capacity/.test(x.text)), 400);
    assert.ok(told.length, 'the person is told');

    // Capacity returns: the task runs by itself, and Nova asks before running the test.
    ollama = await startFakeOllama({ models: INSTALLED, port, reply });
    const ask = await until<any>(() => m.get(api(`/tasks/${task.body.id}`)), (t) => t.state === 'waiting' && /OK/.test(t.reason ?? ''), 600);
    assert.match(ask.reason, /Nova needs your OK to run/);
    await m.send('POST', api(`/providers/tasks/${task.body.id}/test-run`), {});
    const done = await until<any>(() => m.get(api(`/tasks/${task.body.id}`)), (t) => ['done', 'failed'].includes(t.state), 600);
    assert.equal(done.state, 'done', done.reason);
    assert.equal(readFileSync(join(m.home, 'workspace', 'calc', 'sum.mjs'), 'utf8'), FIXED_SUM);
    assert.equal(cloud.requests.length, 0, 'local-only never reached the cloud stand-in');
    assert.deepEqual(await m.get(api('/receipts?egress=remote')), []);

    // 6. Local-preferred, local down: the cloud steps in, the receipt discloses it, a problem is opened.
    await m.send('PUT', api('/profile/privacy/default'), { value: 'local-preferred' });
    await ollama.close();
    const fallback = await m.send('POST', api('/models/infer'), { role: 'reasoner', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(fallback.status, 200, JSON.stringify(fallback.body));
    assert.equal(fallback.body.served_by, 'cloud');
    assert.equal((await m.get(api('/receipts?egress=remote')))[0].egress, 'remote:example-cloud');
    assert.ok((await m.get(api('/problems?open=1'))).some((p: { source: string }) => p.source === 'models'));
    assert.equal(cloud.requests.length, 1);

    // Nothing tried to leave this machine: the "cloud" was a stand-in on loopback.
    assert.equal(readFileSync(m.egress, 'utf8'), '');
  } finally {
    await stop(nova);
    await ollama.close();
    await cloud.close();
  }
});
