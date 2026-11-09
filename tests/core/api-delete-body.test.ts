// A DELETE that carries a JSON body gets it, through the real HTTP API: removing a saved sign-in
// needs {confirm: true} (tier 3, with a passkey on Nova's own screen), and removing a passkey needs
// {approval} from one you keep. A DELETE with no body still works as it always has.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertion, consoleOrigin, enrollPasskeys, PASSKEY } from '../acceptance/passkey-support.ts';
import { bootCore, sleep } from './connector-support.ts';

// A request as a client sends it, unsigned: a body only when one is given.
async function raw(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'x-nova': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('DELETE /browser/logins/{host} is refused without {confirm: true} and works with it (and a passkey)', async () => {
  const b = await bootCore();
  try {
    const base = b.origin;
    assert.equal((await b.call('PUT', '/browser/logins/shop.example', { username: 'placeholder-user', password: 'placeholder-pass' })).status, 200);
    const saved = () => b.get('/browser/sites').then((r) => r.sites.find((s: { site: string }) => s.site === 'shop.example'));

    // No body, or a body without confirm: tier 3 says no, and the sign-in stays.
    const bare = await raw(base, 'DELETE', '/browser/logins/shop.example');
    assert.equal(bare.status, 400);
    assert.match(bare.body.error, /needs \{confirm: true\}/);
    assert.equal((await raw(base, 'DELETE', '/browser/logins/shop.example', { confirm: false })).status, 400);
    // On Nova's own screen an explicit confirmation needs a passkey approval of exactly this request.
    const unsigned = await raw(base, 'DELETE', '/browser/logins/shop.example', { confirm: true });
    assert.equal(unsigned.status, 403);
    assert.ok((await saved())?.login, 'still saved');

    // Confirmed, with a passkey approval (the test client signs it as the screen would).
    const gone = await b.call('DELETE', '/browser/logins/shop.example', { confirm: true });
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.deepEqual(gone.body, { site: 'shop.example', deleted: true });
    assert.ok(!(await saved())?.login, 'the sign-in is gone');
    assert.deepEqual((await b.call('DELETE', '/browser/logins/shop.example', { confirm: true })).body, { site: 'shop.example', deleted: false });
  } finally {
    await b.stop();
  }
});

test('DELETE /security/passkeys/{id} removes a passkey with a valid approval, and refuses a bad one or the last', async () => {
  const b = await bootCore();
  try {
    const base = b.origin;
    const origin = consoleOrigin(base);
    const h = { origin };
    await enrollPasskeys((m, p, body, hd) => raw(base, m, p.slice('/api/v1'.length), body, hd), base);
    const [first, second] = PASSKEY.ids as [string, string];
    const count = async () => (await raw(base, 'GET', '/security/passkeys', undefined, h)).body.count;
    assert.equal(await count(), 2);
    const challenge = async (id: string) => {
      const c = await raw(base, 'POST', `/security/passkeys/${encodeURIComponent(id)}/remove-challenge`, {}, h);
      assert.equal(c.status, 200, JSON.stringify(c.body));
      return c.body;
    };

    // No approval, a garbled one, and one signed for removing the other passkey: all refused.
    const none = await raw(base, 'DELETE', `/security/passkeys/${encodeURIComponent(first)}`, undefined, h);
    assert.equal(none.status, 403);
    assert.match(none.body.error, /needs one you already have: no approval/);
    assert.equal((await raw(base, 'DELETE', `/security/passkeys/${encodeURIComponent(first)}`, { approval: { id: 'x', digest: 'y' } }, h)).status, 403);
    const forOther = assertion(await challenge(second), origin, second);
    const wrong = await raw(base, 'DELETE', `/security/passkeys/${encodeURIComponent(first)}`, { approval: forOther }, h);
    assert.equal(wrong.status, 403);
    assert.match(wrong.body.error, /another action/);
    assert.equal(await count(), 2, 'nothing was removed');

    // Signed with the passkey kept, for exactly this removal: removed.
    await sleep(5);
    const ok = await raw(base, 'DELETE', `/security/passkeys/${encodeURIComponent(first)}`, { approval: assertion(await challenge(first), origin, second) }, h);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.passkeys.map((p: { id: string }) => p.id), [second]);

    // The last passkey stays, even with a good approval.
    await sleep(5);
    const last = await raw(base, 'DELETE', `/security/passkeys/${encodeURIComponent(second)}`, { approval: assertion(await challenge(second), origin, second) }, h);
    assert.equal(last.status, 409);
    assert.match(last.body.error, /only passkey/);
    assert.equal(await count(), 1);
  } finally {
    await b.stop();
  }
});

test('a DELETE route that takes no body works with no body, and with an empty one', async () => {
  const b = await bootCore();
  try {
    const base = b.origin;
    assert.equal((await b.call('PUT', '/vault/SOME_KEY', { value: 'placeholder-value' })).status, 200);
    // No body and no content-type at all.
    const bare = await raw(base, 'DELETE', '/vault/SOME_KEY');
    assert.equal(bare.status, 200, JSON.stringify(bare.body));
    assert.deepEqual(bare.body, { name: 'SOME_KEY', deleted: true });
    // A content-type but no body (what the screen's own client sends).
    const res = await fetch(`${base}/api/v1/vault/SOME_KEY`, { method: 'DELETE', headers: { 'x-nova': '1', 'content-type': 'application/json' } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { name: 'SOME_KEY', deleted: false });
    assert.deepEqual((await raw(base, 'DELETE', '/vault/SOME_KEY', {})).body, { name: 'SOME_KEY', deleted: false });
  } finally {
    await b.stop();
  }
});
