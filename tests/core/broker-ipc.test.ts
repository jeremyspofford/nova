// The broker's process and IPC (docs/plans/vault-broker.md §3; gate items 5 and 6): started the
// way the supervisor starts it (Node's permission model, empty environment), reached only over a
// 0600 socket in a 0700 folder, answering the seven verbs and three protocol messages and nothing
// else; no inet listener at idle or after any verb; a program whose binary isn't the bound one gets
// nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { ANSWER_KEYS, VERBS } from '../../src/broker/protocol.ts';
import { fileSha256 } from '../../src/broker/origin.ts';
import { startBroker } from '../../src/broker/spawn.ts';
import { BrokerClient } from '../../src/core/broker/client.ts';
import { C, Person, boundCredential, standIn, tmp, type A } from '../support/broker-support.ts';

function raw(path: string) {
  const s = connect(path);
  s.setEncoding('utf8');
  let buf = '';
  const queue: A[] = [];
  const waiters: ((a: A) => void)[] = [];
  s.on('data', (c: string) => {
    buf += c;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) { const a = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const w = waiters.shift(); if (w) w(a); else queue.push(a); }
  });
  s.on('error', () => { /* the broker closed it: seen through `closed` */ });
  const closed = new Promise<void>((ok) => s.on('close', () => ok()));
  return {
    send: (x: A | string) => s.write(`${typeof x === 'string' ? x : JSON.stringify(x)}\n`),
    next: () => new Promise<A>((ok) => { const q = queue.shift(); if (q) ok(q); else waiters.push(ok); }),
    ask(x: A) { this.send(x); return this.next(); },
    closed, end: () => s.end(),
  };
}

// The inet sockets a process has open, from /proc (Linux): its socket inodes matched against the
// kernel's tcp/udp tables, and which of them are listening.
function inetSockets(pid: number): { listening: number; connected: number } {
  const inodes = new Set<string>();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) { try { const l = readlinkSync(`/proc/${pid}/fd/${fd}`); const m = /^socket:\[(\d+)\]$/.exec(l); if (m) inodes.add(m[1]!); } catch { /* closed meanwhile */ } }
  let listening = 0;
  let connected = 0;
  for (const t of ['tcp', 'tcp6', 'udp', 'udp6']) {
    let text = '';
    try { text = readFileSync(`/proc/${pid}/net/${t}`, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || !inodes.has(f[9]!)) continue;
      if (f[3] === '0A' || t.startsWith('udp')) listening++; else connected++;
    }
  }
  return { listening, connected };
}

test('the process: permission model, empty environment, a 0600 socket in a 0700 folder, and nothing else listening', { timeout: 60_000 }, async () => {
  const dir = join(tmp(), 'broker');
  const b = await startBroker(dir, { keyMode: 'file' });
  try {
    assert.ok(b.child.spawnargs.includes('--permission') && b.child.spawnargs.includes('--disable-sigusr1'));
    assert.ok(!b.child.spawnargs.some((x) => /--inspect|--allow-worker|--allow-addons|--allow-fs-read=\*|--allow-fs-write=\*/.test(x)), 'no inspector, workers or addons; no file-system wildcard');
    assert.equal(statSync(join(dir, 'run')).mode & 0o777, 0o700);
    assert.equal(statSync(b.socket).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    if (process.platform === 'linux') {
      const env = readFileSync(`/proc/${b.child.pid}/environ`, 'utf8').split('\0').filter(Boolean);
      assert.deepEqual(env.map((e) => e.split('=')[0]).filter((k) => !/^NODE_CHANNEL_/.test(k!)), ['TZ'], 'an empty environment (beside Node’s own IPC channel): no NODE_OPTIONS, no proxy, no token');
      assert.ok(!readFileSync(`/proc/${b.child.pid}/cmdline`, 'utf8').includes(b.tokens.core), 'the tokens aren’t on argv');
      assert.deepEqual(inetSockets(b.child.pid!), { listening: 0, connected: 0 }, 'idle: no inet socket at all');
    }
  } finally { b.child.kill(); }
});

test('the protocol: hello with a token, seven verbs and three messages; everything else refused', { timeout: 60_000 }, async () => {
  const dir = join(tmp(), 'broker');
  const b = await startBroker(dir, { keyMode: 'file' });
  try {
    const c = raw(b.socket);
    assert.equal((await c.ask({ id: 1, m: 'list_refs' })).error, 'unauthenticated');
    assert.equal((await c.ask({ id: 2, m: 'redeem', ticket: 'tk_made_up' })).error, 'unknown_message', 'there are no launcher messages on this socket');
    assert.equal((await c.ask({ id: 3, m: 'hello', token: b.tokens.supervisor })).role, 'supervisor');
    assert.equal((await c.ask({ id: 4, m: 'hello', token: b.tokens.core })).error, 'not_allowed', 'one role per connection');
    assert.equal((await c.ask({ id: 5, m: 'migrate_item', ticket: 'x' })).error, 'unknown_message');
    assert.equal((await c.ask({ id: 6, m: 'create', meta: {} })).error, 'failed', 'the supervisor lists and locks only');
    // Fuzzed verb names.
    const names = ['get', 'read', 'reveal', 'show', 'export', 'dump', 'decrypt', 'value', 'get_value', 'resolve', 'list', 'eval', 'exec', 'shell', 'sign', 'encrypt', 'USE', 'Use', 'use ', ' use', 'list_refs\u0000', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'prototype', '', 'unlock_and_get', 'redeem_value', ...Array.from({ length: 40 }, (_, i) => Buffer.from(`${i}-fuzz-${Math.random()}`).toString('base64url').slice(0, 3 + (i % 12)))];
    for (const [i, m] of names.entries()) assert.equal((await c.ask({ id: 100 + i, m })).error, 'unknown_message', JSON.stringify(m));
    assert.equal((await c.ask({ id: 200, m: 'list_refs', reveal: true })).error, 'unknown_field');
    assert.equal((await c.ask({ id: 201, m: 'use', ref: 'x', __proto__: { x: 1 }, show_value: true } as A)).error, 'unknown_field');
    c.send('not json');
    assert.equal((await c.next()).error, 'bad_frame');
    c.send({ m: 'list_refs' });
    assert.equal((await c.next()).error, 'bad_frame', 'every request has an id');
    c.send({ id: 7, m: 'list_refs', filter: 'x'.repeat(3 * 1024 * 1024) });
    assert.equal((await c.next()).error, 'too_large');
    await c.closed;
    const bad = raw(b.socket);
    assert.equal((await bad.ask({ id: 1, m: 'hello', token: 'f'.repeat(64) })).error, 'unauthenticated');
    await bad.closed;
    assert.equal(VERBS.length, 7);
  } finally { b.child.kill(); }
});

test('no network surface: no inet listener after every verb; a use aimed at an unbound host makes no connection; answers fit the schema', { timeout: 60_000 }, async () => {
  const dir = join(tmp(), 'broker');
  const b = await startBroker(dir, { keyMode: 'file' });
  const cl = new BrokerClient({ socket: b.socket, token: b.tokens.core });
  const answers: A[] = [];
  const call = async (m: string, f: A = {}) => { const a = await cl.call(m, f); answers.push(a); return a; };
  const p = new Person(call);
  const site = await standIn();
  const other = await standIn();
  const check = (after: string) => { if (process.platform === 'linux') assert.equal(inetSockets(b.child.pid!).listening, 0, `an inet listener after ${after}`); };
  try {
    if (process.platform === 'linux') assert.ok(inetSockets(process.pid).listening >= 2, 'a control: the same reading sees this process’s own stand-ins listening');
    await p.setup(); check('unlock');
    const made = await boundCredential(p, site.origin, { value: C('ipc') }); check('create');
    await call('list_refs'); check('list_refs');
    await call('use', { ref: made.ref, target: { kind: 'http', origin: site.origin }, request: { method: 'GET', path: '/api' } }); check('use');
    const before = other.connections;
    assert.equal((await call('use', { ref: made.ref, target: { kind: 'http', origin: other.origin }, request: { method: 'GET', path: '/api' } })).refused, 'not_bound');
    assert.equal(other.connections, before, 'the unbound host saw no connection');
    await p.approve('update', { ref: made.ref, change: { meta: { username: 'x' } } }); check('update');
    await p.approve('rotate', { ref: made.ref, phase: 'begin' }); check('rotate');
    await call('rotate', { ref: made.ref, phase: 'abandon' });
    await call('bind', { ref: made.ref, remove: { target: { kind: 'http', origin: site.origin }, consent_only: true } }); check('bind');
    await call('share_scope', { backend: {} }); check('share_scope');
    await call('lock'); check('lock');
    // A schema check over every answer type the broker sent: no key outside the allowed set, and
    // none of the allowed keys is one that names a value.
    const keys = new Set<string>();
    const walk = (v: unknown, inHeaders = false): void => {
      if (Array.isArray(v)) { for (const x of v) walk(x); return; }
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (!inHeaders) keys.add(k); walk(x, k === 'headers' || k === 'methods'); }
    };
    walk(answers);
    for (const k of keys) assert.ok(ANSWER_KEYS.has(k), `answer key ${k}`);
    for (const k of ['value', 'secret', 'password', 'passphrase', 'plaintext', 'recovery', 'prf', 'grant', 'seed', 'root', 'key', 'token', 'cleartext', 'length', 'hash_of_value']) assert.ok(!ANSWER_KEYS.has(k), `${k} can’t be in an answer`);
  } finally { cl.close(); b.child.kill(); await site.close(); await other.close(); }
});

test('the launcher: the broker runs the bound program itself; a swapped binary gets nothing; no loader variables from core', { timeout: 60_000 }, async () => {
  const dir = join(tmp(), 'broker');
  const b = await startBroker(dir, { keyMode: 'file' });
  const cl = new BrokerClient({ socket: b.socket, token: b.tokens.core });
  const p = new Person((m, f) => cl.call(m, f ?? {}));
  try {
    await p.setup();
    const program = join(tmp(), 'fake-tofu.sh');
    writeFileSync(program, '#!/bin/sh\necho "tofu sees $TF_VAR_X [$NODE_OPTIONS] $TF_IN_AUTOMATION"\nexit 3\n', { mode: 0o755 });
    const sha256 = fileSha256(program);
    const target = { kind: 'process', path: program, sha256 } as const;
    const made = await p.approve('create', { meta: { name: 'infra/p/TF_VAR_X', kind: 'secret', class: 'standard' }, source: 'sealed', bind: [{ target, inject: { how: 'env', env: 'TF_VAR_X' }, consent: {} }] }, { seal: C('launcher'), sealAt: (f, e) => ({ ...f, source: { sealed: e } }) });
    // The bound program: its output scrubbed, its exit code passed on, nothing of Node's in its env.
    const ok = await cl.use(made.ref, target, { argv: [], env: { TF_IN_AUTOMATION: '1' } }) as A;
    assert.equal(ok.outcome.exit, 3);
    assert.equal(ok.outcome.stdout.trim(), 'tofu sees [redacted by the broker] [] 1');
    // Loader, interpreter and config variables from core are refused.
    for (const env of [{ LD_PRELOAD: '/tmp/x.so' }, { NODE_OPTIONS: '--require /tmp/x.js' }, { BASH_ENV: '/tmp/x' }, { TF_CLI_CONFIG_FILE: '/tmp/x' }, { PATH: '/tmp' }]) {
      assert.equal((await cl.use(made.ref, target, { argv: [], env }) as A).refused, 'out_of_scope', JSON.stringify(env));
    }
    // A process target with another digest is a different target: not bound.
    assert.equal((await cl.use(made.ref, { ...target, sha256: '0'.repeat(64) }, { argv: [] }) as A).refused, 'not_bound');
    // The file swapped after binding: the launcher hashes it and refuses; the value goes nowhere.
    writeFileSync(program, '#!/bin/sh\necho "stolen $TF_VAR_X"\n', { mode: 0o755 });
    const swapped = await cl.use(made.ref, target, { argv: [] }) as A;
    assert.equal(swapped.outcome.exit, 126);
    assert.match(swapped.outcome.stderr, /isn’t the one this credential is bound to/);
    assert.ok(!JSON.stringify(swapped).includes('stolen') && !JSON.stringify(swapped).includes(C('launcher')));
  } finally { cl.close(); b.child.kill(); }
});
