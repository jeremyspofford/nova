// Proposal cards/digests must describe the complete effective binding set, including retained ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Person, boundCredential, inProcess, standIn, tmp } from '../support/broker-support.ts';

async function fresh() {
  const b = inProcess(join(tmp('nova-broker-proposal-card-'), 'broker'));
  const p = new Person(b.call);
  await p.setup({ passkey: true });
  return { ...b, p };
}
const propose = (changes: Record<string, unknown>) => ({ source: { migrate: 'propose', proposals: { 'provider/EXAMPLE_KEY': changes } } });
const scope = { methods: ['GET', 'POST'], paths: ['/api'] };

// Hand-derived public approval representation for a normal HTTP bearer binding.
const bearerCard = (origin: string) => ({ target: origin, kind: 'http', scope, inject: { how: 'bearer' }, consent: null, lan: false, pin: null, embed_on: [] });

test('a class-only proposal shows its retained target, scope and injection instead of claiming unbound', async () => {
  const b = await fresh();
  const site = await standIn();
  try {
    await boundCredential(b.p, site.origin, { class: 'standard', consent: false });
    const frame = propose({ class: 'sensitive' });
    const asked = await b.call('create', frame);
    assert.equal(asked.refused, 'needs_approval');
    const shown = asked.challenge.card.items[0];
    assert.equal(shown.target, site.origin, 'the approval must show the retained usable target');
    assert.deepEqual(shown.bindings, [bearerCard(site.origin)]);
    const applied = await b.call('create', { ...frame, approval: b.p.approval(asked.challenge) });
    assert.equal(applied.ok, true);
    assert.equal(applied.refs[0].class, 'sensitive');
    assert.deepEqual(applied.refs[0].bindings.map((binding: { target: string }) => binding.target), [site.origin]);
    assert.equal(site.requests.length, 0);
  } finally { b.broker.lock(); await site.close(); }
});

test('a proposal card includes retained bindings together with replaced and newly added bindings', async () => {
  const b = await fresh();
  const [a, retained, added] = await Promise.all([standIn(), standIn(), standIn()]);
  try {
    const made = await boundCredential(b.p, a.origin, { class: 'standard', consent: false });
    assert.equal((await b.p.approve('bind', { ref: made.ref, add: { target: { kind: 'http', origin: retained.origin }, scope, inject: { how: 'bearer' } } })).ok, true);
    const replacementScope = { methods: ['GET'], paths: ['/api/narrow'] };
    const replacementInject = { how: 'header', header: 'X-Narrow-Key' };
    const frame = propose({ class: 'standard', bind: [
      { target: { kind: 'http', origin: a.origin }, scope: replacementScope, inject: replacementInject },
      { target: { kind: 'http', origin: added.origin }, scope, inject: { how: 'bearer' } },
    ] });
    const asked = await b.call('create', frame);
    assert.equal(asked.refused, 'needs_approval');
    const shown = asked.challenge.card.items[0];
    assert.deepEqual(shown.bindings, [bearerCard(retained.origin), { ...bearerCard(a.origin), scope: replacementScope, inject: replacementInject }, bearerCard(added.origin)]);
    assert.equal(shown.target, `${retained.origin}, ${a.origin}, ${added.origin}`);
    const applied = await b.call('create', { ...frame, approval: b.p.approval(asked.challenge) });
    assert.equal(applied.ok, true);
    assert.deepEqual(applied.refs[0].bindings.map((binding: { target: string }) => binding.target), [retained.origin, a.origin, added.origin]);
    assert.equal(applied.refs[0].bindings[1].inject.header, 'X-Narrow-Key');
    assert.deepEqual(applied.refs[0].bindings[1].scope, replacementScope);
  } finally { b.broker.lock(); await Promise.all([a.close(), retained.close(), added.close()]); }
});

test('a proposal approval is invalid if a retained binding changes after the card was shown', async () => {
  const b = await fresh();
  const site = await standIn();
  try {
    const made = await boundCredential(b.p, site.origin, { class: 'standard', consent: false });
    const frame = propose({ class: 'sensitive' });
    const asked = await b.call('create', frame);
    assert.equal(asked.refused, 'needs_approval');
    const changed = await b.p.approve('bind', { ref: made.ref, add: {
      target: { kind: 'http', origin: site.origin }, scope: { methods: ['GET'], paths: ['/api/narrow'] }, inject: { how: 'header', header: 'X-New-Key' },
    } });
    assert.equal(changed.ok, true);
    // Sign the old challenge after the binding change so rejection must come from the action
    // digest, rather than the software authenticator's monotonically increasing signature counter.
    const stale = await b.call('create', { ...frame, approval: b.p.approval(asked.challenge) });
    assert.equal(stale.refused, 'approval_invalid', 'the approved effective binding set no longer matches');
    assert.equal((await b.call('list_refs')).refs[0].class, 'standard', 'the stale proposal is not applied');
    const freshApproval = await b.p.approve('create', frame);
    assert.equal(freshApproval.ok, true);
    assert.equal(freshApproval.refs[0].class, 'sensitive');
    assert.equal(freshApproval.refs[0].bindings[0].inject.header, 'X-New-Key');
    assert.equal(site.requests.length, 0);
  } finally { b.broker.lock(); await site.close(); }
});
