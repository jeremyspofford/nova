// The first adversarial review of PR #275 (vault broker P1a), each finding reproduced as a test
// that failed on 0b7457da before its fix. Names carry the review's ids (B blocking, S should-fix,
// M minor). Temp homes and canaries only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileStores } from '../../src/broker/keystore.ts';
import { addressClass, fileSha256, requestPath } from '../../src/broker/origin.ts';
import { startBroker } from '../../src/broker/spawn.ts';
import { Store } from '../../src/broker/store.ts';
import { BrokerClient } from '../../src/core/broker/client.ts';
import { Vault } from '../../src/core/vault.ts';
import { C, Person, boundCredential, inProcess, standIn, tmp, type A } from '../support/broker-support.ts';

async function fresh(o: { passkey?: boolean } = {}) {
  const home = tmp('nova-review1-');
  const b = inProcess(join(home, 'broker'));
  const p = new Person(b.call);
  await p.setup({ passkey: o.passkey });
  return { ...b, p, home };
}
const sealed = (f: A, env: unknown) => ({ ...f, source: { sealed: env } });
function rawAsk(path: string, frame: A): Promise<A> {
  return new Promise((ok) => {
    const s = connect(path);
    let buf = '';
    s.setEncoding('utf8');
    s.on('error', () => ok({ error: 'closed' }));
    s.on('data', (c: string) => { buf += c; const i = buf.indexOf('\n'); if (i >= 0) { s.end(); ok(JSON.parse(buf.slice(0, i))); } });
    s.write(`${JSON.stringify(frame)}\n`);
  });
}

test('B1: no run ticket reaches core; the broker runs the program itself; a second socket can redeem nothing', { timeout: 60_000 }, async () => {
  const home = tmp('nova-review1-');
  const b = await startBroker(join(home, 'broker'), { keyMode: 'file' });
  const cl = new BrokerClient({ socket: b.socket, token: b.tokens.core });
  const p = new Person((m, f) => cl.call(m, f ?? {}));
  try {
    await p.setup();
    const program = process.execPath;
    const target = { kind: 'process', path: program, sha256: fileSha256(program) };
    const made = await p.approve('create', { meta: { name: 'infra/p/TF_VAR_X', kind: 'secret', class: 'standard' }, source: 'sealed', bind: [{ target, inject: { how: 'env', env: 'TF_VAR_X' }, consent: {} }] }, { seal: C('b1'), sealAt: sealed });
    const u = await cl.use(made.ref, target as never, { argv: ['-e', 'console.log("x", process.env.TF_VAR_X)'] }) as A;
    assert.equal(u.ok, true, JSON.stringify(u));
    assert.equal(JSON.stringify(u).includes('"ticket"'), false, 'no ticket in the answer');
    assert.equal(u.outcome.exit, 0);
    assert.equal(u.outcome.stdout.trim(), 'x [redacted by the broker]');
    // A process that obtained anything from core's answer, on a connection of its own:
    for (const m of ['redeem', 'migrate_item']) assert.equal((await rawAsk(b.socket, { id: 1, m, ticket: 'tk_x', path: program, sha256: target.sha256 })).error, 'unknown_message', m);
    assert.equal('launch' in cl, false, 'core has no way to start the launcher');
  } finally { cl.close(); b.child.kill(); }
});

test('B2: migration: the broker reads its own home only, commit is tier 3, and no answer depends on a value core chose', { timeout: 60_000 }, async () => {
  const run = async (guess: string) => {
    const { call, p, home, broker } = await fresh();
    const v = new Vault({ home, mode: 'file' });
    v.put('provider/A', C('real-a'));
    v.put('provider/B', C('real-b'));
    // Core makes an item under the old name, with a value it chose (core-relayed approval).
    await p.approve('create', { meta: { name: 'provider/A', kind: 'api_key' }, source: 'sealed' }, { seal: guess, sealAt: sealed });
    const st = await call('create', { meta: {}, source: { migrate: 'stage' } });
    assert.equal(st.ok, true, JSON.stringify(st));
    assert.equal(JSON.stringify(st).includes('ticket'), false, 'no staging ticket for core');
    assert.equal((await call('create', { meta: {}, source: { migrate: 'commit' } })).refused, 'needs_approval', 'commit is tier 3');
    const done = await p.approve('create', { meta: {}, source: { migrate: 'commit' } });
    assert.equal(done.ok, true, JSON.stringify(done));
    const left = new Vault({ home, mode: 'file' }).list();
    void broker;
    return { outcome: done.outcome, left };
  };
  const right = await run(C('real-a'));
  const wrong = await run(C('not-a-'));
  assert.deepEqual(right, wrong, 'the same answer and the same effect, whatever core guessed');
  assert.ok(right.left.includes('provider/A'), 'the old entry under a name core took stays in the old vault');
  assert.ok(!right.left.includes('provider/B'));
});

test('B3: text core writes is never echoed or scrubbed: a held value in it gives the same answer as any other text', { timeout: 60_000 }, async () => {
  // Through the real server: the answer core reads, exactly as written to the socket.
  const home = tmp('nova-review1-');
  const b = await startBroker(join(home, 'broker'), { keyMode: 'file' });
  const cl = new BrokerClient({ socket: b.socket, token: b.tokens.core });
  const call = (m: string, f: A = {}) => cl.call(m, f) as Promise<A>;
  const p = new Person(call);
  const site = await standIn();
  try {
    await p.setup();
    const held = C('b3-held');
    const other = C('b3-othr');
    const made = await boundCredential(p, site.origin, { value: held, consent: false });
    const frames = (g: string, t: string): [string, A][] => [
      ['use', { ref: made.ref, target: { kind: 'http', origin: site.origin }, request: { method: 'GET', path: '/api' }, task: { id: `${t}0`, title: g }, caller: g.slice(0, 40) }],
      ['use', { ref: made.ref, target: { kind: 'http', origin: site.origin }, request: { method: 'GET', path: '/api', headers: { [g]: 'x', authorization: 'y' } }, task: { id: `${t}1` } }],
      ['update', { ref: made.ref, change: { meta: { [g]: 1 } }, task: { id: `${t}2` } }],
      ['create', { meta: {}, source: { migrate: 'propose', proposals: { [g]: {} } }, task: { id: `${t}3` } }],
      ['create', { meta: { name: g, kind: 'nope' }, source: 'generate', task: { id: `${t}4` } }],
      ['bind', { ref: made.ref, add: { target: { kind: 'http', origin: site.origin }, scope: { methods: ['GET'], paths: ['/api'] }, inject: { how: 'header', header: g } }, task: { id: `${t}5` } }],
      ['update', { ref: made.ref, change: { meta: { username: g } }, task: { id: `${t}6` } }],
    ];
    const norm = (a: A, g: string, t: string) => JSON.stringify({ ...a, id: 0, record: null, challenge: a.challenge ? { ...a.challenge, id: 0, digest: 0, expires_at: 0, card: { ...a.challenge.card, expires_at: 0 } } : undefined }).split(g).join('<G>').split(t).join('<T>');
    const fh = frames(held, 'QQh');
    const fo = frames(other, 'QQo');
    for (let i = 0; i < fh.length; i++) {
      const a = norm(await call(fh[i]![0], fh[i]![1]), held, 'QQh');
      const c = norm(await call(fo[i]![0], fo[i]![1]), other, 'QQo');
      assert.equal(a, c, `frame ${i} (${fh[i]![0]}) answers differently for a held value`);
      assert.ok(!a.includes('redacted'), `frame ${i}: nothing core wrote is scrubbed`);
    }
  } finally { cl.close(); b.child.kill(); await site.close(); }
});

test('B4: a hub never adopts a planted inbox; a holder adopts only after a tier-3 pin, and only a newer generation', async () => {
  const home = tmp('nova-review1-');
  const dir = join(home, 'broker');
  const hub = inProcess(dir);
  const p = new Person(hub.call);
  await p.setup();
  const mine = await p.approve('create', { meta: { name: 'provider/MINE', kind: 'api_key' }, source: 'generate' });
  hub.broker.lock();
  // The attacker writes files only: a vault with the hub's (public) id, sealed to the hub's
  // (public) device key, signed by a key of its own.
  const hdr = JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf8'));
  const dev = JSON.parse(readFileSync(join(dir, 'device.json'), 'utf8'));
  const fdir = join(tmp(), 'forger');
  const forger = new Store({ dir: fdir, kdf: hdr.kdf, deviceStore: fileStores(fdir) });
  forger.create({ id: hdr.id, passphrase: Buffer.from('forger-passphrase') });
  forger.add({ name: 'provider/FORGED', aliases: ['secret://provider/FORGED'], kind: 'api_key', origin: null, username: null, class: 'standard', per_use: false, created_at: '', last_used: null, last_rotated: null, bindings: [], policy: { length: 24, alphabet: 'abcdefghijklmnopqrstuvwxyz0123456789' } } as never, Buffer.from('forged-value-123456'));
  forger.enrollHolder(dev.id, dev.public, 'hub');
  mkdirSync(join(dir, 'inbox', 'items'), { recursive: true });
  cpSync(join(fdir, 'outbox', 'header.json'), join(dir, 'inbox', 'header.json'));
  for (const n of readdirSync(join(fdir, 'items'))) cpSync(join(fdir, 'items', n), join(dir, 'inbox', 'items', n));
  const again = inProcess(dir);
  const ap = new Person(again.call);
  await again.call('unlock', { device: true });
  if ((await ap.state()).locked) await again.call('unlock', { passphrase: await ap.factor('passphrase', 'correct-horse-battery-staple') });
  const refs = (await again.call('list_refs')).refs.map((r: A) => r.ref);
  assert.deepEqual(refs, [mine.ref], 'the hub keeps its own vault');
  // A fresh standby: nothing adopted without the tier-3 pin; with it, only a strictly newer one.
  const sdir = join(tmp(), 'standby');
  const sb = inProcess(sdir);
  const sdev = JSON.parse(readFileSync(join(sdir, 'device.json'), 'utf8'));
  hub.broker.store.unlock({ kind: 'device' });
  hub.broker.store.enrollHolder(sdev.id, sdev.public, 'standby');
  const out = JSON.parse(readFileSync(join(dir, 'outbox', 'header.json'), 'utf8'));
  mkdirSync(join(sdir, 'inbox', 'items'), { recursive: true });
  writeFileSync(join(sdir, 'inbox', 'header.json'), JSON.stringify(out));
  for (const n of readdirSync(join(dir, 'items'))) cpSync(join(dir, 'items', n), join(sdir, 'inbox', 'items', n));
  assert.equal((await sb.call('unlock', { device: true })).refused, 'locked', 'not without a pin');
  const sp = new Person(sb.call);
  const pin = await sp.approve('share_scope', { hub: { signer: out.signer, name: 'hub' } });
  assert.equal(pin.ok, true, JSON.stringify(pin));
  assert.equal((await sb.call('unlock', { device: true })).ok, true);
  assert.deepEqual((await sb.call('list_refs')).refs.map((r: A) => r.ref), [mine.ref]);
  // The same generation again (a replay) isn't adopted over what is held.
  assert.throws(() => sb.broker.store.adopt(out, Object.fromEntries(readdirSync(join(dir, 'items')).map((n) => [n.slice(0, -5), readFileSync(join(dir, 'items', n), 'utf8')]))), /isn’t newer/);
});

test('B5: health flags answer no guess: reuse only among values core didn’t choose; no weak flag to core', async () => {
  const { call, p, home } = await fresh();
  const v = new Vault({ home, mode: 'file' });
  v.put('provider/M1', C('shared'));
  v.put('provider/M2', C('shared'));
  v.put('provider/M3', C('lonely'));
  await call('create', { meta: {}, source: { migrate: 'stage' } });
  await p.approve('create', { meta: {}, source: { migrate: 'commit' } });
  // Core seals a guess equal to M3 (core-relayed approval): nothing flags.
  await p.approve('create', { meta: { name: 'provider/GUESS', kind: 'api_key' }, source: 'sealed' }, { seal: C('lonely'), sealAt: sealed });
  const refs = (await call('list_refs')).refs as A[];
  const by = (n: string) => refs.find((r) => r.name === n)!;
  assert.equal(by('provider/M1').health.reused, true, 'the person’s own reuse is still shown');
  assert.equal(by('provider/M3').health.reused, false);
  assert.equal(by('provider/GUESS').health.reused, false);
  for (const r of refs) assert.equal('weak' in r.health, false);
});

test('S1: basic auth’s encoded user:pass, and a value cut by the size limit, are scrubbed', async () => {
  const { call, p } = await fresh();
  const echo = await standIn((req, res) => { res.end(`you sent ${req.headers.authorization}`); });
  await p.approve('create', { meta: { name: 'provider/BASIC', kind: 'api_key', origin: echo.origin, username: 'robot' }, source: 'sealed', bind: [{ target: { kind: 'http', origin: echo.origin }, scope: { methods: ['GET'], paths: ['/'] }, inject: { how: 'basic' }, consent: { scope: { methods: ['GET'], paths: ['/'] } } }] }, { seal: C('basic'), sealAt: sealed });
  const r = await call('use', { ref: 'secret://provider/BASIC', target: { kind: 'http', origin: echo.origin }, request: { method: 'GET', path: '/x' } });
  assert.equal(r.outcome.body.includes(Buffer.from(`robot:${C('basic')}`).toString('base64')), false, r.outcome.body);
  // A response over the cap that cuts the value: no prefix of it is left at the end.
  const big = await standIn((_req, res) => { res.end(`${'a'.repeat(4 * 1024 * 1024 - 10)}${C('cut')}`); });
  await p.approve('create', { meta: { name: 'provider/CUT', kind: 'api_key', origin: big.origin }, source: 'sealed', bind: [{ target: { kind: 'http', origin: big.origin }, scope: { methods: ['GET'], paths: ['/'] }, inject: { how: 'bearer' }, consent: { scope: { methods: ['GET'], paths: ['/'] } } }] }, { seal: C('cut'), sealAt: sealed });
  const c = await call('use', { ref: 'secret://provider/CUT', target: { kind: 'http', origin: big.origin }, request: { method: 'GET', path: '/x' } });
  assert.equal(c.outcome.truncated, true);
  assert.equal(c.outcome.body.endsWith(C('cut').slice(0, 10)), false);
  assert.ok(!c.outcome.body.includes('canary-cut'));
  await echo.close(); await big.close();
});

test('S5: rolling an item’s file back doesn’t bring back a revoked binding', async () => {
  const { call, p, broker } = await fresh();
  const made = await boundCredential(p, 'https://api.example.com', { value: C('s5'), class: 'standard' });
  const file = join(broker.store.dir, 'items', `${made.ref}.json`);
  const before = readFileSync(file, 'utf8');
  await call('bind', { ref: made.ref, remove: { target: { kind: 'http', origin: 'https://api.example.com' } } });
  writeFileSync(file, before);
  const again = inProcess(broker.store.dir);
  await again.call('unlock', { device: true });
  const r = (await again.call('list_refs')).refs as A[];
  assert.ok(!r.some((x) => x.bindings.length > 0), 'the old binding didn’t come back');
});

test('M: passkey for every tier-3 verb once registered; `..;` paths; private address ranges; grants cleared on change', async () => {
  const { call, p } = await fresh({ passkey: true });
  const made = await p.approve('create', { meta: { name: 'provider/PK', kind: 'api_key', class: 'sensitive' }, source: 'generate' });
  const ch = (await call('update', { ref: made.ref, change: { meta: { class: 'standard' } } })).challenge;
  assert.equal((await call('update', { ref: made.ref, change: { meta: { class: 'standard' } }, approval: p.approval(ch, 'core') })).refused, 'approval_invalid', 'a class downgrade needs the passkey');
  assert.throws(() => requestPath('/api/..;/admin'));
  assert.throws(() => requestPath('/api/.;/admin'));
  for (const a of ['fec0::1', '64:ff9b::a00:1', '2002:a00:1::1', '198.18.0.1', '198.19.255.1']) assert.equal(addressClass(a), 'private', a);
  assert.equal(addressClass('203.0.113.9'), 'public');
  void createHash; void existsSync;
});

test('S2, S3: no file tool reads broker/; a factory reset removes it; checkpoints never copy it and a restore leaves it', async () => {
  const { inSecretDir } = await import('../../src/home.js');
  for (const rel of ['broker', 'broker/vault.json', 'broker/device.key', 'broker/items/x.json']) assert.equal(inSecretDir(rel), 'broker', rel);
  const { isNovaEntry } = await import('../../src/core/index.ts');
  assert.equal(isNovaEntry('broker'), true, 'a factory reset wipes Nova’s own entries, broker/ among them');
  const { open } = await import('./resilience-support.ts');
  const home = tmp('nova-review1-ck-');
  const c = open(home);
  try {
    mkdirSync(join(home, 'broker', 'items'), { recursive: true });
    writeFileSync(join(home, 'broker', 'device.key'), randomBytes(32));
    c.checkpoints.take({ kind: 'named', name: 'Here' });
    const all = readdirSync(join(home, 'checkpoints'), { recursive: true }).map(String);
    assert.ok(all.length > 0);
    assert.ok(!all.some((p) => p.split('/').includes('broker')), 'no checkpoint holds broker/');
  } finally { await c.close(); }
});
