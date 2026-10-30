// The vault (M5 plan §2): AES-256-GCM at rest, the key in the OS keychain or a 0600 file (said
// plainly), secret:// references, kept out of the home's git history, redacted from logs, problems
// and receipts, and replicated to a standby only sealed (its key never in the sync log). The real
// keychain is never touched: keychains are injected, and the real secret-tool is tried only when it
// exists, with a throwaway account that is removed afterwards. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  FILE_KEY_NOTICE, Vault, createCore, keyMode, macKeyStore, secretRef, secretToolKeyStore, windowsKeyStore, type KeyCommandRunner, type KeyStore,
} from '../../src/core/index.ts';
import { Db } from '../../src/core/db.ts';
import { Log } from '../../src/core/log.ts';
import { SyncLog } from '../../src/core/mesh/sync.ts';
import { ensureGit, commitHome } from '../../src/home.js';

const home = () => mkdtempSync(join(tmpdir(), 'nova-vault-'));
const SECRET = 'placeholder-token-0123456789abcdef';

// A keychain in memory, with a switch for whether it answers.
function fakeKeychain() {
  const items = new Map<string, Buffer>();
  const k = { up: true, items, writes: 0 };
  const make = (account: string): KeyStore => ({
    kind: 'keychain', name: 'the test keychain',
    available: () => (k.up ? { ok: true, detail: 'test' } : { ok: false, detail: 'switched off for the test' }),
    read: () => { if (!k.up) throw new Error('down'); return items.get(account) ?? null; },
    write: (key) => { k.writes++; items.set(account, Buffer.from(key)); },
    remove: () => { items.delete(account); },
  });
  return { k, make };
}

test('secrets round-trip, encrypted at rest with AES-256-GCM, 0600, by secret:// reference', () => {
  const h = home();
  const v = new Vault({ home: h, mode: 'file' });
  assert.equal(v.status().secrets, 0);
  assert.equal(existsSync(v.file), false, 'nothing is written before there is a secret');
  const ref = v.put('connector/example/API_TOKEN', SECRET);
  assert.equal(ref, 'secret://connector/example/API_TOKEN');
  assert.equal(ref, secretRef('connector/example/API_TOKEN'));
  assert.equal(v.get('connector/example/API_TOKEN'), SECRET);
  assert.equal(v.resolve(ref), SECRET);
  const disk = readFileSync(v.file, 'utf8');
  assert.doesNotMatch(disk, new RegExp(SECRET));
  const f = JSON.parse(disk);
  assert.equal(f.alg, 'aes-256-gcm');
  assert.equal(statSync(v.file).mode & 0o777, 0o600);
  assert.equal(statSync(join(h, 'vault', 'key')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(h, 'vault', 'key')).length, 32);
  // A fresh vault on the same home reads the same secret back.
  assert.equal(new Vault({ home: h, mode: 'file' }).get('connector/example/API_TOKEN'), SECRET);
  assert.throws(() => v.put('../escape', 'x'), /isn’t a secret name/);
  assert.throws(() => v.resolve('https://example.test'), /secret:\/\//);
  assert.throws(() => v.put('connector/example/EMPTY', ''), /can’t be empty/);
  // Revoking by prefix takes every secret of one extension, and nothing else.
  v.put('connector/example/OTHER', 'another-placeholder-value');
  v.put('connector/else/API_TOKEN', 'third-placeholder-value');
  assert.deepEqual(v.deletePrefix('connector/example/'), ['connector/example/API_TOKEN', 'connector/example/OTHER']);
  assert.deepEqual(v.list(), ['connector/else/API_TOKEN']);
  v.delete('connector/else/API_TOKEN');
  assert.equal(existsSync(v.file), false, 'an empty vault leaves no file');
});

test('a tampered vault, a wrong key or a missing key is refused in plain words, never guessed at', () => {
  const h = home();
  new Vault({ home: h, mode: 'file' }).put('connector/example/API_TOKEN', SECRET);
  const file = join(h, 'vault', 'secrets.json');
  const good = readFileSync(file, 'utf8');
  const f = JSON.parse(good);
  const data = Buffer.from(f.data, 'base64');
  data[0] = data[0]! ^ 1;
  writeFileSync(file, JSON.stringify({ ...f, data: data.toString('base64') }));
  assert.throws(() => new Vault({ home: h, mode: 'file' }).get('connector/example/API_TOKEN'), /doesn’t open with its key/);
  // The id is bound in as associated data: a vault can't be passed off as another.
  writeFileSync(file, JSON.stringify({ ...f, id: '00000000-0000-4000-8000-00000000abcd' }));
  assert.throws(() => new Vault({ home: h, mode: 'file' }).get('connector/example/API_TOKEN'), /doesn’t open with its key/);
  writeFileSync(file, good);
  writeFileSync(join(h, 'vault', 'key'), randomBytes(32));
  const v = new Vault({ home: h, mode: 'file' });
  assert.equal(v.status().ok, false);
  assert.match(v.status().problem!, /can’t find the key to its vault/);
});

test('a lost key doesn’t brick the vault: saving a secret again starts a new one, the old kept aside; a reset does the same on purpose', () => {
  const h = home();
  const v = new Vault({ home: h, mode: 'file' });
  v.put('connector/example/API_TOKEN', SECRET);
  const oldId = JSON.parse(readFileSync(join(h, 'vault', 'secrets.json'), 'utf8')).id;
  rmSync(join(h, 'vault', 'key'));
  const lost = new Vault({ home: h, mode: 'file' });
  assert.match(lost.status().problem!, /Saving a secret again .* starts a new vault/);
  // Reconnecting puts the token again: that works, in a new vault.
  lost.put('connector/example/API_TOKEN', 'placeholder-token-new-0000');
  assert.equal(lost.status().ok, true);
  assert.equal(new Vault({ home: h, mode: 'file' }).get('connector/example/API_TOKEN'), 'placeholder-token-new-0000');
  const aside = readdirSync(join(h, 'vault')).filter((f) => f.startsWith('secrets.json.unopenable-'));
  assert.equal(aside.length, 1, 'the old vault is kept aside, not deleted');
  assert.notEqual(JSON.parse(readFileSync(join(h, 'vault', 'secrets.json'), 'utf8')).id, oldId, 'a new vault, with a new id');
  // A key in a keychain that isn't answering may turn up again: saving waits rather than starting over.
  const { k, make } = fakeKeychain();
  const h2 = home();
  new Vault({ home: h2, mode: 'auto', keychain: make }).put('connector/example/API_TOKEN', SECRET);
  k.up = false;
  assert.throws(() => new Vault({ home: h2, mode: 'auto', keychain: make }).put('connector/example/API_TOKEN', SECRET), /isn’t answering/);
  // The reset is explicit (tier 3): it needs confirm, and does the same.
  const stuck = new Vault({ home: h2, mode: 'auto', keychain: make });
  assert.throws(() => stuck.reset(false), /confirm/);
  stuck.reset(true);
  k.up = true;
  assert.equal(stuck.status().ok, true);
  assert.equal(stuck.list().length, 0);
  assert.equal(readdirSync(join(h2, 'vault')).filter((f) => f.startsWith('secrets.json.unopenable-')).length, 1);
});

test('deleting a secret re-keys the vault, so an old copy of the file doesn’t open with the key in use; a re-key cut short recovers', () => {
  const h = home();
  const v = new Vault({ home: h, mode: 'file' });
  v.put('connector/example/A', 'placeholder-aaaaaaaa');
  v.put('connector/example/B', 'placeholder-bbbbbbbb');
  const before = readFileSync(join(h, 'vault', 'secrets.json'), 'utf8');
  v.delete('connector/example/B');
  const after = readFileSync(join(h, 'vault', 'secrets.json'), 'utf8');
  assert.notEqual(JSON.parse(before).fp, JSON.parse(after).fp, 'a new key');
  assert.equal(JSON.parse(before).id, JSON.parse(after).id, 'the same vault');
  assert.equal(new Vault({ home: h, mode: 'file' }).get('connector/example/A'), 'placeholder-aaaaaaaa');
  writeFileSync(join(h, 'vault', 'secrets.json'), before);
  assert.throws(() => new Vault({ home: h, mode: 'file' }).get('connector/example/B'), /can’t find the key/);
  // Cut short after the new key was saved but before the new file took its place: the new file is
  // still beside it, and opening finishes the job.
  writeFileSync(join(h, 'vault', 'secrets.json'), after);
  const w = new Vault({ home: h, mode: 'file' });
  w.put('connector/example/C', 'placeholder-cccccccc');
  const keep = readFileSync(join(h, 'vault', 'secrets.json'), 'utf8');
  w.delete('connector/example/C');
  renameSync(join(h, 'vault', 'secrets.json'), join(h, 'vault', 'secrets.json.tmp'));
  writeFileSync(join(h, 'vault', 'secrets.json'), keep);
  assert.equal(new Vault({ home: h, mode: 'file' }).get('connector/example/A'), 'placeholder-aaaaaaaa');
  assert.equal(new Vault({ home: h, mode: 'file' }).get('connector/example/C'), null);
});

test('a vault id is a UUID before it names a keychain item', () => {
  const h = home();
  new Vault({ home: h, mode: 'file' }).put('connector/example/API_TOKEN', SECRET);
  const file = join(h, 'vault', 'secrets.json');
  const f = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...f, id: 'x -w injected' }));
  const seen: string[] = [];
  const v = new Vault({ home: h, mode: 'auto', keychain: (account) => { seen.push(account); return null; } });
  assert.equal(v.status().ok, false);
  assert.match(v.status().problem!, /damaged/);
  assert.deepEqual(seen, [], 'the odd id never reached a keychain');
});

test('the key: in the keychain when one answers (no key file), else a 0600 file with a plain notice', () => {
  const { k, make } = fakeKeychain();
  const h = home();
  const v = new Vault({ home: h, mode: 'auto', keychain: make });
  v.put('connector/example/API_TOKEN', SECRET);
  assert.equal(existsSync(join(h, 'vault', 'key')), false, 'no key on disk');
  assert.equal(k.items.size, 1);
  assert.deepEqual([v.status().key, v.status().notice], ['keychain', null]);
  assert.equal(new Vault({ home: h, mode: 'auto', keychain: make }).get('connector/example/API_TOKEN'), SECRET);

  // No keychain: the file, and the person is told where the key is.
  const h2 = home();
  const v2 = new Vault({ home: h2, mode: 'auto', keychain: null });
  v2.put('connector/example/API_TOKEN', SECRET);
  assert.equal(v2.status().key, 'file');
  assert.equal(v2.status().notice, FILE_KEY_NOTICE);
  assert.match(FILE_KEY_NOTICE, /key is in a file next to them \(vault\/key/);

  // A keychain that turns up later: the key moves into it, read back first, then leaves the disk.
  const v3 = new Vault({ home: h2, mode: 'auto', keychain: make });
  assert.equal(v3.get('connector/example/API_TOKEN'), SECRET);
  assert.equal(v3.status().key, 'keychain');
  assert.equal(existsSync(join(h2, 'vault', 'key')), false);

  // The key is in the keychain and the keychain is down: said plainly, nothing guessed.
  k.up = false;
  const v4 = new Vault({ home: h2, mode: 'auto', keychain: make });
  assert.match(v4.status().problem!, /system keychain, which isn’t answering/);
  // NOVA_VAULT_KEY=keychain with none answering refuses to fall back to a file.
  assert.throws(() => new Vault({ home: home(), mode: 'keychain', keychain: make }).put('connector/example/API_TOKEN', SECRET), /none answers/);
  // Under the test runner, auto means file: tests never reach a real keychain.
  assert.equal(keyMode({ NODE_TEST_CONTEXT: 'child-v8' }), 'file');
  assert.equal(keyMode({}), 'auto');
  assert.equal(keyMode({ NOVA_VAULT_KEY: 'keychain', NODE_TEST_CONTEXT: 'x' }), 'keychain');
});

test('keychain CLIs get the key on stdin, never on the command line', () => {
  const calls: { cmd: string; args: string[]; input?: string }[] = [];
  const stored = new Map<string, string>();
  const run: KeyCommandRunner = (cmd, args, input) => {
    calls.push({ cmd, args, ...(input !== undefined ? { input } : {}) });
    const text = [...args, input ?? ''].join(' ');
    if (/store|add-generic|\.Add\(/.test(text)) { stored.set(cmd, String(input).match(/-w (\S+)/)?.[1] ?? String(input).trim()); return { code: 0, stdout: '', stderr: '', error: null }; }
    if (/lookup|find-generic|Retrieve/.test(text)) return stored.has(cmd) ? { code: 0, stdout: stored.get(cmd)!, stderr: '', error: null } : { code: cmd === 'secret-tool' ? 1 : 44, stdout: '', stderr: '', error: null };
    return { code: 0, stdout: '', stderr: '', error: null };
  };
  const key = randomBytes(32);
  for (const store of [secretToolKeyStore('vault-test', { run, env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nowhere' } }), macKeyStore('vault-test', { run }), windowsKeyStore('vault-test', { run })]) {
    assert.equal(store.available().ok, true, store.name);
    assert.equal(store.read(), null, `${store.name}: nothing there yet`);
    store.write(key);
    assert.deepEqual(store.read(), key, `${store.name}: reads back`);
  }
  const b64 = key.toString('base64');
  for (const c of calls) assert.ok(!c.args.join(' ').includes(b64), `${c.cmd} never has the key in its arguments`);
  assert.ok(calls.some((c) => c.input?.includes(b64)), 'the key went in on stdin');
  // Without a desktop session there is no Secret Service to reach.
  assert.equal(secretToolKeyStore('vault-test', { run, env: {} }).available().ok, false);
});

test('the real secret-tool, if this machine has one: a throwaway account, removed afterwards', (t) => {
  const has = spawnSync('secret-tool', ['--version']).error === undefined && !!process.env.DBUS_SESSION_BUS_ADDRESS;
  if (!has) { t.skip('no secret-tool or no desktop session here'); return; }
  const store = secretToolKeyStore(`vault-nova-test-${randomBytes(6).toString('hex')}`);
  if (!store.available().ok) { t.skip('secret-tool does not answer here'); return; }
  const key = randomBytes(32);
  try {
    store.write(key);
    assert.deepEqual(store.read(), key);
  } finally {
    store.remove();
  }
  assert.equal(store.read(), null);
});

test('never in git history: the home ignores vault/, and the secret is in no commit', async (t) => {
  if (spawnSync('git', ['--version']).error) { t.skip('git is not installed'); return; }
  const h = home();
  writeFileSync(join(h, 'USER.md'), '# You\n');
  await ensureGit(h);
  const v = new Vault({ home: h, mode: 'file' });
  v.put('connector/example/API_TOKEN', SECRET);
  writeFileSync(join(h, 'notes.md'), 'a note\n');
  commitHome(h, 'a turn');
  await new Promise((r) => setTimeout(r, 50));
  // commitHome queues; ensureGit on the same queue waits for it.
  await ensureGit(h);
  const g = (...args: string[]) => execFileSync('git', ['-C', h, ...args], { encoding: 'utf8' });
  assert.match(g('log', '--oneline'), /a turn/);
  assert.equal(g('ls-files', 'vault').trim(), '', 'vault/ is not tracked');
  const history = g('log', '--all', '-p');
  assert.doesNotMatch(history, new RegExp(SECRET));
  assert.doesNotMatch(history, /secrets\.json|vault\/key/);
  assert.doesNotMatch(history, new RegExp(readFileSync(join(h, 'vault', 'key')).toString('base64').replace(/[+/]/g, '.')));
  assert.match(readFileSync(join(h, '.gitignore'), 'utf8'), /^vault\/$/m);
});

test('redacted from the log, problems and receipts, wherever the value turns up', async () => {
  const h = home();
  const core = createCore({ home: h, version: '0.1.0', trustedOrigin: () => true, vault: { mode: 'file' } });
  try {
    core.vault.put('connector/example/API_TOKEN', SECRET);
    core.log.info('test', `calling with ${SECRET}`, { url: `https://service.example/?key=${SECRET}`, nested: { note: SECRET } });
    const p = core.log.problem('test', `The service refused ${SECRET}.`, { detail: `Bearer ${SECRET}` });
    assert.doesNotMatch(JSON.stringify(p), new RegExp(SECRET));
    assert.match(p.message, /\[redacted\]/);
    const r = core.receipts.record({ provider: 'example', model: 'example-model', purpose: `testing ${SECRET}`, privacy_mode: 'cloud-allowed', egress: 'local', context_items: [{ kind: 'file', ref: `notes/${SECRET}.md`, sha256: 'a'.repeat(64) }] });
    assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
    assert.doesNotMatch(readFileSync(join(h, 'logs', 'nova.log'), 'utf8'), new RegExp(SECRET));
    // The API shows names, never values.
    assert.doesNotMatch(JSON.stringify(core.vault.status()), new RegExp(SECRET));
  } finally {
    await core.close();
  }
});

test('replication: the standby gets the vault sealed in the batch; no sync log holds the key or a value', () => {
  const mk = (h: string) => {
    const db = new Db(join(h, 'nova.db'));
    db.migrate();
    const log = new Log(db, null);
    const vault = new Vault({ home: h, mode: 'file' });
    const sync = new SyncLog({ db, log, home: h, node: 'node', now: () => new Date() });
    sync.vault = vault;
    return { db, vault, sync };
  };
  const hub = mk(home());
  const standby = mk(home());
  standby.sync.setLogging(false);
  hub.vault.put('connector/example/API_TOKEN', SECRET);
  hub.sync.scan();
  const key = readFileSync(join(hub.sync.home, 'vault', 'key')).toString('base64');
  const logged = hub.db.all<{ tbl: string; row: string }>(`SELECT tbl, row FROM sync_log WHERE tbl = 'vault'`);
  assert.equal(logged.length, 1);
  assert.doesNotMatch(logged[0]!.row, new RegExp(SECRET));
  assert.ok(!logged[0]!.row.includes(key), 'the hub’s log never holds the key');
  // Served: the key rides inside the batch (which the hub seals to the standby's key).
  const batch = hub.sync.batch(0);
  assert.ok(batch.rows.find((r) => r.tbl === 'vault')!.row!.includes(key));
  standby.sync.apply(batch, () => {});
  assert.equal(standby.vault.get('connector/example/API_TOKEN'), SECRET);
  const stored = standby.db.all<{ row: string }>(`SELECT row FROM sync_log WHERE tbl = 'vault'`)[0]!.row;
  assert.ok(!stored.includes(key), 'nor does the standby’s');
  assert.equal(statSync(standby.vault.file).mode & 0o777, 0o600);
  // A revoked secret is gone from the standby with the next batch; the last one leaves no vault.
  hub.vault.delete('connector/example/API_TOKEN');
  hub.sync.scan();
  standby.sync.apply(hub.sync.batch(batch.upto), () => {});
  assert.equal(standby.vault.get('connector/example/API_TOKEN'), null);
  assert.equal(existsSync(standby.vault.file), false);
  for (const db of [hub.db, standby.db]) db.close();
  for (const h of [hub.sync.home, standby.sync.home]) assert.doesNotMatch(readFileSync(join(h, 'nova.db')).toString('latin1'), new RegExp(SECRET));
});
