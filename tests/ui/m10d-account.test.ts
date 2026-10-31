// M10d gate: account steps in Nova Browser, in Chromium against the stand-in account site
// (scripts/stand-ins/account-site.js), on loopback. No real account is created or changed.
//   - a password change: tier 3, confirmed; Nova makes the new password, the site takes it, the vault
//     holds it (a sign-in with the saved sign-in works with it), and it is nowhere Nova writes;
//   - an account created: tier 3; its password saved as the site's sign-in, nowhere else;
//   - two-step sign-in: tier 3, and the person types the code the site sent, through takeover;
//     Nova never types it.
// Runs where Chromium can start (scripts/ui-test.sh; CI's UI gate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canBrowse, fakeLogin, filesHolding, startNova, until } from './m10b-support.ts';
import { startAccountSite } from '../../scripts/stand-ins/account-site.js';

test('M10d gate: a password change, an account creation and a two-step change in Nova’s browser, each tier 3 with the person present; no password anywhere Nova writes', { timeout: 300_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const cred = fakeLogin();
  const site = await startAccountSite(cred);
  const site2 = await startAccountSite();
  const n = await startNova('nova-m10d-account-');
  const { m, api } = n;
  // An account change: made, asked at tier 3, refused without the confirmation, then confirmed.
  const account = async (body: Record<string, unknown>) => {
    const r = await m.send('POST', api('/browser/accounts'), body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.approval_tier, 3);
    assert.equal(r.body.state, 'waiting');
    assert.equal((await m.send('POST', api(`/tasks/${r.body.id}/approve`), {})).status, 400, 'tier 3 needs the confirmation');
    assert.equal((await m.send('POST', api(`/tasks/${r.body.id}/approve`), { confirm: true })).status, 200);
    return r.body.id as string;
  };
  try {
    assert.equal((await m.send('PUT', api(`/browser/logins/${site.host}`), cred)).status, 200);
    const signIn = [{ do: 'navigate', url: `${site.url}/login` }, { do: 'login', username: '#username', password: '#password', submit: '#signin', done_when: '#account' }];

    // 1. A password change.
    const id = await account({
      change: 'password', site: site.host,
      steps: [...signIn, { do: 'navigate', url: `${site.url}/password` }, { do: 'new_password', current: '#current', password: '#new', confirm: '#again', submit: '#save', done_when: '#changed' }],
      verify: { url: `${site.url}/status`, expect: ['Password changes: 1'] },
    });
    const done = await n.done(id);
    assert.equal(done.state, 'done', `${done.reason}`);
    const ev = await n.events(id);
    assert.ok(ev.some((e) => e.kind === 'password_changed' && e.detail.site === site.host));
    assert.ok(ev.some((e) => e.kind === 'commit_point'), 'the send was its commit point');
    const fresh = site.passwordOf(cred.username)!;
    assert.notEqual(fresh, cred.password, 'the site has a new password');
    assert.equal(fresh.length, 24);
    // The vault holds it: a sign-in with the saved sign-in works now, and the old one no longer would.
    const again = await n.task({ allowed_hosts: [site.host], profile: 'fresh', steps: [...signIn, { do: 'read', selector: '#account', expect: 'Signed in' }], verify: { url: `${site.url}/status`, expect: ['Accounts: 1'] } }, 'Sign in with the saved sign-in');
    const signed = await n.done(again.id!);
    assert.equal(signed.state, 'done', `${signed.reason}`);
    console.log('  · Password changed at tier 3: the site took a 24-character password Nova made, and a fresh sign-in from the vault works with it.');

    // 2. An account created on a second site.
    const id2 = await account({
      change: 'create', site: site2.host,
      steps: [{ do: 'navigate', url: `${site2.url}/signup` }, { do: 'create_account', username: '#email', name: 'person@example.test', password: '#pw', confirm: '#pw2', submit: '#create', done_when: '#welcome' }],
      verify: { url: `${site2.url}/status`, expect: ['Accounts: 1'] },
    });
    const made = await n.done(id2);
    assert.equal(made.state, 'done', `${made.reason}`);
    assert.deepEqual(site2.accounts(), ['person@example.test']);
    const made2 = site2.passwordOf('person@example.test')!;
    assert.equal(made2.length, 24);
    const sites = (await m.get(api('/browser/sites'))).sites as { site: string; login: boolean }[];
    assert.ok(sites.some((s) => s.site === site2.host && s.login), 'its sign-in is saved');

    // A plan that tries to type the code itself, into a field its selector doesn't name as one: the page
    // refuses (the field asks for a one-time code), and nothing is turned on (review of PR #241).
    const sneaky = await account({
      change: 'mfa', site: site.host,
      steps: [...signIn, { do: 'navigate', url: `${site.url}/security` }, { do: 'click', selector: '#enable-2fa', intent: 'turn on two-step sign-in' }, { do: 'fill', selector: 'form input[type=text]', value: '123456' }, { do: 'code', why: 'Type the code.', done_when: '#mfa-on' }],
      verify: { url: `${site.url}/status`, expect: ['Two-step: on'] },
    });
    const stopped = await n.done(sneaky);
    assert.equal(stopped.state, 'failed', `${stopped.reason}`);
    assert.match(String(stopped.reason), /Nova never types a password or a code from a plan/);
    assert.equal(site.mfa(cred.username), false);

    // 3. Two-step sign-in: Nova asks for the person, who types the code the site sent.
    const id3 = await account({
      change: 'mfa', site: site.host,
      steps: [...signIn, { do: 'navigate', url: `${site.url}/security` }, { do: 'click', selector: '#enable-2fa', intent: 'turn on two-step sign-in' }, { do: 'code', why: 'Type the code the site sent to your phone.', done_when: '#mfa-on' }],
      verify: { url: `${site.url}/status`, expect: ['Two-step: on'] },
    });
    const asked = await until(() => m.get(api(`/browser/tasks/${id3}`)), (v: any) => v.live && v.mode === 'needs_person', 60_000);
    assert.match(String(asked.asked), /Type the code the site sent to your phone\. Type it yourself: Nova doesn’t read or type codes\./);
    const code = site.lastCode()!;
    assert.match(code, /^\d{6}$/);
    assert.equal((await m.send('POST', api(`/browser/tasks/${id3}/takeover`))).status, 200);
    assert.equal((await m.send('POST', api(`/browser/tasks/${id3}/input`), { type: 'click', x: 100 / 1280, y: 40 / 800 })).status, 200);
    assert.equal((await m.send('POST', api(`/browser/tasks/${id3}/input`), { type: 'text', text: code })).status, 200);
    assert.equal((await m.send('POST', api(`/browser/tasks/${id3}/input`), { type: 'key', key: 'Enter' })).status, 200);
    await until(async () => site.mfa(cred.username), (x) => x === true, 10_000);
    assert.equal((await m.send('POST', api(`/browser/tasks/${id3}/handback`))).status, 200);
    const mfa = await n.done(id3);
    assert.equal(mfa.state, 'done', `${mfa.reason}`);
    assert.equal(site.mfa(cred.username), true);
    const ev3 = await n.events(id3);
    assert.ok(ev3.some((e) => e.kind === 'takeover_started'), 'the person took over for the code');
    assert.ok(!JSON.stringify(ev3).includes(code), 'the code isn’t in the task’s record');

    // Nowhere Nova writes: every file under the test's machine, the server's output, the tasks and their events.
    const secrets = [cred.password, fresh, made2];
    const files = filesHolding(m.dir, secrets);
    assert.deepEqual(files, [], `files holding a password: ${files.join(', ')}`);
    assert.ok(!secrets.some((s) => n.nova.out.join('').includes(s)), 'the server’s own output');
    const records = JSON.stringify([await m.get(api('/tasks')), ev, await n.events(id2), ev3, await m.get(api('/browser/sites'))]);
    assert.ok(!secrets.some((s) => records.includes(s)), 'the tasks, their reports and events');
    console.log(`  · Account created and two-step sign-in turned on (the code typed by the person through takeover). Searched ${m.dir}: no password is in any file.`);
  } finally {
    await n.close();
    await site.close();
    await site2.close();
  }
});
