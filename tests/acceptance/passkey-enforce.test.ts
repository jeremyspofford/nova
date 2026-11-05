// Insertion #3 T2, part 3: on Nova's own screen, tier 3 needs a passkey. A request carrying only
// X-Nova (any program on this computer can send that) is refused, with no passkey yet and with
// one; an approval made for another request is refused; the real one goes through. Tier 2 on the
// same screen is unchanged: no passkey, no friction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blank, stop, until } from './support.ts';
import { assertion, consoleOrigin, enrollPasskeys } from './passkey-support.ts';

test('T2: tier 3 from the console needs a passkey; X-Nova alone is refused; tier 2 is unchanged', { timeout: 60_000 }, async () => {
  const m = blank('nova-passkey-enforce-');
  const nova = await m.start();
  // Plain requests, as another program on this computer would send them: no passkey step.
  const raw = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(m.base + p, { method, headers: { 'content-type': 'application/json', 'x-nova': '1', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() };
  };
  const task = async (tier: 2 | 3, name: string) => {
    const t = (await raw('POST', '/api/v1/tasks', { title: `Save ${name}`, owner: 'workspace', goal: 'Saved.', approval_tier: tier, evidence_required: [{ kind: 'read_back', target: `workspace:notes/${name}.md` }], inputs: { action: 'write', path: `notes/${name}.md`, content: '- one\n' } })).body;
    return until<any>(() => m.get(`/api/v1/tasks/${t.id}`), (x) => x.state === 'waiting');
  };
  try {
    const three = await task(3, 'three');
    const none = await raw('POST', `/api/v1/tasks/${three.id}/approve`, { confirm: true });
    assert.equal(none.status, 403);
    assert.match(none.body.error, /No passkey yet: tier-3 actions on Nova’s own screen wait until you add one in Settings › Security\. Nothing was approved\./);

    await enrollPasskeys(raw, m.base);
    const bare = await raw('POST', `/api/v1/tasks/${three.id}/approve`, { confirm: true });
    assert.equal(bare.status, 403, 'X-Nova alone is not a person');
    assert.match(bare.body.error, /Tier-3 actions on Nova’s own screen are confirmed with a passkey, and this request had none, so nothing was approved\./);
    assert.equal((await m.get(`/api/v1/tasks/${three.id}`)).state, 'waiting');

    const ask = (body: unknown) => raw('POST', '/api/v1/security/approvals', { method: 'POST', path: `/tasks/${three.id}/approve`, body });
    const forOther = (await ask({ confirm: true, note: 'something else' })).body;
    const wrong = await raw('POST', `/api/v1/tasks/${three.id}/approve`, { confirm: true, passkey_approval: assertion(forOther, consoleOrigin(m.base)) });
    assert.equal(wrong.status, 403);
    assert.match(wrong.body.error, /made for another action/);

    const right = (await ask({ confirm: true })).body;
    const ok = await raw('POST', `/api/v1/tasks/${three.id}/approve`, { confirm: true, passkey_approval: assertion(right, consoleOrigin(m.base)) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const again = await raw('POST', `/api/v1/tasks/${three.id}/approve`, { confirm: true, passkey_approval: assertion(right, consoleOrigin(m.base)) });
    assert.equal(again.status, 403, 'an approval is used once');

    const two = await task(2, 'two');
    assert.equal((await raw('POST', `/api/v1/tasks/${two.id}/approve`, {})).status, 200, 'tier 2 asks once, no passkey');
  } finally {
    await stop(nova);
  }
});

test('looser privacy from Settings is tier 3: refused without a confirmation, stricter never asks', { timeout: 60_000 }, async () => {
  const m = blank('nova-privacy-gate-');
  const nova = await m.start();
  try {
    const looser = await m.plain('PUT', '/api/v1/profile/privacy/default', { value: 'cloud-allowed' });
    assert.equal(looser.status, 400);
    assert.match(looser.body.error, /loosens a gate \(tier 3\)/);
    assert.equal((await m.get('/api/v1/profile')).privacy?.default ?? 'local-only', 'local-only', 'nothing changed');
    assert.equal((await m.plain('PUT', '/api/v1/profile/privacy/default', { value: 'cloud-allowed', confirm: true })).status, 403, 'and its confirmation needs the passkey');
    assert.equal((await m.send('PUT', '/api/v1/profile/privacy/default', { value: 'cloud-allowed', confirm: true })).status, 200, 'with it, as the screen sends it');
    assert.equal((await m.plain('PUT', '/api/v1/profile/privacy/default', { value: 'local-only' })).status, 200, 'stricter never asks');
  } finally {
    await stop(nova);
  }
});
