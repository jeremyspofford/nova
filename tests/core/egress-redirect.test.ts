// "Local" is decided by where a call really goes (M5 review): a local address that redirects
// elsewhere is not followed, for a model, an n8n workflow or Home Assistant, so a brief, a key or a
// token can't be bounced to a host the privacy check never saw. And an Ollama model that runs in
// Ollama's cloud counts as the cloud, whatever address it is reached through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../../src/core/index.ts';
import { openaiCompatible } from '../../src/core/providers/openai.ts';
import { Inbox, n8n } from '../../src/core/providers/n8n.ts';
import { bootCore } from './connector-support.ts';

const listen = async (s: Server) => { await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return (s.address() as AddressInfo).port; };

// Where a redirect would send things, and what reached it.
async function elsewhere() {
  const got: string[] = [];
  const s = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    got.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''} ${body.slice(0, 40)}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"message":"API running."}');
  });
  const port = await listen(s);
  const bounce = createServer((req, res) => { res.writeHead(307, { location: `http://localhost:${port}${req.url}` }); res.end(); });
  const from = await listen(bounce);
  return { got, base: `http://127.0.0.1:${from}`, close: () => { s.close(); bounce.close(); } };
}

test('a model server that redirects is not followed: the brief and the key stay put', async () => {
  const e = await elsewhere();
  try {
    await assert.rejects(openaiCompatible.chat!({ base_url: `${e.base}/v1`, model: 'm', api_key: 'secret://K' }, () => 'example-key-0000', { system: 's', prompt: 'PRIVATE BRIEF' }), /redirect/i);
    const probe = await openaiCompatible.probe!({ base_url: `${e.base}/v1`, model: 'm', api_key: 'secret://K' }, () => 'example-key-0000', AbortSignal.timeout(4000));
    assert.match(String(probe), /redirect/i);
    assert.deepEqual(e.got, [], 'nothing reached the other host');
  } finally { e.close(); }
});

test('an n8n webhook that redirects is not followed: the signed brief stays put', async () => {
  const e = await elsewhere();
  try {
    const impl = n8n(new Inbox(mkdtempSync(join(tmpdir(), 'nova-inbox-'))));
    const brief = { envelope: '1', task_id: '00000000-0000-4000-8000-0000000000aa', goal: 'g', context_refs: [], constraints: {}, privacy_mode: 'local-only', approval_tier: 1, evidence_required: [{ kind: 'confirmation' }], idempotency_key: 'k' };
    const out = await impl.work({ provider: 'n8n', brief: brief as never, config: { webhook_url: `${e.base}/webhook/x`, signing_secret: 'secret://S' }, cwd: null, system: '', prompt: '', signal: AbortSignal.timeout(4000), secret: () => 'example-signing-secret', stateDir: '', log: () => {} });
    assert.equal(out.status, 'failed');
    assert.match(out.summary, /redirect/i);
    assert.deepEqual(e.got, []);
  } finally { e.close(); }
});

test('a Home Assistant address that redirects is not followed: the token stays put', async () => {
  const e = await elsewhere();
  const nova = await bootCore();
  try {
    const r = await nova.call('POST', '/connectors/home-assistant/connect', { url: e.base, token: 'example-token-0000' });
    assert.notEqual(r.status, 200);
    assert.match(r.body.error, /redirect/i);
    assert.deepEqual(e.got, []);
  } finally { await nova.stop(); e.close(); }
});

test('an Ollama model that runs in Ollama’s cloud counts as the cloud: local-only refuses it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-cloud-'));
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, secrets: () => null });
  try {
    core.providers.configure('openai-compatible', { base_url: 'http://127.0.0.1:11434/v1', model: 'example-model:7b' });
    assert.equal(core.providers.where('openai-compatible').coarse, 'local');
    core.providers.configure('openai-compatible', { model: 'example-model:120b-cloud' });
    const w = core.providers.where('openai-compatible');
    assert.equal(w.coarse, 'remote');
    assert.match(w.words, /Ollama’s cloud/);
    assert.equal(w.receipt, 'remote:ollama.com');
    core.providers.enable('openai-compatible', { approved: true });
    assert.throws(() => core.ledger.create({ title: 'Fix it', owner: 'openai-compatible', goal: 'Fix it.', privacy_mode: 'local-only', evidence_required: [{ kind: 'file_diff' }], origin: { kind: 'user' } }), /sends data off your devices, and this task is local-only/);
  } finally {
    await core.close();
  }
});
