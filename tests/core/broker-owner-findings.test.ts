// Owner findings A: temp homes, loopback stand-ins and synthetic values only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { Vault } from '../../src/core/vault.ts';
import { C, Person, boundCredential, inProcess, standIn, tmp, type A } from '../support/broker-support.ts';

async function fresh(passkey = false) {
  const home = tmp('nova-owner-findings-');
  const b = inProcess(join(home, 'broker'));
  const p = new Person(b.call);
  await p.setup({ passkey });
  return { ...b, p, home };
}
const scope = { methods: ['GET', 'POST'], paths: ['/api'] };
const binding = (inject: A, origin = 'https://api.example.com') => ({ target: { kind: 'http', origin }, scope, inject });

test('SEC01: migration commit with a registered passkey refuses core approval and preserves old entries', async () => {
  const { home, call, p } = await fresh(true);
  const old = new Vault({ home, mode: 'file' });
  old.put('provider/A', C('sec01'));
  await call('create', { source: { migrate: 'stage' } });
  const frame = { source: { migrate: 'commit' } };
  const ch = (await call('create', frame)).challenge;
  const denied = await call('create', { ...frame, approval: p.approval(ch, 'core') });
  assert.equal(denied.refused, 'approval_invalid');
  assert.equal(new Vault({ home, mode: 'file' }).get('provider/A'), C('sec01'));
  assert.equal((await call('create', { ...frame, approval: p.approval(ch) })).ok, true);
});

for (const [field, before, after] of [
  ['header', { how: 'header', header: 'X-Service-Key' }, { how: 'header', header: 'X-Other-Key' }],
  ['prefix', { how: 'header', header: 'X-Key', prefix: 'Token ' }, { how: 'header', header: 'X-Key', prefix: 'Other ' }],
  ['format', { how: 'sign', header: 'X-Signature', format: 'hex' }, { how: 'sign', header: 'X-Signature', format: 'base64' }],
] as [string, A, A][]) {
  for (const verb of ['create', 'bind', 'propose']) test(`SEC02: ${verb} approval binds injection ${field}`, async () => {
    const { call, p } = await fresh();
    const meta = { name: 'provider/A', kind: 'api_key', class: 'standard' };
    let ref: string | undefined;
    if (verb !== 'create') ref = (await p.approve('create', { meta, source: 'generate' })).ref;
    const frame = (inj: A) => verb === 'create' ? { meta, source: 'generate', bind: [binding(inj)] }
      : verb === 'bind' ? { ref, add: binding(inj) }
      : { source: { migrate: 'propose', proposals: { 'provider/A': { class: 'standard', bind: [binding(inj)] } } } };
    const method = verb === 'bind' ? 'bind' : 'create';
    const first = await call(method, frame(before));
    assert.equal(first.refused, 'needs_approval');
    const changed = await call(method, { ...frame(after), approval: p.approval(first.challenge) });
    assert.equal(changed.refused, 'approval_invalid');
  });
}

test('SEC02: approval card shows meaningful injection settings for each bound action', async () => {
  const { call, p } = await fresh();
  const inject = { how: 'sign', header: 'X-Signature', prefix: 'sha256=', format: 'base64' };
  const meta = { name: 'provider/A', kind: 'api_key', class: 'standard' };
  const made = await p.approve('create', { meta, source: 'generate' });
  for (const [m, frame] of [
    ['create', { meta: { ...meta, name: 'provider/B' }, source: 'generate', bind: [binding(inject)] }],
    ['bind', { ref: made.ref, add: binding(inject) }],
    ['create', { source: { migrate: 'propose', proposals: { 'provider/A': { class: 'standard', bind: [binding(inject)] } } } }],
  ] as [string, A][]) {
    const response = await call(m, frame);
    assert.equal(response.refused, 'needs_approval');
    const card = JSON.stringify(response.challenge.card);
    for (const setting of ['X-Signature', 'sha256=', 'base64']) assert.ok(card.includes(setting), setting);
  }
});

for (const format of ['hex', 'base64'] as const) test(`SEC03: echoed ${format} signatures and supported encodings are scrubbed`, async () => {
  const site = await standIn((req, res) => {
    const signature = String(req.headers['x-signature']);
    const raw = signature.slice('sha256='.length);
    const representations = (s: string) => [s, Buffer.from(s).toString('base64'), Buffer.from(s).toString('base64url'), Buffer.from(s).toString('hex'), encodeURIComponent(s), JSON.stringify(s).slice(1, -1)];
    res.setHeader('x-request-id', signature);
    res.end(JSON.stringify([...representations(signature), ...representations(raw)]));
  });
  try {
    const { call, p } = await fresh();
    const meta = { name: 'provider/SIGN', kind: 'signing_key', class: 'standard' };
    const inject = { how: 'sign', header: 'X-Signature', prefix: 'sha256=', format };
    const made = await p.approve('create', { meta, source: 'sealed', bind: [{ ...binding(inject, site.origin), consent: { scope } }] }, { seal: C('sec03'), sealAt: (f, sealed) => ({ ...f, source: { sealed } }) });
    const result = await call('use', { ref: made.ref, target: { kind: 'http', origin: site.origin }, request: { method: 'POST', path: '/api', body: 'synthetic body' } });
    assert.equal(result.ok, true);
    assert.equal(site.requests.length, 1);
    const digest = createHmac('sha256', C('sec03')).update('synthetic body').digest(format);
    assert.equal(site.requests[0]!.headers['x-signature'], `sha256=${digest}`);
    assert.ok(!JSON.stringify(result).includes(digest), 'no raw HMAC returned');
    assert.ok(!JSON.stringify(result).includes(Buffer.from(digest).toString('base64')), 'no encoded HMAC returned');
    assert.ok(result.outcome.body.includes('[redacted by the broker]'));
    assert.equal(result.outcome.headers['x-request-id'], '[redacted by the broker]');
    for (const echoed of JSON.parse(result.outcome.body)) assert.ok(echoed.includes('[redacted by the broker]'), 'each supported signature representation is scrubbed');
  } finally { await site.close(); }
});

for (const mode of ['update', 'propose']) test(`SEC04: ${mode} refuses sensitive class with any retained standing consent`, async () => {
  const { call, p } = await fresh();
  const made = await boundCredential(p, 'https://api.example.com', { class: 'standard' });
  const frame = mode === 'update' ? { ref: made.ref, change: { meta: { class: 'sensitive' } } }
    : { source: { migrate: 'propose', proposals: { 'provider/EXAMPLE_KEY': { class: 'sensitive', bind: [binding({ how: 'bearer' }, 'https://other.example.com')] } } } };
  const result = await p.approve(mode === 'update' ? 'update' : 'create', frame);
  assert.equal(result.refused, 'class_policy');
  const stored = (await call('list_refs')).refs[0];
  assert.equal(stored.class, 'standard');
  assert.ok(stored.bindings[0].consent);
});

test('SEC05: old entry changed after staging survives commit and resumed migration', async () => {
  const { home, call, p } = await fresh();
  const old = new Vault({ home, mode: 'file' });
  old.put('provider/A', C('sec05-before'));
  await call('create', { source: { migrate: 'stage' } });
  old.put('provider/A', C('sec05-after'));
  await p.approve('create', { source: { migrate: 'commit' } });
  assert.equal(new Vault({ home, mode: 'file' }).get('provider/A'), C('sec05-after'));
  await call('create', { source: { migrate: 'stage' } });
  await p.approve('create', { source: { migrate: 'commit' } });
  assert.equal(new Vault({ home, mode: 'file' }).get('provider/A'), C('sec05-after'), 'a prior migrated name is not proof that the newer value was read back');
});

test('SEC05: old-vault writes fail closed while migration holds the writer lock', async () => {
  const { mkdirSync, rmSync } = await import('node:fs');
  const { home } = await fresh();
  const old = new Vault({ home, mode: 'file' });
  old.put('provider/A', C('lock-before'));
  const lock = join(home, 'vault', '.writer-lock');
  mkdirSync(lock);
  try { assert.throws(() => old.put('provider/A', C('lock-after')), /busy|migration/i); }
  finally { rmSync(lock, { recursive: true }); }
  assert.equal(new Vault({ home, mode: 'file' }).get('provider/A'), C('lock-before'));
});

test('SEC05: a cached old-vault writer reloads after migration rekeys the remaining entries', async () => {
  const { home, call, p } = await fresh();
  const old = new Vault({ home, mode: 'file' });
  old.put('provider/A', C('reload-migrate'));
  old.put('nova/backup-key', C('reload-own'));
  await call('create', { source: { migrate: 'stage' } });
  const result = await p.approve('create', { source: { migrate: 'commit' } });
  assert.equal(result.ok, true);
  old.put('nova/backup-key', C('reload-new'));
  const reopened = new Vault({ home, mode: 'file' });
  assert.equal(reopened.get('provider/A'), null, 'cached state must not resurrect the migrated credential');
  assert.equal(reopened.get('nova/backup-key'), C('reload-new'));
});


test('SEC05: a concurrent old-vault writer retains its latest acknowledged value', { timeout: 30_000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const { home, call, p } = await fresh();
  new Vault({ home, mode: 'file' }).put('provider/A', C('concurrent-stage'));
  await call('create', { source: { migrate: 'stage' } });
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { Vault } = await import(process.argv[1]);
    const old = new Vault({ home: process.argv[2], mode: 'file' });
    let latest = '';
    for (let i = 0; i < 100; i++) {
      const value = 'synthetic-concurrent-canary-' + i;
      try { old.put('provider/A', value); latest = value; }
      catch (e) { if (e.code !== 'conflict') throw e; }
      if (i === 0) process.send({ ready: true });
      await new Promise(ok => setTimeout(ok, 5));
    }
    process.send({ latest });
  `, pathToFileURL(join(import.meta.dirname, '../../src/core/vault.ts')).href, home], { env: { TZ: 'UTC' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = '';
  child.stderr!.on('data', (data) => { errors += data; });
  let ready!: () => void;
  let done!: (latest: string) => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const finished = new Promise<string>((resolve, reject) => {
    done = resolve;
    child.on('error', reject);
    child.on('exit', (code) => { if (code !== 0) reject(new Error(errors || `writer exited ${code}`)); });
  });
  child.on('message', (m: A) => { if (m.ready) ready(); if (m.latest) done(m.latest); });
  try {
    await started;
    await p.approve('create', { source: { migrate: 'commit' } });
    const latest = await finished;
    assert.equal(new Vault({ home, mode: 'file' }).get('provider/A'), latest);
  } finally { child.kill(); }
});

test('SEC05: a core-replaced migrated entry is kept regardless of the replacement guess', async () => {
  const run = async (guess: string) => {
    const { home, call, p } = await fresh();
    const old = new Vault({ home, mode: 'file' });
    old.put('provider/A', C('provenance-real'));
    old.put('nova/backup-key', C('provenance-own'));
    await call('create', { source: { migrate: 'stage' } });
    await p.approve('create', { source: { migrate: 'commit' } });
    await p.approve('update', { ref: 'secret://provider/A', change: { value: 'sealed' } }, { seal: guess, sealAt: (f, sealed) => ({ ...f, change: { value: { sealed } } }) });
    old.put('provider/A', C('provenance-real'));
    await call('create', { source: { migrate: 'stage' } });
    const result = await p.approve('create', { source: { migrate: 'commit' } });
    assert.equal(new Vault({ home, mode: 'file' }).get('provider/A'), C('provenance-real'));
    assert.equal(result.outcome.removed, 0);
    return result.outcome;
  };
  assert.deepEqual(await run(C('provenance-real')), await run(C('provenance-wrong')));
});
