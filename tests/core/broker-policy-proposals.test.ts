// Migration proposal policy regressions: synthetic credentials, software passkeys and loopback only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { C, Person, boundCredential, inProcess, standIn, tmp } from '../support/broker-support.ts';

async function fresh() {
  const b = inProcess(join(tmp('nova-broker-proposal-policy-'), 'broker'));
  const p = new Person(b.call);
  await p.setup({ passkey: true });
  return { ...b, p };
}

const proposal = (proposals: Record<string, unknown>) => ({ source: { migrate: 'propose', proposals } });

test('an approved sensitive-class proposal revokes the old core-approved task grant', async () => {
  const b = await fresh();
  const site = await standIn();
  try {
    const made = await boundCredential(b.p, site.origin, { value: C('proposal-class'), class: 'standard', consent: false });
    const use = { ref: made.ref, target: { kind: 'http', origin: site.origin }, request: { method: 'GET', path: '/api/x' }, task: { id: 'same-task' } };
    const first = await b.call('use', use);
    assert.equal(first.refused, 'needs_approval');
    assert.equal(first.challenge.card.tier, 2);
    assert.equal((await b.call('use', { ...use, approval: b.p.approval(first.challenge, 'core') })).ok, true);
    assert.equal((await b.call('use', use)).ok, true, 'standard policy grants this request for its task');
    const changed = await b.p.approve('create', proposal({ 'provider/EXAMPLE_KEY': { class: 'sensitive' } }));
    assert.equal(changed.ok, true);
    assert.equal(changed.refs[0].class, 'sensitive');

    const again = await b.call('use', use);
    assert.equal(again.refused, 'needs_approval', 'the standard task grant cannot authorize a sensitive use');
    assert.equal(site.requests.length, 2, 'unapproved sensitive use never reaches the target');
    assert.equal(again.challenge.card.class, 'sensitive');
    assert.equal((await b.call('use', { ...use, approval: b.p.approval(again.challenge, 'core') })).refused, 'approval_invalid');
    assert.equal(site.requests.length, 2);
    assert.equal((await b.call('use', { ...use, approval: b.p.approval(again.challenge) })).ok, true, 'a fresh passkey approval authorizes the new policy');
    assert.equal(site.requests.length, 3);
  } finally { b.broker.lock(); await site.close(); }
});

test('restoring pre-proposal ciphertext cannot restore the former credential policy', async () => {
  const b = await fresh();
  const site = await standIn();
  try {
    const made = await boundCredential(b.p, site.origin, { value: C('proposal-rollback'), class: 'standard', consent: false });
    const file = join(b.dir, 'items', `${made.ref}.json`);
    const old = readFileSync(file);
    const changed = await b.p.approve('create', proposal({ 'provider/EXAMPLE_KEY': { class: 'sensitive' } }));
    assert.equal(changed.ok, true);
    // The approved policy is durable and its retained binding is still intact before rollback.
    await b.call('lock');
    assert.equal((await b.call('unlock', { device: true })).ok, true);
    const current = (await b.call('list_refs')).refs[0];
    assert.equal(current.class, 'sensitive');
    assert.equal(current.bindings[0].target, site.origin);

    writeFileSync(file, old);
    await b.call('lock');
    assert.equal((await b.call('unlock', { device: true })).ok, true);
    assert.deepEqual((await b.call('list_refs')).refs, [], 'old encrypted metadata is rejected rather than restoring standard policy');
    assert.deepEqual(b.broker.store.metas().broken, [made.ref]);
    assert.throws(() => b.broker.store.value(made.ref), /stale generation|authenticate/);
    assert.equal(site.requests.length, 0);
  } finally { b.broker.lock(); await site.close(); }
});

test('one approved multi-item proposal revokes every changed item grant and preserves every new policy', async () => {
  const b = await fresh();
  const site = await standIn();
  try {
    const names = ['provider/FIRST', 'provider/SECOND'];
    const items = [];
    for (const name of names) {
      const made = await boundCredential(b.p, site.origin, { name, value: C(name.split('/')[1]!), class: 'standard', consent: false });
      const use = { ref: made.ref, target: { kind: 'http', origin: site.origin }, request: { method: 'GET', path: '/api/x' }, task: { id: 'batch-task' } };
      assert.equal((await b.p.approve('use', use, { mode: 'core' })).ok, true);
      items.push({ ref: made.ref, use });
    }
    const changed = await b.p.approve('create', proposal(Object.fromEntries(names.map((name) => [name, { class: 'sensitive' }]))));
    assert.equal(changed.ok, true);
    assert.equal(changed.refs.length, 2);
    assert.ok(changed.refs.every((item: { class: string }) => item.class === 'sensitive'));
    for (const item of items) assert.equal((await b.call('use', item.use)).refused, 'needs_approval', item.ref);
    assert.equal(site.requests.length, 2, 'neither previous grant survives the approved batch');
    await b.call('lock');
    assert.equal((await b.call('unlock', { device: true })).ok, true);
    const refs = (await b.call('list_refs')).refs;
    assert.equal(refs.length, 2);
    assert.ok(refs.every((item: { class: string; bindings: unknown[] }) => item.class === 'sensitive' && item.bindings.length === 1));
  } finally { b.broker.lock(); await site.close(); }
});
