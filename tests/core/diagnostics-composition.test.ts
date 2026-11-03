// Missing production mounting, stale counts, relaxed access or a content projection must fail here.
// Real Nova listeners and stores; all data, vault keys, runtime and hardware are private fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { blank } from '../acceptance/support.ts';
import { Joiner, call } from './mesh-support.ts';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { hubHardware } from '../support/models.ts';
import { SessionStore } from '../../src/sessions.js';

const canary = (s: string) => `synthetic-${s}-7f3a91c2e8b4+/=`;
const files = (home: string): string[] => readdirSync(home, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name)).sort();
const close = (server: Server) => new Promise<void>((resolve, reject) => {
  server.close((e) => e ? reject(e) : resolve());
  server.closeAllConnections();
});

test('session log counts inspect directory entries only, including main, run and helper logs without interpreting content', () => {
  const m = blank('nova-diagnostics-count-');
  const store = new SessionStore(m.home, 'UTC');
  assert.equal(store.countLogs(), 0);
  mkdirSync(store.dir, { recursive: true });
  for (const [name, content] of [
    ['main.jsonl', ''], ['2026-11-01-abc123.jsonl', 'not JSON at all'],
    ['2026-11-01-def456.jsonl', '{"kind":"run"}'], ['2026-11-01-ghi789.jsonl', '{"kind":"helper"}'],
    ['invalid.jsonl', '{}'], ['2026-11-01-abc123.txt', '{}'], ['main.jsonl.bak', '{}'],
  ]) writeFileSync(join(store.dir, name!), content!);
  mkdirSync(join(store.dir, '2026-11-01-jkl012.jsonl'));
  symlinkSync(join(store.dir, 'main.jsonl'), join(store.dir, '2026-11-01-mno345.jsonl'));
  store.list = () => { throw new Error('must not list metadata'); };
  store.read = () => { throw new Error('must not read transcripts'); };
  assert.equal(store.countLogs(), 4);
  writeFileSync(join(store.dir, '2026-11-01-pqr678.jsonl'), '');
  assert.equal(store.countLogs(), 5, 'count is fresh and an empty log still exists');
});

test('production diagnostics downloads fresh numeric Era2 counts with person access and no persisted bundle or excluded content', async () => {
  const m = blank('nova-diagnostics-production-');
  const env = { HOME: m.env.HOME, NOVA_VAULT_KEY: 'file', NOVA_SECRET_DIAGNOSTICS_TEST: canary('environment') };
  const beforeEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const runtime = await startFakeOllama({ models: [] });
  const nova = createNova(loadConfig({ ...m.env, NOVA_AGENT_CMD: 'example-unused-command', NOVA_AGENT_EGRESS: 'none', NOVA_TZ: 'UTC', NOVA_INSTANCE: 'development', NOVA_MESH_URL: 'http://127.0.0.1:0', NOVA_MESH_TRANSPORT: 'network', NOVA_MESH_PUBLIC_URL: 'http://127.0.0.1:0' }), {
    models: { ollamaUrl: runtime.url, hardware: async () => hubHardware(), watchMs: 100, wakePollMs: 50 },
  });
  await new Promise<void>((r) => nova.server.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => nova.mesh!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(nova.server.address() as AddressInfo).port}`;
  const mesh = `http://127.0.0.1:${(nova.mesh!.address() as AddressInfo).port}`;
  const c = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => call(base, method, path, body, headers);
  try {
    const first = await c('GET', '/api/v1/diagnostics');
    assert.equal(first.status, 200, 'actual createNova mounts the existing diagnostics route');
    assert.deepEqual(first.body.work.era2, { chat_logs: 1, schedules: 0, skills: 0 });
    assert.equal(first.body.about.nova, '0.1.0');
    assert.match(first.body.about.build, /^[a-f0-9]{7,40}$/);
    assert.equal(first.body.about.instance, 'development');

    const secrets = [canary('vault'), canary('environment')];
    nova.core.vault.put('provider/DIAGNOSTICS_TEST', secrets[0]!);
    assert.equal(nova.core.vault.status().key, 'file', 'lazy vault uses a fixture key file on first write');
    // Only a synthetic fallback is planted; local verification also uses a clean environment.
    assert.equal(process.env.NOVA_SECRET_DIAGNOSTICS_TEST, secrets[1]);
    const identity = JSON.parse(readFileSync(join(m.home, 'mesh', 'identity.json'), 'utf8'));
    secrets.push(identity.ed25519.private, identity.x25519.private, readFileSync(join(m.home, 'vault', 'key')).toString('base64'));
    // Plant all supported encodings in a real included log field; assertions use literal encodings.
    for (const secret of secrets) {
      for (const variant of [secret, secret.toLowerCase(), secret.toUpperCase(), encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url'), Buffer.from(secret).toString('hex')]) {
        nova.core.log.write('info', 'example', `fixture ${variant}`);
      }
    }
    nova.core.log.problem('example', 'Synthetic connectivity problem', { detail: `Authorization: Bearer ${canary('bearer')}` });
    secrets.push(canary('bearer'));
    const personal = ['Private synthetic memory text', 'Private synthetic screen text', 'Private synthetic task title', 'Private synthetic task goal', 'Private synthetic person name', 'Private synthetic conversation title', 'Private synthetic conversation body', 'Private synthetic schedule prompt', 'Private synthetic skill body', 'Private synthetic brief text'];
    nova.core.memory.remember({ kind: 'fact', content: personal[0]!, recorded_by: 'person' });
    const src = nova.core.capture.addScreenpipe({ url: 'http://127.0.0.1:9' });
    nova.core.capture.enable(src.id, { by: 'person', since: new Date(Date.now() - 60_000).toISOString() });
    nova.core.capture.ingest(src.id, [{ external_id: 'example', kind: 'screen', at: new Date().toISOString(), app: 'Editor', text: personal[1]! }], 'api');
    nova.core.ledger.create({ title: personal[2]!, goal: personal[3]!, inputs: { text: personal[9] }, owner: 'workspace', origin: { kind: 'user' }, evidence_required: [{ kind: 'read_back', target: 'workspace/example.md' }] });
    nova.core.profile.set('user', 'name', personal[4]!, 'settings');
    nova.store.append('2026-11-01-abc123', { type: 'meta', title: personal[5] });
    nova.store.append('2026-11-01-abc123', { type: 'user', text: personal[6] });
    nova.runner.schedules.set({ name: 'Example schedule', cron: '0 7 * * *', prompt: personal[7] });
    const skillDir = join(m.home, 'skills', 'example-private');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: Example private\ndescription: Example fixture\n---\n${personal[8]}\n`);

    // Approval at the actual console; a real browser cookie on the mesh listener.
    const code = (await c('POST', '/api/v1/mesh/pairings')).body.code;
    const browser = new Joiner(mesh, () => Math.floor(Date.now() / 1000), { kind: 'browser', name: 'Example browser' });
    assert.equal((await browser.join(code)).status, 201);
    assert.equal((await browser.reveal()).status, 200);
    assert.equal((await c('POST', `/api/v1/mesh/requests/${browser.requestId}/approve`, { confirm: true })).status, 200);
    await browser.poll();
    const session = await browser.session({ cookie: true });
    assert.equal(session.status, 200);
    const cookie = /nova_session=[^;]+/.exec(session.headers.get('set-cookie') ?? '')?.[0];
    assert.ok(cookie);
    nova.store.list = () => { throw new Error("diagnostics must not read session metadata"); };
    nova.store.read = () => { throw new Error("diagnostics must not read transcripts"); };
    const before = files(m.home);
    for (const [endpoint, headers] of [[base, {}], [mesh, { cookie }]] as [string, Record<string, string>][]) {
      const reply = await call(endpoint, 'GET', '/api/v1/diagnostics', undefined, headers);
      assert.equal(reply.status, 200);
      assert.match(reply.headers.get('content-type') ?? '', /^application\/json\b/);
      assert.equal(reply.headers.get('cache-control'), 'no-store');
      assert.match(reply.headers.get('content-disposition') ?? '', /^attachment; filename="nova-diagnostics-\d{4}-\d{2}-\d{2}-\d{4}\.json"$/);
      assert.equal(reply.body.format, 'nova-diagnostics');
      assert.equal(reply.body.redaction.marker, '**REDACTED**');
      assert.equal(reply.body.vault.key_store, 'file');
      assert.deepEqual(reply.body.work.era2, { chat_logs: 2, schedules: 1, skills: 1 });
      assert.ok(Object.values(reply.body.work.era2).every((n) => typeof n === 'number' && Number.isInteger(n)));
      assert.equal(reply.body.work.memory.active, 1);
      assert.ok(reply.body.logs.length > 0 && reply.body.redaction.values_redacted > 0);
      const text = JSON.stringify(reply.body).toLowerCase();
      for (const secret of secrets) for (const form of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64').replace(/=+$/, ''), Buffer.from(secret).toString('base64url'), Buffer.from(secret).toString('hex')]) {
        assert.ok(!text.includes(form.toLowerCase()), 'synthetic secret encoding survived');
      }
      for (const value of personal) assert.ok(!text.includes(value.toLowerCase()), 'excluded personal content survived');
      assert.ok(!text.includes(m.home.toLowerCase()));
    }
    assert.deepEqual(files(m.home), before, 'download creates no file anywhere under Nova home');
    for (const file of files(m.home)) assert.ok(!readFileSync(file).includes(Buffer.from('nova-diagnostics')), 'no bundle retained in a content store');
    for (const headers of [{}, { cookie: 'nova_session=invalid' }] as Record<string, string>[]) {
      const denied = await call(mesh, 'GET', '/api/v1/diagnostics', undefined, headers);
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get('cache-control'), 'no-store');
      assert.equal(denied.headers.get('content-disposition'), null);
      assert.ok(!JSON.stringify(denied.body).includes('nova-diagnostics'));
    }
    assert.equal((await c('GET', '/api/v1/diagnostics', undefined, { 'x-forwarded-for': '198.51.100.7' })).status, 401);
    assert.equal((await call(mesh, 'POST', '/api/v1/memory', { kind: 'fact', content: 'Example' }, { cookie, 'x-nova': '' })).status, 403);
    assert.equal((await call(mesh, 'POST', '/api/v1/memory', { kind: 'fact', content: 'Example' }, { cookie, origin: 'https://evil.example' })).status, 403);
    nova.store.append('2026-11-01-def456', { type: 'meta', title: 'Example second conversation' });
    assert.equal((await c('GET', '/api/v1/diagnostics')).body.work.era2.chat_logs, 3, 'each request reads current persisted log counts');
  } finally {
    nova.scheduler.stop();
    await Promise.all([close(nova.server), close(nova.mesh!)]);
    await nova.core.close();
    await runtime.close();
    for (const [key, value] of Object.entries(beforeEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.equal(nova.server.listening, false);
    assert.equal(nova.mesh!.listening, false);
  }
});

// A private real file vault and the mounted HTTP route: no builder/scrubber/route replacement.
async function scanFixture() {
  const m = blank('nova-diagnostics-scan-');
  const before = { HOME: process.env.HOME, NOVA_VAULT_KEY: process.env.NOVA_VAULT_KEY };
  Object.assign(process.env, { HOME: m.env.HOME, NOVA_VAULT_KEY: 'file' });
  const runtime = await startFakeOllama({ models: [] });
  const config = { ...loadConfig({ ...m.env, NOVA_AGENT_CMD: 'example-unused-command', NOVA_AGENT_EGRESS: 'none', NOVA_TZ: 'UTC' }), commit: false };
  let nova: ReturnType<typeof createNova> | undefined;
  const start = async () => {
    nova = createNova(config, { secrets: () => null, models: { ollamaUrl: runtime.url, hardware: async () => hubHardware() } });
    await new Promise<void>((resolve) => nova!.server.listen(0, '127.0.0.1', resolve));
    return nova;
  };
  const stop = async () => {
    if (!nova) return;
    nova.scheduler.stop();
    await close(nova.server);
    await nova.core.close();
    assert.equal(nova.server.listening, false);
    nova = undefined;
  };
  return {
    m, start, stop,
    download: () => call(`http://127.0.0.1:${(nova!.server.address() as AddressInfo).port}`, 'GET', '/api/v1/diagnostics'),
    close: async () => {
      try { await stop(); } finally {
        await runtime.close();
        for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      }
    },
  };
}

const scanError = 'Diagnostics could not be downloaded because Nova could not complete its secret check. Try again when the secret stores are available.';
function refusedScan(reply: Awaited<ReturnType<typeof call>>, sensitive: string[]) {
  const text = JSON.stringify(reply.body);
  for (const value of sensitive) {
    for (const form of [value, encodeURIComponent(value), Buffer.from(value).toString('base64'), Buffer.from(value).toString('hex')]) {
      assert.ok(!text.includes(form), 'failed scan response exposed private data');
    }
  }
  assert.equal(reply.status, 503);
  assert.equal(reply.headers.get('content-disposition'), null, 'unsafe bundle must never become an attachment');
  assert.equal(reply.headers.get('cache-control'), 'no-store');
  assert.deepEqual(reply.body, { error: scanError }, 'fixed error only, without raw source errors or warnings');
}

test('production diagnostics refuses a populated vault after real key loss, while empty and readable vaults download', async () => {
  const f = await scanFixture();
  const secret = canary('key-loss');
  const encoded = Buffer.from(secret).toString('base64');
  try {
    const nova = await f.start();
    const empty = await f.download();
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.redaction.warnings, []);
    assert.match(empty.headers.get('content-disposition') ?? '', /^attachment;/);
    nova.core.vault.put('provider/SCAN_CANARY', secret);
    nova.core.log.write('info', 'example', `encoded service detail ${encoded}`);
    const readable = await f.download();
    assert.equal(readable.status, 200);
    assert.deepEqual(readable.body.redaction.warnings, []);
    assert.ok(readable.body.redaction.values_redacted > 0);
    assert.ok(!JSON.stringify(readable.body).includes(encoded));
    await f.stop();
    // Only this disposable fixture's key moves; restart exercises the actual vault decryption.
    renameSync(join(f.m.home, 'vault', 'key'), join(f.m.home, 'vault', 'key.held'));
    const restarted = await f.start();
    assert.equal(restarted.core.vault.status().ok, false);
    const before = files(f.m.home);
    refusedScan(await f.download(), [secret, f.m.home, join(f.m.home, 'vault', 'key')]);
    assert.deepEqual(files(f.m.home), before, 'refusal persists no bundle or problem containing the raw error');
  } finally { await f.close(); }
});

test('production diagnostics rejects incomplete secret scans before reading included free text, without leaking errors', async (t) => {
  const cases = ['list throws', 'second lookup throws', 'second lookup missing', 'key lookup throws', 'key file unreadable', 'identity unreadable', 'identity malformed', 'identity incomplete'] as const;
  for (const failure of cases) await t.test(failure, async (t) => {
    const f = await scanFixture();
    const secret = canary('partial-secret');
    const detail = `${canary('source-error')} at ${join(f.m.home, 'private-source')}`;
    try {
      const nova = await f.start();
      nova.core.vault.put('provider/AAA', canary('first-secret'));
      nova.core.vault.put('provider/ZZZ', secret);
      nova.core.log.write('info', 'example', `encoded service detail ${Buffer.from(secret).toString('base64')}`);
      let includedReads = 0;
      const view = nova.core.models.view.bind(nova.core.models);
      t.mock.method(nova.core.models, 'view', () => { includedReads++; return view(); });
      if (failure === 'list throws') t.mock.method(nova.core.vault, 'list', () => { throw new Error(detail); });
      if (failure === 'second lookup throws' || failure === 'second lookup missing') {
        const get = nova.core.vault.get.bind(nova.core.vault);
        t.mock.method(nova.core.vault, 'get', (name: string) => {
          if (name !== 'provider/ZZZ') return get(name);
          if (failure === 'second lookup missing') return null;
          throw new Error(detail);
        });
      }
      if (failure === 'key lookup throws') t.mock.method(nova.core.vault, 'keyForStandby', () => { throw new Error(detail); });
      if (failure === 'key file unreadable') chmodSync(join(f.m.home, 'vault', 'key'), 0);
      if (failure === 'identity unreadable') chmodSync(join(f.m.home, 'mesh', 'identity.json'), 0);
      if (failure === 'identity malformed') writeFileSync(join(f.m.home, 'mesh', 'identity.json'), detail);
      if (failure === 'identity incomplete') writeFileSync(join(f.m.home, 'mesh', 'identity.json'), JSON.stringify({ ed25519: { private: canary('one-key') } }));
      const before = files(f.m.home);
      refusedScan(await f.download(), [secret, detail, f.m.home]);
      assert.equal(includedReads, 0, 'the required scan must finish before collecting included metadata/free text');
      assert.deepEqual(files(f.m.home), before);
      const log = readFileSync(nova.core.log.file!, 'utf8');
      assert.ok(!log.includes(detail), 'raw scan failure must not enter service logs');
    } finally { t.mock.restoreAll(); await f.close(); }
  });
});
