// The vault is tier 3 (owner ruling 2026-11-09, docs/builder-packet/INPUT-2026-11-09-TIER-RULING.md):
// deleting a provider's secret needs {confirm: true}, with a passkey on Nova's own screen; starting
// a new vault is tier 3 and only for devices allowed to approve. A paired approver confirms either
// with {confirm: true} alone, no passkey, as for every tier-3 route. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enroll, hub, plainCall } from './mesh-support.ts';

test('DELETE /vault/{name} is tier 3: refused without {confirm: true}; on Nova’s own screen the confirm needs a passkey', async () => {
  const h = await hub();
  try {
    assert.equal((await h.c('PUT', '/vault/SOME_KEY', { value: 'placeholder-value-1' })).status, 200);
    const kept = () => h.core.vault.list().includes('provider/SOME_KEY');
    const raw = (body?: unknown) => plainCall(h.console, 'DELETE', '/api/v1/vault/SOME_KEY', body);

    const bare = await raw();
    assert.equal(bare.status, 400, JSON.stringify(bare.body));
    assert.match(bare.body.error, /needs \{confirm: true\}/);
    assert.equal((await raw({ confirm: false })).status, 400);
    // On Nova's own screen an explicit confirmation needs a passkey approval of exactly this request.
    assert.equal((await raw({ confirm: true })).status, 403);
    assert.ok(kept(), 'still in the vault');
    // A bad name is still refused first, in plain words.
    assert.equal((await h.c('DELETE', '/vault/lower_case', { confirm: true })).status, 400);

    // Confirmed, with a passkey approval (the test client signs it as the screen would).
    const gone = await h.c('DELETE', '/vault/SOME_KEY', { confirm: true });
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.deepEqual(gone.body, { name: 'SOME_KEY', deleted: true });
    assert.ok(!kept(), 'gone from the vault');
  } finally {
    await h.stop();
  }
});

test('the vault’s tier-3 routes are for approvers: a paired phone that can’t approve is refused; one that can confirms with the box alone', async () => {
  const h = await hub();
  try {
    assert.equal((await h.c('PUT', '/vault/SOME_KEY', { value: 'placeholder-value-2' })).status, 200);
    const { dev, token } = await enroll(h, { kind: 'phone', name: 'Phone' });
    const phone = (method: string, path: string, body?: unknown) => plainCall(h.mesh, method, `/api/v1${path}`, body, { authorization: `Bearer ${token}` });
    assert.equal((await phone('GET', '/vault')).status, 200, 'it is a person’s device: it may look');

    for (const [method, path] of [['DELETE', '/vault/SOME_KEY'], ['POST', '/vault/reset']] as const) {
      const r = await phone(method, path, { confirm: true });
      assert.equal(r.status, 403, `${method} ${path}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /allowed to approve/);
    }
    assert.ok(h.core.vault.list().includes('provider/SOME_KEY'), 'nothing changed');

    // The person lets the phone approve: it confirms a tier-3 route with {confirm: true}, no passkey.
    assert.equal((await h.c('PATCH', `/mesh/devices/${dev.deviceId}`, { can_approve: true, confirm: true })).status, 200);
    assert.equal((await phone('DELETE', '/vault/SOME_KEY')).status, 400, 'still tier 3: the box is needed');
    const gone = await phone('DELETE', '/vault/SOME_KEY', { confirm: true });
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.deepEqual(gone.body, { name: 'SOME_KEY', deleted: true });
    assert.equal((await phone('POST', '/vault/reset', {})).status, 400, 'a reset needs the box too');
    const reset = await phone('POST', '/vault/reset', { confirm: true });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.equal(reset.body.secrets, 0);
  } finally {
    await h.stop();
  }
});

test('the vault routes say their tier and who may use them', async () => {
  const h = await hub();
  try {
    const doc = h.core.openapi as unknown as { paths: Record<string, Record<string, { summary?: string; 'x-nova-access'?: string }>> };
    const del = doc.paths['/api/v1/vault/{name}']!.delete!;
    const reset = doc.paths['/api/v1/vault/reset']!.post!;
    assert.match(del.summary ?? '', /tier 3/);
    assert.match(del.summary ?? '', /confirm: true/);
    assert.equal(del['x-nova-access'], 'approver');
    assert.match(reset.summary ?? '', /tier 3/);
    assert.equal(reset['x-nova-access'], 'approver');
  } finally {
    await h.stop();
  }
});
