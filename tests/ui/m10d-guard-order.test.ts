// Ponytail Step 8d (P6): the order of the browser worker's guards, pinned in Chromium against the
// stand-in account site (scripts/stand-ins/account-site.js), on loopback. In each case one check
// passes and a later one must still refuse, or two would refuse and the earlier one must say so:
//   - a click whose element is on the page but isn't what the step means is refused before anything
//     is sent; on a button that pays, the intent check refuses first;
//   - a sign-in whose button pays: Nova has typed the saved sign-in (typing comes first), and nothing
//     is sent;
//   - an account step whose button pays: refused before the new password is kept aside, before the
//     commit point, before anything is sent;
//   - an account step whose password field isn't one: refused while typing, before all of that;
//   - an account step on a page that also tries to send what was typed: only the button's form leaves.
// Runs where Chromium can start (scripts/ui-test.sh; CI's UI gate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canBrowse, fakeLogin, startNova } from './m10b-support.ts';
import { startAccountSite } from '../../scripts/stand-ins/account-site.js';

type Site = Awaited<ReturnType<typeof startAccountSite>>;
// How the ledger words a worker's refusal (the worker's own words follow it).
const FAILED = "Browser couldn't do it: ";
const posts = (site: Site, path: string) => site.hits(path).filter((h: { method: string }) => h.method !== 'GET').length;

test('Ponytail 8d: the browser worker’s guards refuse in their order, on clicks, sign-ins and account steps', { timeout: 300_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const cred = fakeLogin();
  const site = await startAccountSite(cred);
  const others: Site[] = [];
  const n = await startNova('nova-p6d-order-');
  const { m, api } = n;
  const kinds = async (id: string) => (await n.events(id)).map((e) => e.kind);
  // An account created on a site of its own, so no sign-in is saved there yet.
  const create = async (path: string) => {
    const s = await startAccountSite();
    others.push(s);
    const r = await m.send('POST', api('/browser/accounts'), {
      change: 'create', site: s.host,
      steps: [{ do: 'navigate', url: `${s.url}${path}` }, { do: 'create_account', username: '#email', name: 'person@example.test', password: '#pw', confirm: '#pw2', submit: '#create', done_when: '#welcome' }],
      verify: { url: `${s.url}/status`, expect: ['Accounts: 1'] },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await m.send('POST', api(`/tasks/${r.body.id}/approve`), { confirm: true })).status, 200);
    return { s, id: r.body.id as string, done: await n.done(r.body.id as string) };
  };
  // No new password was kept aside for the site.
  const noPending = async (s: Site) => assert.equal((await m.send('POST', api(`/browser/logins/${s.host}/pending`), { keep: false, confirm: true })).status, 404);
  try {
    // 1. The element is there, but isn't what the step means: refused, nothing sent.
    const plan = (selector: string) => ({ allowed_hosts: [site.host], steps: [{ do: 'navigate', url: `${site.url}/buttons` }, { do: 'click', selector, intent: 'download the report' }], verify: { url: `${site.url}/status`, expect: ['Accounts'] } });
    for (const selector of ['#go', '#go-on']) {
      const { id, created } = await n.task(plan(selector), `Click ${selector}, which isn’t what the step means`);
      assert.ok(id, JSON.stringify(created.body));
      const done = await n.done(id!);
      assert.equal(done.state, 'failed', `${selector}: ${done.reason}`);
      // On #go-on, which pays, it is still the intent check that refuses: it comes first.
      assert.equal(done.reason, `${FAILED}${selector} doesn’t look like what the step means to do (“download the report”): Nova stopped instead of guessing.`);
      assert.ok(!(await kinds(id!)).includes('pay_refused'), `${selector}: refused before the pay check`);
    }
    assert.equal(posts(site, '/signup'), 0, 'neither click sent anything');

    // 2. A sign-in whose button pays: the saved sign-in is typed first, then the pay check refuses the
    // send, so nothing reaches the site.
    assert.equal((await m.send('PUT', api(`/browser/logins/${site.host}`), cred)).status, 200);
    const login = await n.task({ allowed_hosts: [site.host], steps: [{ do: 'navigate', url: `${site.url}/login-pay` }, { do: 'login', username: '#username', password: '#password', submit: '#signin', done_when: '#account' }], verify: { url: `${site.url}/status`, expect: ['Accounts: 1'] } }, 'Sign in where the button pays');
    assert.ok(login.id, JSON.stringify(login.created.body));
    const signed = await n.done(login.id!);
    assert.equal(signed.state, 'failed', `${signed.reason}`);
    assert.match(String(signed.reason), /^Browser couldn't do it: The sign-in button is a pay control \(it says “Pay now and sign in”\)\. Paying is tier 3/);
    assert.ok((await kinds(login.id!)).includes('signed_in_with'), 'the typing came before the pay check');
    assert.equal(posts(site, '/login'), 0, 'nothing was sent');

    // 3. An account step whose button pays: refused before the new password is kept aside, before the
    // commit point and before the send.
    const pay = await create('/signup-pay');
    assert.equal(pay.done.state, 'failed', `${pay.done.reason}`);
    assert.match(String(pay.done.reason), /^Browser couldn't do it: The button is a pay control \(it says “Pay now and create account”\)\. Paying is tier 3/);
    assert.ok(!(await kinds(pay.id)).includes('commit_point'), 'no commit point was recorded');
    await noPending(pay.s);
    assert.equal(posts(pay.s, '/signup'), 0);
    assert.deepEqual(pay.s.accounts(), []);

    // 4. An account step whose password field is plain text: refused while typing, in the account
    // step's own words, before any of that.
    const plain = await create('/signup-plain');
    assert.equal(plain.done.state, 'failed', `${plain.done.reason}`);
    assert.equal(plain.done.reason, `${FAILED}#pw isn’t a password field Nova will type a password into (not-a-field).`);
    assert.ok(!(await kinds(plain.id)).includes('commit_point'));
    await noPending(plain.s);
    assert.equal(posts(plain.s, '/signup'), 0);

    // 5. An account step on a page that also tries to send the typed form elsewhere: the button's own
    // form goes, nothing else does.
    const leaky = await create('/signup-leaky');
    assert.equal(leaky.done.state, 'done', `${leaky.done.reason}`);
    assert.deepEqual(leaky.s.accounts(), ['person@example.test']);
    const ev = await kinds(leaky.id);
    assert.ok(ev.includes('commit_point') && ev.includes('account_created'), JSON.stringify(ev));
    assert.ok(ev.includes('send_refused'), JSON.stringify(ev));
    assert.equal(posts(leaky.s, '/collect'), 0, 'the page’s own copy of the form was refused');
    console.log('  · Intent before pay on a click; typing, then pay, then pending and commit, then the scoped send, on sign-ins and account steps.');
  } finally {
    await n.close();
    await site.close();
    for (const s of others) await s.close();
  }
});
