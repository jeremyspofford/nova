// Canary credentials (Amendment 2026-10-31-B Part 6, pointed at the vault; docs/plans/vault-broker.md
// §10 gate items 1, 2 and 8, as far as Phase 1's first PR reaches). The broker runs as its own
// process under Node's permission model; core is a separate process holding only the broker client.
// Canaries are planted the ways they arrive (sealed entry, generated, rotated, migrated from a
// vault.ts vault), every built consumer kind is exercised against stand-ins, and then each value is
// searched for, raw and in base64, base64url, hex, URL-encoded and JSON-escaped forms, in: core's
// heap, every answer core got (audit records included), the broker's own output and audit log,
// every file in the broker's folder, the backup set, the diagnostics bundle (#259's test, pointed at
// the vault) and the launcher's output. Zero hits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyChain } from '../../src/broker/audit.ts';
import { fileSha256 } from '../../src/broker/origin.ts';
import { startBroker } from '../../src/broker/spawn.ts';
import { Vault, buildDiagnostics, createCore } from '../../src/core/index.ts';
import { backupFiles } from '../../src/core/resilience/backup.ts';
import { C, PASS, RECOVERY, Person, anyForm, boundCredential, coreSim, standIn, tmp } from '../support/broker-support.ts';

const files = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));

test('canaries planted in the broker appear in no answer, log, ledger record, file, backup, bundle or core heap', { timeout: 120_000 }, async () => {
  const home = tmp('nova-canary-');
  // 0. Today's vault.ts vault, full of canaries, beside Nova's own keys and an Era 2 Gmail file.
  const own = { 'nova/backup-key': 'own-backup-key-value-1234567890', 'capture/hash-key': 'own-capture-hash-key-1234567890' };
  const first = createCore({ home, version: '0.1.0', trustedOrigin: () => true, vault: { mode: 'file' } });
  const oldVault = first.vault;
  oldVault.put('provider/OLD_PROVIDER', C('migrated-provider'));
  oldVault.put('connector/home-assistant/HA_TOKEN', C('migrated-connector'));
  oldVault.put('browser/login/shop.example/username', 'person@example.test');
  oldVault.put('browser/login/shop.example/password', C('migrated-login'));
  for (const [k, v] of Object.entries(own)) oldVault.put(k, v);
  await first.close();
  mkdirSync(join(home, 'connectors', 'gmail'), { recursive: true });
  writeFileSync(join(home, 'connectors', 'gmail', 'token.json'), JSON.stringify({ refresh_token: C('migrated-oauth') }));
  const oldKey = readFileSync(join(home, 'vault', 'key'));
  const oldFile = readFileSync(join(home, 'vault', 'secrets.json'), 'utf8');

  // 1. The broker, and core in a process of its own.
  const b = await startBroker(join(home, 'broker'), { keyMode: 'file', pipe: true });
  let brokerOut = '';
  b.child.stdout!.setEncoding('utf8').on('data', (x: string) => { brokerOut += x; });
  b.child.stderr!.setEncoding('utf8').on('data', (x: string) => { brokerOut += x; });
  const core = coreSim(b.socket, b.tokens.core);
  const p = new Person(core.call);
  const targets = await standIn();
  const learned: string[] = [];
  try {
    await p.setup({ recovery: true });

    // 2. Migration with no value through core: stage, commit, finish, propose.
    const staged = await core.stage(home);
    assert.equal(staged.staged, 5, 'the old vault’s credentials (a login’s two parts) and the Era 2 file; Nova’s own keys aren’t sent');
    const committed = await core.call('create', { meta: {}, source: { migrate: 'commit' } });
    assert.equal(committed.outcome.read_back, true);
    assert.deepEqual(committed.outcome.migrated.sort(), ['browser/login/shop.example/password', 'connector/gmail/GOOGLE_REFRESH_TOKEN', 'connector/home-assistant/HA_TOKEN', 'provider/OLD_PROVIDER']);
    const fin = await core.finish(home, committed.outcome.ticket);
    assert.equal(fin.removed, 4, 'from vault.ts: the provider key, the token and both parts of the login (its username is now metadata)');
    assert.equal(fin.kept, 2);
    assert.equal(existsSync(join(home, 'connectors', 'gmail', 'token.json')), false, 'Era 2’s file is gone');
    assert.notDeepEqual(readFileSync(join(home, 'vault', 'key')), oldKey, 'the old vault has a new key');
    const after = new Vault({ home, mode: 'file' });
    assert.deepEqual(after.list(), Object.keys(own).sort(), 'only Nova’s own keys stay in vault.ts');
    writeFileSync(join(home, 'vault', 'secrets.json.old-copy'), oldFile);
    const proposed = await p.approve('create', { meta: {}, source: { migrate: 'propose', proposals: { 'provider/OLD_PROVIDER': { class: 'standard', bind: [{ target: { kind: 'http', origin: targets.origin }, scope: { methods: ['GET'], paths: ['/v1'] }, inject: { how: 'bearer' }, consent: { scope: { methods: ['GET'], paths: ['/v1'] } } }] } } } });
    assert.equal(proposed.ok, true);
    assert.equal((await core.call('use', { ref: 'secret://provider/OLD_PROVIDER', target: { kind: 'http', origin: targets.origin }, request: { method: 'GET', path: '/v1/models' } })).ok, true);
    assert.equal(targets.requests.at(-1)!.headers.authorization, `Bearer ${C('migrated-provider')}`);
    const login = (await core.call('list_refs', { filter: { kind: 'login' } })).refs[0];
    assert.equal(login.username, 'person@example.test');
    assert.equal(login.origin, 'https://shop.example');

    // 3. Sealed entry, one per built consumer kind, each used against its stand-in.
    const kinds: [string, string, string][] = [['provider/OPENAI_KEY', 'api_key', 'provider-key'], ['connector/home-assistant/REST', 'token', 'connector-token'], ['connector/gmail/ACCESS', 'oauth', 'oauth-token'], ['network/router/token', 'token', 'network-token'], ['capture/screenpipe/API_KEY', 'api_key', 'screenpipe-key']];
    for (const [name, kind, c] of kinds) {
      await boundCredential(p, targets.origin, { name, kind, value: C(c), class: 'standard' });
      const u = await core.call('use', { ref: `secret://${name}`, target: { kind: 'http', origin: targets.origin }, request: { method: 'POST', path: '/api/echo', body: 'echo the header back' } });
      assert.equal(u.ok, true, name);
      assert.equal(targets.requests.at(-1)!.headers.authorization, `Bearer ${C(c)}`, 'the target has it');
      assert.match(u.outcome.body, /^saw Bearer \[redacted by the broker\] echo/, 'its echo came back scrubbed');
    }
    // A generated password and a rotated one: the test learns them from the target's side.
    const gen = await boundCredential(p, targets.origin, { name: 'browser/login/new.example/password', kind: 'api_key', class: 'standard' });
    await core.call('use', { ref: gen.ref, target: { kind: 'http', origin: targets.origin }, request: { method: 'GET', path: '/api' } });
    learned.push(String(targets.requests.at(-1)!.headers.authorization).slice(7));
    await p.approve('rotate', { ref: gen.ref, phase: 'begin' });
    await core.call('use', { ref: gen.ref, target: { kind: 'http', origin: targets.origin }, request: { method: 'GET', path: '/api' }, version: 'pending' });
    learned.push(String(targets.requests.at(-1)!.headers.authorization).slice(7));
    await p.approve('rotate', { ref: gen.ref, phase: 'commit' });
    assert.notEqual(learned[0], learned[1]);
    // An infra secret through the launcher (env), and a kubeconfig (a 0600 file, removed on exit).
    const program = process.execPath;
    const sha256 = fileSha256(program);
    for (const [name, how, env, c] of [['infra/p1/TF_VAR_TOKEN', 'env', 'TF_VAR_TOKEN', 'infra-secret'], ['clusters/c1/kubeconfig', 'file', 'KUBECONFIG', 'kubeconfig']] as const) {
      const made = await p.approve('create', { meta: { name, kind: 'secret', class: 'standard' }, source: 'sealed', bind: [{ target: { kind: 'process', path: program, sha256 }, inject: { how, env }, consent: {} }] }, { seal: C(c), sealAt: (f, e) => ({ ...f, source: { sealed: e } }) });
      assert.equal(made.ok, true, JSON.stringify(made));
      const script = how === 'env' ? 'console.log("tofu sees", process.env.TF_VAR_TOKEN); console.error("err", process.env.TF_VAR_TOKEN)' : 'const f = process.env.KUBECONFIG; console.log(f, require("fs").readFileSync(f, "utf8"), (require("fs").statSync(f).mode & 0o777).toString(8))';
      const u = await core.call('use', { ref: made.ref, target: { kind: 'process', path: program, sha256 }, request: { argv: ['-e', script] } });
      const ran = await core.run(u.outcome.ticket, program);
      assert.equal(ran.code, 0, ran.stderr);
      assert.ok(ran.stdout.includes('[redacted by the broker]'), ran.stdout);
      if (how === 'file') {
        const parts = ran.stdout.trim().split(' ');
        const path = parts[0]!;
        const mode = parts.at(-1);
        assert.equal(mode, '600');
        assert.equal(existsSync(path), false, 'the file is removed on exit');
      }
      assert.equal((await core.run(u.outcome.ticket, program)).code, 126, 'a ticket redeemed twice is refused');
    }
    assert.match(String((await core.call('list_refs')).state.problem), /redeemed twice/, 'and raised as an alarm');
    await core.call('list_refs');

    // 4. Search.
    const canaries = [C('migrated-provider'), C('migrated-connector'), C('migrated-login'), C('migrated-oauth'), ...kinds.map(([, , c]) => C(c)), C('infra-secret'), C('kubeconfig'), ...learned];
    const heapPath = join(tmp('nova-heap-'), 'core.heapsnapshot');
    await core.heap(heapPath);
    const places: Record<string, string> = {
      'core’s heap': readFileSync(heapPath, 'latin1'),
      'answers to core (and their audit records)': JSON.stringify(core.answers),
      'the broker’s own output': brokerOut,
      'the broker’s audit log': readFileSync(join(home, 'broker', 'audit.log'), 'utf8'),
      'every file in the broker’s folder': files(join(home, 'broker')).map((f) => readFileSync(f, 'latin1')).join('\n'),
      'vault.ts after the migration': readFileSync(join(home, 'vault', 'secrets.json'), 'utf8'),
    };
    assert.ok(places['core’s heap']!.length > 1_000_000, 'a real heap snapshot');
    assert.ok(anyForm(places['core’s heap']!, b.tokens.core), 'a control: what core does hold (its token) is found by the same search');
    assert.ok(anyForm(places['core’s heap']!, 'person@example.test'), 'and so is metadata it was given (a username)');
    assert.equal(verifyChain(places['the broker’s audit log']!).ok, true);
    // The backup set: item blobs only, never the header, a wrap, the device key or the audit log.
    const backed = backupFiles(home);
    const inBroker = backed.filter((f) => f.startsWith('broker/'));
    assert.ok(inBroker.length >= 10 && inBroker.every((f) => f.startsWith('broker/items/')), inBroker.join(', '));
    places['the backup set'] = backed.map((f) => readFileSync(join(home, f), 'latin1')).join('\n');
    const deviceKey = readFileSync(join(home, 'broker', 'device.key')).toString('base64');
    const signKey = existsSync(join(home, 'broker', 'sign.key')) ? readFileSync(join(home, 'broker', 'sign.key')).toString('base64') : deviceKey;
    for (const k of [deviceKey, signKey, PASS, RECOVERY]) assert.equal(anyForm(places['the backup set']!, k), null, 'a key or factor is in the backup set');
    // The diagnostics bundle (#259), built by a core on this very home.
    const nova = createCore({ home, version: '0.1.0', trustedOrigin: () => true, vault: { mode: 'file' } });
    try { places['the diagnostics bundle'] = JSON.stringify(await buildDiagnostics(nova, { home, version: '0.1.0' })); } finally { await nova.close(); }
    const found: string[] = [];
    for (const [where, text] of Object.entries(places)) for (const v of canaries) { const f = anyForm(text, v); if (f) found.push(`${v} (as ${f.slice(0, 16)}…) in ${where}`); }
    assert.deepEqual(found, []);
    // And the records core copies into the Work Ledger carry ref, target and outcome.
    const recs = core.answers.map((a) => a.record).filter(Boolean);
    assert.ok(recs.length > 30);
    assert.ok(recs.filter((r) => r.verb === 'use').every((r) => r.ref && r.target && r.outcome));
    // The old vault file's earlier copy doesn't open with the key that exists now.
    assert.notEqual(JSON.parse(oldFile).fp, JSON.parse(readFileSync(join(home, 'vault', 'secrets.json'), 'utf8')).fp);
  } finally {
    core.stop();
    b.child.kill();
    await targets.close();
  }
});

test('migration resumes: a run cut short after the move finishes on the next run, idempotent by name', { timeout: 60_000 }, async () => {
  const home = tmp('nova-migrate-');
  const v = new Vault({ home, mode: 'file' });
  v.put('provider/A', C('resume-a'));
  v.put('provider/B', C('resume-b'));
  v.put('nova/backup-key', 'own-backup-key-value-1234567890');
  const b = await startBroker(join(home, 'broker'), { keyMode: 'file' });
  const core = coreSim(b.socket, b.tokens.core);
  try {
    await new Person(core.call).setup();
    assert.equal((await core.stage(home)).staged, 2);
    const first = await core.call('create', { meta: {}, source: { migrate: 'commit' } });
    assert.deepEqual(first.outcome.migrated.sort(), ['provider/A', 'provider/B']);
    // Stopped here: the old file still holds both, nothing was removed. A new run picks up.
    assert.deepEqual(new Vault({ home, mode: 'file' }).list(), ['nova/backup-key', 'provider/A', 'provider/B']);
    assert.equal((await core.stage(home)).staged, 2);
    const second = await core.call('create', { meta: {}, source: { migrate: 'commit' } });
    assert.deepEqual(second.outcome.migrated, [], 'nothing is made twice');
    assert.equal(second.outcome.read_back, true);
    assert.equal((await core.finish(home, second.outcome.ticket)).removed, 2);
    assert.deepEqual(new Vault({ home, mode: 'file' }).list(), ['nova/backup-key']);
    assert.equal((await core.call('list_refs')).refs.length, 2);
    // A commit with nothing staged is refused in plain words; a finish ticket works once.
    assert.equal((await core.call('create', { meta: {}, source: { migrate: 'commit' } })).error, 'failed');
    assert.equal((await core.finish(home, second.outcome.ticket)).error, 'failed');
  } finally {
    core.stop();
    b.child.kill();
  }
});
