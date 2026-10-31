// Accounts through chat (M10d, docs/plans/M10d.md): account steps in Nova Browser's plans, without a
// browser. The validator (account changes are tier 3; a plan never holds a password; a password or
// code field is never filled from a plan; MFA needs a code the person types), the password Nova makes,
// and the presence check: a confirmation left waiting stops before any browser opens and asks again.
// What needs Chromium is in tests/ui/m10d-account.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../../src/core/index.ts';
import { isAccount, minTierOf, validatePlan } from '../../src/core/browser/plan.ts';
import { generatePassword, loginName } from '../../src/core/browser/logins.ts';
import { ACCOUNT_PRESENT_MS } from '../../src/core/browser/worker.ts';

const SITE = '127.0.0.1:5000';
const base = { allowed_hosts: [SITE] };
const change = {
  ...base, account: { change: 'password', site: SITE },
  steps: [
    { do: 'navigate', url: `http://${SITE}/account/password` },
    { do: 'new_password', current: '#current', password: '#new', confirm: '#again', submit: '#save', done_when: '#changed' },
  ],
  verify: { url: `http://${SITE}/account`, expect: ['Password changed'] },
};
const refused = (inputs: unknown, why: RegExp) => assert.throws(() => validatePlan(inputs), (e: any) => why.test(e.details.join(' ')), JSON.stringify(inputs));

test('M10d accounts: account steps are tier 3, always; the plan names fields and the site, never a password', () => {
  const p = validatePlan(change);
  assert.deepEqual(p.account, { change: 'password', site: SITE });
  assert.equal(minTierOf(p), 3);
  assert.ok(isAccount(p));
  const create = validatePlan({ ...base, account: { change: 'create', site: SITE }, steps: [{ do: 'navigate', url: `http://${SITE}/signup` }, { do: 'create_account', username: '#email', name: 'person@example.test', password: '#pw', confirm: '#pw2', submit: '#create', done_when: '#welcome' }] });
  assert.equal(minTierOf(create), 3);
  const mfa = validatePlan({ ...base, account: { change: 'mfa', site: SITE }, steps: [{ do: 'navigate', url: `http://${SITE}/security` }, { do: 'click', selector: '#enable-2fa' }, { do: 'code', why: 'Type the code from your authenticator app.', done_when: '#mfa-on' }] });
  assert.equal(minTierOf(mfa), 3);
  // Values are refused, wherever a plan might put one.
  refused({ ...change, steps: [change.steps[0], { ...change.steps[1], value: 'hunter2-example' }] }, /never a value/);
  refused({ ...change, steps: [change.steps[0], { ...change.steps[1], new_password: 'x' }] }, /never a value/);
  refused({ ...base, steps: [{ do: 'fill', selector: '#password', value: 'example-pw' }] }, /password or code field/);
  refused({ ...base, steps: [{ do: 'fill', selector: '#otp', value: '123456' }] }, /password or code field/);
  refused({ ...base, steps: [{ do: 'fill', target: { role: 'textbox', name: 'Verification code' }, value: '123456' }] }, /password or code field/);
  refused({ ...base, steps: [{ do: 'fill', selector: '#f', label: 'the new passphrase', value: 'x' }] }, /password or code field/);
  // Ordinary fields still fill.
  validatePlan({ ...base, steps: [{ do: 'fill', selector: '#footprint', value: 'x' }, { do: 'fill', selector: '#passenger-name', value: 'Example Person' }] });
  // An account step needs its declaration, and the declaration its step; MFA needs a code step; a code
  // step belongs to an account change; one change per plan; never learnt.
  refused({ ...base, steps: change.steps }, /must declare account: \{change: "password", site\}/);
  refused({ ...change, account: { change: 'create', site: SITE } }, /must declare account: \{change: "password"|needs its create_account step/);
  refused({ ...base, account: { change: 'mfa', site: SITE }, steps: [{ do: 'navigate', url: `http://${SITE}/security` }] }, /An MFA change needs a code step/);
  refused({ ...base, steps: [{ do: 'navigate', url: `http://${SITE}/x` }, { do: 'code', why: 'A code.', done_when: '#ok' }] }, /A code step belongs to an account change/);
  refused({ ...change, steps: [...change.steps, change.steps[1]] }, /change an account once/);
  refused({ ...change, learn: 'password-change' }, /isn’t learnt as a site template/);
  refused({ ...change, account: { change: 'password', site: 'elsewhere.example:5000' } }, /must be one of the allowed hosts/);
  refused({ ...base, account: { change: 'create', site: SITE }, steps: [{ do: 'create_account', username: '#u', name: 'two words', password: '#p', submit: '#s', done_when: '#d' }] }, /name is the account’s name/);
});

test('M10d accounts: the password Nova makes is long, mixed and new each time', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const p = generatePassword();
    assert.equal(p.length, 24);
    assert.match(p, /[a-z]/);
    assert.match(p, /[A-Z]/);
    assert.match(p, /[2-9]/);
    assert.match(p, /[-_.!@#%+=]/);
    assert.ok(!seen.has(p));
    seen.add(p);
  }
});

test('M10d gate: an account step asks at tier 3 with the person present; a confirmation left waiting stops before any browser and asks again', { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-accounts-'));
  const clock = { t: Date.parse('2026-10-31T10:00:00.000Z') };
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, now: () => new Date(clock.t) });
  try {
    core.browser.saveLogin(SITE, { username: 'example-user', password: 'example-pw-0123456789' });
    const t = core.browser.account({ change: 'password', site: SITE, steps: change.steps, verify: change.verify });
    assert.equal(t.approval_tier, 3);
    assert.equal(t.state, 'waiting');
    assert.match(String(t.reason), /Needs your OK/);
    assert.ok(!JSON.stringify(t).includes('example-pw-0123456789'), 'the task holds no password');
    assert.throws(() => core.ledger.approve(t.id), /explicit confirmation/);
    // Confirmed, but the run starts eleven minutes later: the person may not be there.
    core.ledger.approve(t.id, { confirm: true });
    clock.t += ACCOUNT_PRESENT_MS + 60_000;
    await core.ledger.idle();
    const blocked = core.ledger.get(t.id);
    assert.equal(blocked.state, 'waiting');
    assert.match(String(blocked.reason), /Nova changes an account only while you’re here, within 10 minutes of your OK/);
    assert.ok(!core.ledger.events(t.id).some((e) => e.kind === 'commit_point'), 'nothing was sent');
    // Retrying asks again: the old confirmation doesn't carry over.
    const again = core.ledger.retry(t.id);
    assert.equal(again.approved_at, null);
    assert.match(String(again.reason), /Needs your OK/);
    // The pending password: tier 3, and only when there is one.
    assert.throws(() => core.browser.settlePending(SITE, { keep: true }), /tier 3/);
    assert.throws(() => core.browser.settlePending(SITE, { keep: true, confirm: true }), /no new password waiting/);
    core.vault.put(loginName(SITE, 'pending'), 'example-new-pw-abcdef');
    assert.deepEqual(core.browser.settlePending(SITE, { keep: true, confirm: true }), { site: SITE, kept: true });
    assert.equal(core.vault.get(loginName(SITE, 'password')), 'example-new-pw-abcdef');
    assert.equal(core.vault.get(loginName(SITE, 'pending')), null);
    // A plan with a password in it never becomes a task.
    assert.throws(() => core.browser.account({ change: 'password', site: SITE, steps: [change.steps[0], { ...change.steps[1], value: 'x' }], verify: change.verify }), /can’t run/);
  } finally { await core.close(); }
});
