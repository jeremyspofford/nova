// B1/B4: the person compares real holder keys; actual Broker.start indexes auto adoption
// and requires a person factor for ask adoption. Synthetic homes/file keys and canaries only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { C, PASS, Person, anyForm, inProcess } from '../support/broker-support.ts';

const fingerprint = (publicKey: string) => createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex');
const visibleCard = (card: { what: string; target?: string; approving: string }) => [card.what, card.target, card.approving].join('\n');
type Running = ReturnType<typeof inProcess>;

function deliver(hub: Running, holder: Running) {
  const inbox = join(holder.dir, 'inbox');
  mkdirSync(inbox, { recursive: true, mode: 0o700 });
  cpSync(join(hub.dir, 'outbox', 'header.json'), join(inbox, 'header.json'));
  cpSync(join(hub.dir, 'items'), join(inbox, 'items'), { recursive: true });
}

async function shared(ask: boolean) {
  const hub = inProcess();
  const person = new Person(hub.call);
  await person.setup({ ask });
  const made = await person.approve('create', { meta: { name: 'provider/HOLDER', kind: 'api_key' }, source: 'sealed' }, {
    seal: C('holder-value'), sealAt: (f, sealed) => ({ ...f, source: { sealed } }),
  });
  assert.equal(made.ok, true);
  const holder = inProcess();
  const dev = holder.broker.store.device();
  assert.equal((await person.approve('share_scope', { device: { id: dev.id, public_key: dev.public, name: 'holder' } })).ok, true);
  const header = JSON.parse(readFileSync(join(hub.dir, 'outbox', 'header.json'), 'utf8'));
  assert.ok(header.sig, 'use the hub broker’s actual signed outbox');
  assert.equal((await new Person(holder.call).approve('share_scope', { hub: { signer: header.signer, name: 'hub' } })).ok, true);
  deliver(hub, holder);
  return { hub, holder, person, refs: (await hub.call('list_refs')).refs, made };
}

for (const passkey of [false, true]) {
  test(`holder fingerprints show the proposed decoded X25519 key and expose substitution (${passkey ? 'software passkey' : 'core'} approval)`, async () => {
    const hub = inProcess();
    const person = new Person(hub.call);
    await person.setup({ passkey });
    const holder = inProcess();
    const substitute = inProcess();
    const dev = holder.broker.store.device();
    const other = substitute.broker.store.device();
    const state = (await holder.call('list_refs')).state;
    const want = fingerprint(dev.public);
    assert.match(want, /^[a-f0-9]{64}$/);
    assert.notEqual(want, fingerprint(other.public));
    const device = { id: dev.id, public_key: dev.public, name: 'holder' };
    const original = await hub.call('share_scope', { device });
    assert.equal(original.refused, 'needs_approval');
    assert.equal(original.challenge.card.target, `device:${dev.id}`);
    assert.ok(visibleCard(original.challenge.card).includes(want), 'the existing visible card fields show the full fingerprint');
    const changed = await hub.call('share_scope', { device: { ...device, public_key: other.public } });
    assert.ok(visibleCard(changed.challenge.card).includes(fingerprint(other.public)));
    assert.equal(visibleCard(changed.challenge.card).includes(want), false, 'a substituted key is visibly different even with the same name and device id');
    assert.equal(state.device_key_fingerprint, want, 'the holder shows SHA256 of its decoded public key bytes');
    assert.equal(existsSync(join(hub.dir, 'outbox', 'header.json')), false, 'declining both proposals creates no outbox');
    assert.equal(hub.broker.store.header!.holders[dev.id], undefined);
    const answers = JSON.stringify([...hub.answers, ...holder.answers]);
    for (const dir of [hub.dir, holder.dir, substitute.dir]) {
      assert.equal(anyForm(answers, readFileSync(join(dir, 'device.key')).toString('base64')), null, 'no device private key in an answer');
    }
    assert.equal(anyForm(answers, PASS), null);
  });

  test(`changing a holder key after ${passkey ? 'software passkey' : 'core'} approval remains refused`, async () => {
    const hub = inProcess();
    const person = new Person(hub.call);
    await person.setup({ passkey });
    const holder = inProcess();
    const other = inProcess();
    const dev = holder.broker.store.device();
    const device = { id: dev.id, public_key: dev.public, name: 'holder' };
    const ch = (await hub.call('share_scope', { device })).challenge;
    const approval = person.approval(ch);
    assert.equal((await hub.call('share_scope', { device: { ...device, public_key: other.broker.store.device().public }, approval })).refused, 'approval_invalid');
    assert.equal(existsSync(join(hub.dir, 'outbox', 'header.json')), false);
    assert.equal(hub.broker.store.header!.holders[dev.id], undefined);
    assert.equal((await hub.call('share_scope', { device, approval })).ok, true, 'the approval still covers exactly the original key');
  });
}

test('Broker.start indexes auto adoption immediately, including a later signed generation', async () => {
  const { hub, holder, refs } = await shared(false);
  const boot = inProcess(holder.dir);
  const first = await boot.call('list_refs');
  assert.equal(first.state.locked, false);
  assert.deepEqual(first.refs, refs, 'auto adoption lists the hub’s actual metadata without an unlock message');
  const oldInbox = join(holder.dir, 'old-inbox');
  cpSync(join(holder.dir, 'inbox'), oldInbox, { recursive: true });
  hub.broker.store.rotateRoot();
  hub.broker.store.writeOutbox();
  deliver(hub, holder);
  const next = inProcess(holder.dir);
  assert.equal(next.broker.store.header!.gen, hub.broker.store.header!.gen);
  assert.deepEqual((await next.call('list_refs')).refs, refs);
  cpSync(oldInbox, join(holder.dir, 'inbox'), { recursive: true });
  const replayed = inProcess(holder.dir);
  assert.equal(replayed.broker.store.header!.gen, hub.broker.store.header!.gen, 'an older genuinely signed header cannot roll back the held generation');
  assert.deepEqual((await replayed.call('list_refs')).refs, refs);
  assert.equal(anyForm(JSON.stringify([...boot.answers, ...next.answers]), C('holder-value')), null);
});

test('Broker.start ask adoption stays locked on first and incoming generations until a person factor', async () => {
  const { hub, holder, refs } = await shared(true);
  for (let generation = 0; generation < 2; generation++) {
    if (generation) {
      hub.broker.store.rotateRoot();
      hub.broker.store.writeOutbox();
      deliver(hub, holder);
    }
    const boot = inProcess(holder.dir);
    const listed = await boot.call('list_refs');
    assert.equal(boot.broker.store.header!.gen, hub.broker.store.header!.gen, 'the incoming signed generation was actually adopted');
    assert.equal(listed.state.locked, true, 'adoption must discard the temporary root in ask mode');
    assert.deepEqual(listed.refs, []);
    assert.equal(boot.broker.store.unlocked, false);
    assert.throws(() => boot.broker.store.value(refs[0].ref), /locked/);
    assert.equal((await boot.call('unlock', { device: true })).refused, 'locked', 'a core-relayed device unlock cannot bypass ask mode');
    assert.equal((await boot.call('list_refs')).state.locked, true);
    const person = new Person(boot.call);
    assert.equal((await boot.call('unlock', { passphrase: await person.factor('passphrase', PASS) })).ok, true);
    assert.deepEqual((await boot.call('list_refs')).refs, refs);
    boot.broker.lock();
    assert.equal((await inProcess(holder.dir).call('list_refs')).state.locked, true, 'restart without a new generation also stays locked');
  }
});

test('Broker.start retains hub pin and signed-header checks before any adoption', async () => {
  const { hub, holder } = await shared(false);
  const path = join(holder.dir, 'inbox', 'header.json');
  const signed = readFileSync(path, 'utf8');
  const header = JSON.parse(signed);
  writeFileSync(path, JSON.stringify({ ...header, gen: header.gen + 1 }));
  const tampered = inProcess(holder.dir);
  assert.equal(tampered.broker.store.exists, false);
  assert.deepEqual((await tampered.call('list_refs')).refs, []);
  writeFileSync(path, signed);
  const unpinned = inProcess();
  const dev = unpinned.broker.store.device();
  hub.broker.store.enrollHolder(dev.id, dev.public, 'unpinned');
  deliver(hub, unpinned);
  assert.equal(inProcess(unpinned.dir).broker.store.exists, false, 'a signed header cannot establish its own pin');
  const accepted = inProcess(holder.dir);
  assert.equal(accepted.broker.store.header!.hub_signer, header.signer);
});
