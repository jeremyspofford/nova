// n8n callbacks belong to one attempt (M5 review): a callback is taken only for a task Nova has
// sent, and an answer used for one attempt doesn't stand in for the next; a callback that arrived
// while Nova restarted is still the answer for the attempt it was sent for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../../src/core/index.ts';
import { canonicalJson } from '../../src/core/mesh/wire.ts';
import { Inbox, n8n, signatureHeader, type Callback } from '../../src/core/providers/n8n.ts';

const SECRET = 'example-signing-secret-0123456789';
const TASK = '00000000-0000-4000-8000-0000000000bb';
const brief = { envelope: '1', task_id: TASK, goal: 'g', context_refs: [], constraints: {}, privacy_mode: 'local-only', approval_tier: 1, evidence_required: [{ kind: 'confirmation' }], idempotency_key: 'k' } as never;
const cb = (id: string): Callback => ({ task_id: TASK, status: 'done', summary: 'ran', confirmation: { id }, signed_at: 0, received_at: new Date().toISOString(), provider: 'n8n', trigger_id: null });

test('an answer used for one attempt doesn’t stand in for the next; one that came in during a restart does', async () => {
  const posts: unknown[] = [];
  const hook = createServer(async (req, res) => { for await (const _ of req) { /* read */ } posts.push(req.url); res.writeHead(200); res.end('{}'); });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/webhook/x`;
  const inbox = new Inbox(mkdtempSync(join(tmpdir(), 'nova-inbox-')));
  const impl = n8n(inbox);
  const work = (attempt: number) => impl.work({ provider: 'n8n', brief, attempt, config: { webhook_url: url, signing_secret: 'secret://S' }, cwd: null, system: '', prompt: '', signal: AbortSignal.timeout(5000), secret: () => SECRET, stateDir: '', log: () => {} });
  try {
    // Attempt 1 is sent, and answered.
    const first = work(1);
    for (let i = 0; i < 100 && !posts.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(posts.length, 1);
    inbox.put(cb('exec-1'));
    assert.deepEqual((await first).evidence, [{ kind: 'confirmation', system: 'n8n', id: 'exec-1' }]);
    // Attempt 2 (its evidence didn't hold up): sent again, and only its own answer counts.
    const second = work(2);
    for (let i = 0; i < 100 && posts.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(posts.length, 2, 'the brief went out again for the new attempt');
    inbox.put(cb('exec-2'));
    assert.deepEqual((await second).evidence, [{ kind: 'confirmation', system: 'n8n', id: 'exec-2' }]);
    // Sent as attempt 3, answered while Nova was down, run again as attempt 4: that answer stands.
    inbox.sent(TASK, 3);
    inbox.put(cb('exec-3'));
    assert.deepEqual((await work(4)).evidence, [{ kind: 'confirmation', system: 'n8n', id: 'exec-3' }]);
    assert.equal(posts.length, 2, 'nothing sent again');
  } finally {
    hook.close();
  }
});

test('a callback for a task Nova never sent to the workflow is refused', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-n8n-'));
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, secrets: (n) => (n === 'N8N_SIGNING_SECRET' ? SECRET : null) });
  try {
    const { token } = core.providers.configure('n8n', { webhook_url: 'http://127.0.0.1:9/webhook/x' });
    core.providers.enable('n8n', { approved: true });
    const t = core.ledger.create({ title: 'Archive', owner: 'n8n', goal: 'Archive.', origin: { kind: 'user' }, evidence_required: [{ kind: 'confirmation' }], privacy_mode: 'local-only' });
    core.ledger.cancel(t.id);
    const body = { task_id: t.id, status: 'done', summary: 'ran', confirmation: { id: 'exec-x' } };
    await assert.rejects(core.providers.hook('n8n-callback', token, body, { 'x-nova-signature': signatureHeader(SECRET, canonicalJson(body)) }), /hasn’t sent that task/);
    assert.equal(core.providers.inbox.get(t.id), null);
  } finally {
    await core.close();
  }
});
