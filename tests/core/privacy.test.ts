// Chat honors the privacy mode (LOCAL-FIRST-AND-DEVICE-MESH §2): with a local-only profile, a
// model command that sends conversations to the cloud is never started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';

const root = join(import.meta.dirname, '..', '..');

test('a cloud model is never called while the profile is local-only; allowing cloud lets it through', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-privacy-'));
  const called = join(home, 'model-was-called');
  // The model command leaves a mark when it runs. Its egress is undeclared, so it counts as cloud.
  const nova = createNova({ ...loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: `touch ${called} && FAKE_DELAY=1 node ${join(root, 'scripts/fake-agent.js')}`, NOVA_TZ: 'UTC' }), port: 0 });
  await new Promise<void>((r) => nova.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(nova.server.address() as AddressInfo).port}`;
  const send = (method: string, path: string, body: unknown = {}) => fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-nova': '1' }, body: JSON.stringify(body) });
  const settle = async (id: string, until: (s: { live: unknown; session: { turns: { attempt: number; state: string; items: { message?: string }[] }[] } }) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const s = await (await fetch(`${base}/api/sessions/${id}`)).json();
      if (until(s)) return s;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('timed out');
  };

  try {
    const { id } = await (await send('POST', '/api/sessions', { text: 'hello' })).json();
    const refused = (await settle(id, (s) => s.live === null)).session.turns[0]!;
    assert.equal(refused.state, 'error');
    assert.match(refused.items[0]!.message ?? '', /privacy setting is local-only.*runs in the cloud, so I haven't sent this anywhere/);
    assert.equal(existsSync(called), false, 'the model command never ran');

    await send('PUT', '/api/v1/profile/privacy/default', { value: 'local-preferred' });
    assert.equal((await send('POST', `/api/sessions/${id}/regenerate`)).status, 202);
    const answered = (await settle(id, (s) => s.live === null && s.session.turns[0]!.attempt === 1)).session.turns[0]!;
    assert.equal(answered.state, 'done');
    assert.equal(existsSync(called), true);
  } finally {
    nova.server.close();
    await nova.core.close();
  }
});

test('setup tells the truth about a cloud chat model before asking about privacy', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-privacy-'));
  const nova = createNova({ ...loadConfig({ NOVA_HOME: home, NOVA_TZ: 'UTC' }), port: 0 });
  try {
    for (let i = 0; i < 4; i++) nova.core.setup.answer('skip');
    assert.match(nova.core.setup.view().question ?? '', /chat is set up to use claude, which runs in the cloud\. With local-only, chat stays off until you add a local model/);
  } finally {
    await nova.core.close();
  }
  const local = createNova({ ...loadConfig({ NOVA_HOME: mkdtempSync(join(tmpdir(), 'nova-privacy-')), NOVA_AGENT_CMD: 'my-local-model', NOVA_AGENT_EGRESS: 'local', NOVA_TZ: 'UTC' }), port: 0 });
  try {
    for (let i = 0; i < 4; i++) local.core.setup.answer('skip');
    assert.doesNotMatch(local.core.setup.view().question ?? '', /cloud\. With local-only/);
  } finally {
    await local.core.close();
  }
});

test('local-only offers no tool that reaches the internet', async () => {
  const { availableTools, withinPrivacy } = await import('../../src/tools.js');
  const all = availableTools({ gmail: true, skills: 1, delegate: true });
  const local = withinPrivacy(all, 'local-only');
  for (const n of ['web_fetch', 'web_search', 'gmail_search', 'gmail_read', 'gmail_draft', 'gmail_organize']) {
    assert.ok(all.includes(n), `${n} exists`);
    assert.ok(!local.includes(n), `${n} is not offered in local-only`);
  }
  assert.ok(local.includes('read_file') && local.includes('exec'));
  assert.deepEqual(withinPrivacy(all, 'local-preferred'), all);
});

test('every chat model call leaves a context receipt saying what went in and where it went', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-privacy-'));
  const nova = createNova({ ...loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: `FAKE_DELAY=1 node ${join(root, 'scripts/fake-agent.js')}`, NOVA_AGENT_EGRESS: 'none', NOVA_TZ: 'UTC' }), port: 0 });
  await new Promise<void>((r) => nova.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(nova.server.address() as AddressInfo).port}`;
  try {
    const { id } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nova': '1' }, body: JSON.stringify({ text: 'hello' }) })).json();
    for (let i = 0; i < 200; i++) {
      const s = await (await fetch(`${base}/api/sessions/${id}`)).json();
      if (s.live === null) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const receipts = await (await fetch(`${base}/api/v1/receipts?session_id=${id}`)).json();
    assert.ok(receipts.length >= 1);
    const r = receipts[0];
    assert.equal(r.purpose, 'chat');
    assert.equal(r.privacy_mode, 'local-only');
    assert.equal(r.egress, 'local');
    const kinds = new Set(r.context_items.map((c: { kind: string }) => c.kind));
    for (const k of ['file', 'standing', 'session']) assert.ok(kinds.has(k), `has ${k}`);
    assert.ok(r.context_items.every((c: { sha256: string }) => /^[0-9a-f]{64}$/.test(c.sha256)));
    assert.deepEqual(await (await fetch(`${base}/api/v1/receipts?egress=remote`)).json(), [], 'the egress log is empty');
  } finally {
    nova.server.close();
    await nova.core.close();
  }
});

test('privacy is checked before every model step: tightening it while a run waits for an OK stops the next step (review finding)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-privacy-'));
  const calls = join(home, 'calls');
  const nova = createNova({ ...loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: `echo x >> ${calls} && FAKE_DELAY=1 node ${join(root, 'scripts/fake-agent.js')}`, NOVA_TZ: 'UTC' }), port: 0 });
  await new Promise<void>((r) => nova.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(nova.server.address() as AddressInfo).port}`;
  const send = (method: string, path: string, body: unknown = {}) => fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-nova': '1' }, body: JSON.stringify(body) });
  const count = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0);
  try {
    nova.core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
    const { id } = await (await send('POST', '/api/sessions', { text: 'run git status' })).json();
    let s;
    for (let i = 0; i < 200; i++) {
      s = await (await fetch(`${base}/api/sessions/${id}`)).json();
      if (s.live?.phase === 'approval') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(s.live?.phase, 'approval');
    assert.equal(count(), 1, 'one model step so far, allowed by cloud-allowed');
    nova.core.profile.set('privacy', 'default', 'local-only', 'settings');
    const tool = s.session.turns[0].items.find((i: { kind: string }) => i.kind === 'tool');
    await send('POST', `/api/sessions/${id}/approvals/${tool.id}`, { decision: 'allow' });
    for (let i = 0; i < 200; i++) {
      s = await (await fetch(`${base}/api/sessions/${id}`)).json();
      if (s.live === null) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(count(), 1, 'the next step was never sent to the cloud model');
    assert.equal(s.session.turns[0].state, 'error');
    assert.match(JSON.stringify(s.session.turns[0].items), /privacy setting is local-only/);
  } finally {
    nova.server.close();
    await nova.core.close();
  }
});

test('a model command given as a path still gets a valid receipt (review finding)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-privacy-'));
  const nova = createNova({ ...loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: '/usr/local/bin/Claude-Code -p', NOVA_TZ: 'UTC' }), port: 0 });
  try {
    const r = nova.runner.receipt('s1', { helper: null, unattended: null, skills: new Map() }, 'cloud-allowed', { system: 's', prompt: 'p', recall: [] });
    assert.equal(r.egress, 'remote:claude-code');
    assert.equal(nova.core.receipts.record(r).egress, 'remote:claude-code');
  } finally {
    await nova.core.close();
  }
});
