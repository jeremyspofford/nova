// The broker's boundary in the source (docs/plans/vault-broker.md §3 "Dependencies", gate items 5
// and 6): its own tree, importing nothing from core and no package; core reaching it only through
// the client, by types; a size budget one reviewer can read; nothing that listens on a port; the
// fixed verb list; and a client with no method that could hand core a value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { ERRORS, FIELDS, MESSAGES, REFUSALS, VERBS } from '../../src/broker/protocol.ts';
import { BrokerClient } from '../../src/core/broker/client.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const BROKER = join(ROOT, 'src', 'broker');
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : /\.(ts|js)$/.test(e.name) ? [join(d, e.name)] : []));
const imports = (f: string) => [...readFileSync(f, 'utf8').matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gm)].map((m) => ({ type: !!m[1], from: m[2]! }));

test('src/broker is its own tree: Node’s standard library and its own files, nothing from core, no package', () => {
  for (const f of walk(BROKER)) {
    for (const i of imports(f)) assert.ok(i.from.startsWith('node:') || /^\.\/[a-z-]+\.ts$/.test(i.from), `${relative(ROOT, f)} imports ${i.from}`);
    assert.ok(!/\brequire\(|import\(/.test(readFileSync(f, 'utf8')), `${relative(ROOT, f)}: no dynamic loading`);
  }
});

test('core reaches the broker only through its client, and the client imports the broker’s types only', () => {
  const outside = [...walk(join(ROOT, 'src'))].filter((f) => !f.startsWith(BROKER));
  const lands = (f: string, from: string) => from.startsWith('.') && resolve(dirname(f), from).startsWith(`${BROKER}/`);
  const users = outside.filter((f) => imports(f).some((i) => lands(f, i.from)));
  assert.deepEqual(users.map((f) => relative(ROOT, f)), ['src/core/broker/client.ts']);
  const client = join(ROOT, 'src', 'core', 'broker', 'client.ts');
  const typed = imports(client).filter((x) => lands(client, x.from));
  assert.ok(typed.length >= 1);
  for (const i of typed) assert.equal(i.type, true, `the client imports ${i.from} for types only`);
});

test('the size budget: no more than 3,000 lines of broker code, tests aside, so one reviewer can read all of it', () => {
  const lines = walk(BROKER).reduce((n, f) => n + readFileSync(f, 'utf8').split('\n').length, 0);
  assert.ok(lines <= 3000, `${lines} lines`);
});

test('no network surface in the source: no HTTP server, nothing listens on a port, no inspector', () => {
  for (const f of walk(BROKER)) {
    const src = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/\b(http|https|http2)\.createServer|from 'node:(http2|inspector|dgram|worker_threads|vm)'|createSecureServer|\.listen\(\s*\d|\.listen\(\s*\{\s*port|node:inspector/.test(src), `${relative(ROOT, f)}`);
    assert.ok(!/\beval\(|new Function\(/.test(src), `${relative(ROOT, f)}: no eval`);
    const listens = [...src.matchAll(/\.listen\(/g)].length;
    assert.equal(listens, f.endsWith('server.ts') ? 1 : 0, `${relative(ROOT, f)} listens`);
  }
  assert.match(readFileSync(join(BROKER, 'server.ts'), 'utf8'), /server\.listen\(\{ path, exclusive: true \}/, 'the one listen is on a socket path');
  // Outbound connections are made in one file, http.ts, from inside a `use`.
  for (const f of walk(BROKER).filter((x) => !x.endsWith('http.ts') && !x.endsWith('launch.ts'))) assert.ok(!/from 'node:(tls|https|http|dns)/.test(readFileSync(f, 'utf8')), `${relative(ROOT, f)} reaches the network`);
});

test('the fixed protocol: seven verbs, three messages, a fixed refusal list', () => {
  assert.deepEqual([...VERBS], ['list_refs', 'use', 'create', 'update', 'rotate', 'bind', 'share_scope']);
  assert.deepEqual([...MESSAGES], ['hello', 'unlock', 'lock']);
  assert.deepEqual(Object.keys(FIELDS).sort(), [...VERBS, ...MESSAGES].sort(), 'nothing else: the launcher is the broker’s child, reached by pipe');
  assert.deepEqual(Object.keys(REFUSALS), ['not_bound', 'out_of_scope', 'needs_approval', 'approval_invalid', 'locked', 'class_policy', 'rate', 'unknown_ref', 'wrong_target_kind']);
  for (const w of [...Object.values(REFUSALS), ...Object.values(ERRORS)]) assert.ok(w.length > 10 && !/undefined|\$\{/.test(w));
  // The honest-claims rule in the broker's own words: nothing claims more than the ADR's sentence.
  for (const f of walk(BROKER)) assert.ok(!/can never read|never leave the vault|structurally impossible|impossible for Nova/i.test(readFileSync(f, 'utf8')), relative(ROOT, f));
});

test('the client has no method that returns a value: no get, resolve, reveal or export', () => {
  const methods = Object.getOwnPropertyNames(BrokerClient.prototype);
  for (const m of methods) assert.ok(!/^(get|resolve|reveal|value|export|read|decrypt|secret|show)/i.test(m), `BrokerClient.${m}`);
  assert.deepEqual(methods.filter((m) => m !== 'constructor').sort(), ['bind', 'call', 'close', 'create', 'listRefs', 'lock', 'migrateCommit', 'migratePropose', 'migrateStage', 'rotate', 'shareScope', 'state', 'unlock', 'update', 'use'].sort());
});
