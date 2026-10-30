// A provider's secret comes from the vault (M5a × M5b): an OpenAI-compatible server that needs a
// key gets it from secret://NAME, kept in the vault through PUT /api/v1/vault/NAME; the key reaches
// the server and nowhere else here (no log line, problem, receipt, setting or plain file); without
// it the provider says the key isn't in the vault; and the NOVA_SECRET_<NAME> fallback (development
// and tests only) loses to the vault and is redacted too. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Core } from '../../src/core/index.ts';
import { startFakeOpenAI, filesReply } from '../../scripts/stand-ins/fake-openai.js';
import { FIXED_SUM, calcTask, writeCalc } from '../support/providers.ts';
import { bootCore } from './connector-support.ts';

const KEY = 'placeholder-api-key-4d1e9b27c0';

function everything(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...everything(p));
    else if (e.isFile()) out.push({ path: p, text: readFileSync(p).toString('latin1') });
  }
  return out;
}

async function settle(core: Core, id: string) {
  for (let i = 0; i < 400; i++) {
    await core.ledger.idle();
    const t = core.ledger.get(id);
    if (['done', 'failed', 'cancelled', 'waiting'].includes(t.state)) return t;
    await new Promise((r) => setTimeout(r, 25));
  }
  return core.ledger.get(id);
}

test('a provider’s key comes from the vault, reaches the server, and appears in no log, problem or receipt', async () => {
  const fake = await startFakeOpenAI({ model: 'example-coder', key: KEY, reply: () => filesReply([{ path: 'calc/sum.mjs', content: FIXED_SUM }], 'Now it adds.') });
  const { core, call, get, home, stop } = await bootCore();
  let stopped = false;
  try {
    core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
    core.profile.set('policy', 'task_tests', 'allow', 'settings');
    writeCalc(core.workspace.root);
    core.providers.configure('openai-compatible', { base_url: fake.url, model: 'example-coder', api_key: 'secret://OPENAI_KEY' });
    assert.match(core.providers.health('openai-compatible').words, /OPENAI_KEY isn’t in the vault yet/);

    assert.match((await call('PUT', '/vault/openai_key', { value: KEY })).body.error, /capital letters/);
    const put = await call('PUT', '/vault/OPENAI_KEY', { value: KEY });
    assert.deepEqual(put.body, { name: 'OPENAI_KEY', ref: 'secret://OPENAI_KEY', stored: true });
    assert.ok((await get('/vault')).names.includes('provider/OPENAI_KEY'));

    await core.providers.check('openai-compatible');
    assert.equal(core.providers.health('openai-compatible').state, 'ready');
    core.providers.enable('openai-compatible', { approved: true });
    const made = core.ledger.create({ ...calcTask('openai-compatible', { privacy_mode: 'cloud-allowed' }), origin: { kind: 'user' } } as never);
    // Nova asks before running what the model wrote.
    assert.equal((await settle(core, made.id)).state, 'waiting');
    core.providers.approveTest(made.id);
    const t = await settle(core, made.id);
    assert.equal(t.state, 'done', t.reason ?? '');
    assert.ok(fake.requests.some((r) => r.url === '/v1/chat/completions' && r.headers.authorization === `Bearer ${KEY}`), 'the server got the key');

    // A problem quoting the key, as an error message might: redacted before it is stored.
    core.log.problem('test', `The server said no to ${KEY}.`);
    const shown = JSON.stringify([await get('/problems'), await get(`/receipts?task_id=${t.id}`), await get('/providers'), await get('/vault'), await get(`/tasks/${t.id}`)]);
    assert.ok(!shown.includes(KEY), 'not in problems, receipts, provider settings, the vault view or the task');
    assert.equal((await call('DELETE', '/vault/OTHER_KEY')).body.deleted, false);
    // Every file in the home once Nova has stopped (the database's write-ahead log folded in).
    await stop();
    stopped = true;
    assert.deepEqual(everything(home).filter((f) => f.text.includes(KEY)).map((f) => f.path), [], 'in no file in plaintext: database, log, settings');
  } finally {
    if (!stopped) await stop();
    await fake.close();
  }
});

test('the NOVA_SECRET_<NAME> fallback is for development only: the vault wins, and its value is redacted too', async () => {
  const fromEnv = 'placeholder-env-key-71c3aa05';
  const { core, stop } = await bootCore({ secrets: (n) => (n === 'OPENAI_KEY' ? fromEnv : null) });
  try {
    core.providers.configure('openai-compatible', { base_url: 'http://127.0.0.1:9', model: 'm', api_key: 'secret://OPENAI_KEY' });
    assert.doesNotMatch(core.providers.health('openai-compatible').words, /isn’t in the vault/, 'the fallback answers');
    assert.doesNotMatch(core.log.problem('test', `env ${fromEnv}`).message, new RegExp(fromEnv));
    core.vault.put('provider/OPENAI_KEY', KEY);
    const fake = await startFakeOpenAI({ model: 'm', key: KEY });
    try {
      core.providers.configure('openai-compatible', { base_url: fake.url });
      await core.providers.check('openai-compatible');
      assert.equal(core.providers.health('openai-compatible').state, 'ready', 'the vault’s key, not the environment’s');
    } finally { await fake.close(); }
  } finally { await stop(); }
});
