// M10b gate 1: a login runs from the vault, and the fake secret is nowhere Nova writes. The sign-in
// is saved through the API (as Settings does; never in chat), the browser worker types it into the
// stand-in sign-in page at the moment of use, and then everything is searched for it: every file in
// the test's machine (Nova's home with its database, logs, sessions, evidence and browser profile,
// and the user folder), the server's own output, the task's record and report over the API, and
// every request the stand-in local model got (the co-pilot's and the screen's: model context).
// Then: the sign-in is kept per site in Nova's profile between tasks, and Forget deletes it.
// Runs where Chromium can start (scripts/ui-test.sh; CI's UI gate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canBrowse, fakeLogin, filesHolding, startNova, startShop } from './m10b-support.ts';

test('M10b gate 1: a login from the vault leaves the fake secret in no transcript, log, evidence, profile or model request; kept per site, then forgotten', { timeout: 240_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const cred = fakeLogin();
  const shop = await startShop({ ...cred });
  const n = await startNova('nova-m10b-login-', { model: true });
  try {
    const { m, api } = n;
    const saved = await m.send('PUT', api(`/browser/logins/${shop.host}`), cred);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.ok(!JSON.stringify(saved.body).includes(cred.password));
    const plan = {
      allowed_hosts: [shop.host],
      steps: [
        { do: 'navigate', url: `${shop.url}/login` },
        { do: 'login', username: '#username', password: '#password', submit: '#signin', done_when: '#account' },
        { do: 'read', selector: '#account', expect: 'Signed in' },
      ],
      verify: { url: `${shop.url}/signins`, expect: ['Signed in: 1'] },
    };
    const { id, created } = await n.task(plan, 'Sign in to the example shop');
    assert.ok(id, JSON.stringify(created.body));
    assert.equal(created.body.approval_tier, 2, 'signing in sends something: it asks first');
    const done = await n.done(id!);
    assert.equal(done.state, 'done', `${done.reason}`);
    const ev = await n.events(id!);
    assert.ok(ev.some((e) => e.kind === 'signed_in_with' && e.detail.fields === 2), 'the worker signed in');
    assert.ok(ev.some((e) => e.kind === 'copilot' && e.detail.model === true), 'the co-pilot was asked, on the local model');
    assert.equal(shop.hits('/login').filter((h: { method: string }) => h.method === 'POST').length, 1, 'the stand-in got exactly one sign-in');

    // The search: nothing Nova wrote holds the username or the password.
    const secrets = [cred.password, cred.username];
    const files = filesHolding(m.dir, secrets);
    assert.deepEqual(files, [], `files holding the fake secret: ${files.join(', ')}`);
    assert.ok(!secrets.some((s) => n.nova.out.join('').includes(s)), 'the server’s own output');
    const task = await m.get(api(`/tasks/${id}`));
    for (const [what, v] of [['the task and its report', task], ['its events', ev], ['the sites list', await m.get(api('/browser/sites'))], ['the log', await m.get(api('/log?limit=500')).catch(() => [])]] as const) {
      assert.ok(!secrets.some((s) => JSON.stringify(v).includes(s)), what);
    }
    const asked = n.ollama!.requests.filter((r: { path: string }) => r.path === '/api/chat');
    assert.ok(asked.length > 0, 'the local model was asked');
    assert.ok(!secrets.some((s) => JSON.stringify(n.ollama!.requests).includes(s)), 'no model request held it');
    console.log(`  · Signed in from the vault; searched ${m.dir} (every file), the server's output, the task, its ${ev.length} events and ${asked.length} model requests: the fake secret is in none.`);

    // Kept per site: the next task is signed in already, in Nova's own profile, with no new sign-in
    // (the stand-in still counts one).
    const again = await n.task({ allowed_hosts: [shop.host], steps: [{ do: 'navigate', url: `${shop.url}/account` }, { do: 'read', selector: '#account', expect: 'Signed in' }], verify: { url: `${shop.url}/signins`, expect: ['Signed in: 1'] } }, 'Open the account page');
    const kept = await n.done(again.id!);
    assert.equal(kept.state, 'done', `${kept.reason}`);
    const sites = (await m.get(api('/browser/sites'))).sites as { site: string; login: boolean }[];
    assert.deepEqual(sites.filter((s) => s.site === shop.host).map((s) => s.login), [true]);

    // Forget is tier 3: refused without confirm; with it, the site's cookies leave the profile, so
    // the next sign-in is needed again (the stand-in counts two).
    assert.equal((await m.send('POST', api(`/browser/sites/${shop.host}/forget`), {})).status, 400);
    const forgot = await m.send('POST', api(`/browser/sites/${shop.host}/forget`), { confirm: true });
    assert.equal(forgot.status, 200, JSON.stringify(forgot.body));
    assert.ok(forgot.body.cookies >= 1, JSON.stringify(forgot.body));
    const relog = await n.task({ ...plan, verify: { url: `${shop.url}/signins`, expect: ['Signed in: 2'] } }, 'Sign in again');
    const second = await n.done(relog.id!);
    assert.equal(second.state, 'done', `${second.reason}`);
    assert.deepEqual(filesHolding(m.dir, secrets), [], 'still nowhere, after a second sign-in');
    // And the saved sign-in itself can go (tier 3 again).
    const del = await m.send('POST', api(`/browser/sites/${shop.host}/forget`), { confirm: true, login: true });
    assert.equal(del.body.login, true);
    assert.deepEqual(((await m.get(api('/browser/sites'))).sites as { site: string }[]).filter((s) => s.site === shop.host), []);
  } finally {
    await n.close();
    await shop.close();
  }
});
