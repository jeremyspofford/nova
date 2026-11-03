// Owner B migration regressions: synthetic private homes; real Broker.handle and launcher pipe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Vault } from '../../src/core/vault.ts';
import { canonical } from '../../src/broker/protocol.ts';
import { C, Person, anyForm, inProcess, tmp, type A } from '../support/broker-support.ts';

const stage = { source: { migrate: 'stage' } };
const commit = { source: { migrate: 'commit' } };
const name = 'provider/A';
const value = C('epoch-original');
async function fresh(passkey = false) {
  const home = tmp('nova-owner-b-migration-');
  const b = inProcess(join(home, 'broker'));
  const p = new Person(b.call);
  await p.setup({ passkey });
  return { ...b, p, home, old: new Vault({ home, mode: 'file' }) };
}
function snapshot(home: string) {
  const file = join(home, 'vault/secrets.json');
  const key = join(home, 'vault/key');
  const bytes = readFileSync(file), keyBytes = readFileSync(key);
  return () => { writeFileSync(file, bytes); writeFileSync(key, keyBytes); };
}
function privateAnswers(b: Awaited<ReturnType<typeof fresh>>, secrets: string[]) {
  const publicText = JSON.stringify(b.answers) + readFileSync(join(b.dir, 'audit.log'), 'utf8');
  for (const secret of secrets) assert.equal(anyForm(publicText, secret), null, 'no value or private epoch in answers/audit');
}

for (const passkey of [false, true]) {
  test(`B2 held-name oracle: new equal/different writes are both kept (${passkey ? 'passkey' : 'core'})`, async () => {
    const observed: A[] = [];
    for (const guess of [value, C('epoch-different')]) {
      const b = await fresh(passkey);
      try {
        b.old.put(name, value);
        b.old.put('nova/backup-key', C('epoch-own'));
        await b.call('create', stage);
        assert.equal((await b.p.approve('create', commit)).ok, true);
        // Keep the original broker item intact: only core's legacy writer supplies the guess.
        b.old.put(name, guess);
        const nonce = JSON.parse(readFileSync(join(b.home, 'vault/secrets.json'), 'utf8')).nonce;
        assert.equal((await b.call('create', stage)).outcome.staged, 1);
        const ch = (await b.call('create', commit)).challenge;
        const status = ch.card.items.map((x: A) => x.status);
        const result = await b.call('create', { ...commit, approval: b.p.approval(ch) });
        assert.equal(result.ok, true);
        observed.push({ status, outcome: result.outcome, retained: new Vault({ home: b.home, mode: 'file' }).get(name) === guess });
        privateAnswers(b, [value, guess, nonce]);
      } finally { b.broker.lock(); }
    }
    assert.deepEqual(observed[0], observed[1], 'public held-name decisions and cleanup must not test the guess');
    assert.deepEqual(observed[0]!.status, ['kept']);
    assert.equal(observed[0]!.outcome.removed, 0);
    assert.equal(observed[0]!.retained, true);
  });

  test(`B2 GLOBAL finish oracle: a free-name stage retains both newer guesses (${passkey ? 'passkey' : 'core'})`, async () => {
    const observed: A[] = [];
    for (const guess of [value, C('epoch-different')]) {
      const b = await fresh(passkey);
      try {
        b.old.put(name, value);
        await b.call('create', stage);
        const ch = (await b.call('create', commit)).challenge;
        assert.equal(ch.card.items[0].status, 'move', 'free name independently reaches the finish guard');
        b.old.put(name, guess);
        const result = await b.call('create', { ...commit, approval: b.p.approval(ch) });
        assert.equal(result.ok, true);
        observed.push({ outcome: result.outcome, retained: new Vault({ home: b.home, mode: 'file' }).get(name) === guess });
        const id = [...b.broker.store.metas().items.keys()][0]!;
        const copied = b.broker.store.value(id)!;
        try { assert.equal(copied.toString(), value, 'the approved staged value was copied and privately read back'); }
        finally { copied.fill(0); }
        privateAnswers(b, [value, guess]);
      } finally { b.broker.lock(); }
    }
    assert.deepEqual(observed[0], observed[1], 'global cleanup must not test the guess, independently of resume status');
    assert.equal(observed[0]!.outcome.moved, 1);
    assert.equal(observed[0]!.outcome.removed, 0);
    assert.equal(observed[0]!.retained, true);
  });

  test(`B2 approval binds a restaged write epoch with identical names/kinds (${passkey ? 'passkey' : 'core'})`, async () => {
    const b = await fresh(passkey);
    try {
      b.old.put(name, value);
      await b.call('create', stage);
      const before = (await b.call('create', commit)).challenge;
      b.old.put(name, value);
      await b.call('create', stage);
      const denied = await b.call('create', { ...commit, approval: b.p.approval(before) });
      assert.equal(denied.refused, 'approval_invalid', 'a prior approval cannot cover a newer source write');
      assert.equal((await b.call('list_refs')).refs.length, 0);
      const after = (await b.call('create', commit)).challenge;
      assert.notEqual(after.digest, before.digest);
      assert.notDeepEqual(after.card.flags, before.card.flags, 'source snapshot metadata is visible on the card');
      assert.match(JSON.stringify(after.card.flags), /v2:[0-9a-f]{64}/);
      assert.equal((await b.call('create', { ...commit, approval: b.p.approval(after) })).ok, true);
      privateAnswers(b, [value]);
    } finally { b.broker.lock(); }
  });
}

for (const revision of ['legacy-content', 'v1:unknown', 'v99:unknown', undefined]) {
  test(`B2 ${revision ?? 'missing'} migrated revision is never a resumable proof`, async () => {
    const b = await fresh();
    try {
      b.old.put(name, value);
      const restore = snapshot(b.home);
      await b.call('create', stage);
      await b.p.approve('create', commit);
      const [id, meta] = [...b.broker.store.metas().items][0]!;
      const oldDigest = createHash('sha256').update(canonical([[name, Buffer.from(value).toString('base64')]])).digest('hex');
      b.broker.store.setMeta(id, { ...meta, migrated_revision: revision === 'legacy-content' ? oldDigest : revision });
      b.broker.start(); // Reindex the owned on-disk historical metadata fixture.
      restore();
      await b.call('create', stage);
      const ch = (await b.call('create', commit)).challenge;
      assert.equal(ch.card.items[0].status, 'kept');
      const result = await b.call('create', { ...commit, approval: b.p.approval(ch) });
      assert.equal(result.outcome.removed, 0);
      assert.equal(new Vault({ home: b.home, mode: 'file' }).get(name), value);
    } finally { b.broker.lock(); }
  });
}

test('B2 finish failure acknowledges already-created copies without source names or values', async () => {
  const b = await fresh();
  const lock = join(b.home, 'vault/.writer-lock');
  try {
    b.old.put(name, value);
    await b.call('create', stage);
    const ch = (await b.call('create', commit)).challenge;
    mkdirSync(lock); // Real owned writer contention after stage: copies succeed, finish cannot start.
    const result = await b.call('create', { ...commit, approval: b.p.approval(ch) });
    assert.equal(result.error, 'failed');
    assert.equal((await b.call('list_refs')).refs.length, 1, 'copy already exists');
    assert.match(result.message, /copies.*removals.*may.*review.*resume/i);
    assert.doesNotMatch(result.message, /nothing was moved|provider\/A|canary-/);
    assert.equal(new Vault({ home: b.home, mode: 'file' }).get(name), value);
  } finally { rmSync(lock, { recursive: true, force: true }); b.broker.lock(); }
});

function gmail(home: string, text = JSON.stringify({ refresh_token: value })) {
  const dir = join(home, 'connectors/gmail');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'token.json');
  writeFileSync(file, text, { mode: 0o600 });
  return { dir, file, text };
}

for (const change of ['same-value', 'different-value', 'same-mtime', 'replace-file']) {
  test(`B2 Gmail ${change} after stage is retained using non-content metadata`, async () => {
    const b = await fresh();
    try {
      const g = gmail(b.home);
      await b.call('create', stage);
      const ch = (await b.call('create', commit)).challenge;
      const before = statSync(g.file);
      if (change === 'replace-file') renameSync(g.file, `${g.file}.old`);
      const text = change === 'different-value' ? JSON.stringify({ refresh_token: C('gmail-new') }) : g.text;
      writeFileSync(g.file, text);
      if (change === 'same-mtime') utimesSync(g.file, before.atime, before.mtime);
      const result = await b.call('create', { ...commit, approval: b.p.approval(ch) });
      assert.equal(result.ok, true);
      assert.equal(existsSync(g.file), true, 'a newer Gmail write must survive cleanup even when values match');
      assert.equal(readFileSync(g.file, 'utf8'), text);
      privateAnswers(b, [value, C('gmail-new')]);
    } finally { b.broker.lock(); }
  });
}

test('B2 quiet regular Gmail source still migrates and is removed', async () => {
  const b = await fresh();
  try {
    const g = gmail(b.home);
    await b.call('create', stage);
    const result = await b.p.approve('create', commit);
    assert.equal(result.ok, true);
    assert.deepEqual(result.outcome.migrated, ['connector/gmail/GOOGLE_REFRESH_TOKEN']);
    assert.equal(result.outcome.read_back, true);
    assert.equal(existsSync(g.file), false);
  } finally { b.broker.lock(); }
});

test('B2 uncertain Gmail identity cannot resume or remove an existing name', async () => {
  const b = await fresh();
  try {
    const g = gmail(b.home);
    await b.call('create', stage);
    await b.p.approve('create', commit);
    writeFileSync(`${g.file}.target`, g.text);
    symlinkSync(`${g.file}.target`, g.file);
    await b.call('create', stage);
    const ch = (await b.call('create', commit)).challenge;
    assert.equal(ch.card.items[0].status, 'kept', 'non-regular source identity is not trusted');
    assert.equal((await b.call('create', { ...commit, approval: b.p.approval(ch) })).ok, true);
    assert.equal(existsSync(g.file), true);
    assert.equal(readFileSync(`${g.file}.target`, 'utf8'), g.text);
  } finally { b.broker.lock(); }
});

test('B2 partial cleanup failure reports possible removals as well as copies', async () => {
  const b = await fresh();
  const g = gmail(b.home);
  try {
    b.old.put(name, value);
    await b.call('create', stage);
    const ch = (await b.call('create', commit)).challenge;
    chmodSync(g.dir, 0o500); // Real filesystem failure after legacy-vault removal succeeds.
    const result = await b.call('create', { ...commit, approval: b.p.approval(ch) });
    assert.equal(result.error, 'failed');
    assert.equal((await b.call('list_refs')).refs.length, 2);
    assert.equal(existsSync(join(b.home, 'vault/secrets.json')), false);
    assert.equal(existsSync(g.file), true);
    assert.match(result.message, /copies.*removals.*may.*review.*resume/i);
    assert.doesNotMatch(result.message, /nothing was moved|provider\/A|canary-/);
  } finally { chmodSync(g.dir, 0o700); b.broker.lock(); }
});

test('B2 migration cards retain the pending-approval rate bound', async () => {
  const b = await fresh();
  try {
    b.old.put(name, value);
    await b.call('create', stage);
    for (let i = 0; i < 3; i++) assert.equal((await b.call('create', commit)).refused, 'needs_approval');
    assert.equal((await b.call('create', commit)).refused, 'rate');
    assert.equal((await b.call('list_refs')).refs.length, 0);
  } finally { b.broker.lock(); }
});
