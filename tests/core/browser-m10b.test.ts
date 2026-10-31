// M10b without a browser: the co-pilot's ground truth (money, totals, pay controls, upsells,
// obstacles, intent), how ground truth and a Noul probability are combined, the plan validator's
// new steps (login, checkout, a11y targets) and its refusal of the pay control, the redactor, and
// the sign-in names in the vault. What needs Chromium is in tests/ui/m10b-*.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STEP_TEMPLATE, checkTotals, intentMatches, isPayControl, judge, obstacles, parseMoney, upsells,
} from '../../src/core/browser/copilot.ts';
import { minTierOf, validatePlan } from '../../src/core/browser/plan.ts';
import { Redactor, loginName, loginHost } from '../../src/core/browser/logins.ts';
import { validateTemplate } from '../../src/core/decide.ts';

// ---- money and totals ---------------------------------------------------------------------------

test('money: the amounts a page writes, to the cent', () => {
  assert.deepEqual(parseMoney('$12.50'), { cents: 1250, currency: '$' });
  assert.deepEqual(parseMoney('Total: $1,234.05'), { cents: 123405, currency: '$' });
  assert.deepEqual(parseMoney('12,50 €'), { cents: 1250, currency: '€' });
  assert.deepEqual(parseMoney('1.234,56 €'), { cents: 123456, currency: '€' });
  assert.deepEqual(parseMoney('USD 7'), { cents: 700, currency: 'USD' });
  // The last amount on a line is its price (a quantity or a size before it isn't).
  assert.deepEqual(parseMoney('2 × Example mug (350 ml)   $9.00'), { cents: 900, currency: '$' });
  assert.equal(parseMoney('no price here'), null);
  assert.equal(parseMoney(''), null);
});

test('totals: lines that add up to the total and the quote pass; anything else is a stop with the numbers', () => {
  const ok = checkTotals({ lines: ['Example mug $9.00', 'Example tea $3.50'], total: 'Total $12.50', quoted: '12.50' });
  assert.equal(ok.ok, true, ok.problems.join(' '));
  assert.equal(ok.total, 1250);
  const hidden = checkTotals({ lines: ['Example mug $9.00', 'Example tea $3.50'], total: 'Total $14.49', quoted: null });
  assert.equal(hidden.ok, false);
  assert.match(hidden.problems.join(' '), /\$14\.49.*\$12\.50/);
  const quote = checkTotals({ lines: ['Example mug $9.00'], total: '$9.00', quoted: '8.00' });
  assert.equal(quote.ok, false);
  assert.match(quote.problems.join(' '), /quoted/);
  const unread = checkTotals({ lines: ['Example mug'], total: 'soon', quoted: null });
  assert.equal(unread.ok, false, 'a total Nova can’t read is never taken as matching');
  const none = checkTotals({ lines: [], total: '$9.00', quoted: null });
  assert.equal(none.ok, false, 'no lines: nothing itemised to show');
  const mixed = checkTotals({ lines: ['Example mug $9.00'], total: '9,00 €', quoted: null });
  assert.equal(mixed.ok, false, 'two currencies never add up');
});

// ---- the pay control ------------------------------------------------------------------------------

test('pay controls: by name, by id or class, by where the form goes, by card fields in the form', () => {
  const b = (o: Record<string, unknown>) => ({ tag: 'button', name: '', ...o });
  for (const name of ['Pay $12.50', 'Pay now', 'Place order', 'Place your order', 'Buy now', 'Complete purchase', 'Confirm and pay', 'Submit order', 'Order now']) {
    assert.ok(isPayControl(b({ name })), name);
  }
  assert.ok(isPayControl(b({ name: 'Continue', id: 'pay-button' })), 'its id');
  assert.ok(isPayControl(b({ name: 'Continue', formAction: 'http://127.0.0.1:5000/pay' })), 'its form pays');
  assert.ok(isPayControl(b({ name: 'Continue', formHasCard: true })), 'card fields in its form');
  for (const name of ['Add to cart', 'Proceed to checkout', 'View cart', 'Sign in', 'Remove', 'Update cart']) {
    assert.equal(isPayControl(b({ name, formAction: 'http://127.0.0.1:5000/cart/add' })), null, name);
  }
});

test('the plan validator refuses the pay control, a pay address and card fields, whatever the plan or a template says', () => {
  const base = { allowed_hosts: ['127.0.0.1:5000'] };
  const refused = (steps: unknown[], why: RegExp) => assert.throws(() => validatePlan({ ...base, steps }), (e: any) => why.test(e.details.join(' ')), JSON.stringify(steps));
  const checkout = { do: 'checkout', lines: '.line', total: '#total', pay: '#complete' };
  refused([{ do: 'navigate', url: 'http://127.0.0.1:5000/checkout' }, checkout, { do: 'click', selector: '#complete' }], /pay control|after the checkout/);
  refused([{ do: 'navigate', url: 'http://127.0.0.1:5000/checkout' }, { do: 'click', selector: '#complete' }, checkout], /pay control/);
  refused([{ do: 'click', selector: '#pay' }], /pay/);
  refused([{ do: 'click', selector: 'button.place-order' }], /pay/);
  refused([{ do: 'click', target: { role: 'button', name: 'Pay now' } }], /pay/);
  refused([{ do: 'click', selector: '#go', label: 'Place the order' }], /pay/);
  refused([{ do: 'click', selector: '#go', intent: 'buy now' }], /pay/);
  refused([{ do: 'navigate', url: 'http://127.0.0.1:5000/pay?confirm=1' }], /pay/);
  refused([{ do: 'navigate', url: 'http://127.0.0.1:5000/checkout/complete' }], /pay/);
  refused([{ do: 'fill', selector: '#card-number', value: 'x' }], /card/);
  refused([{ do: 'fill', selector: '#note', value: '4111 1111 1111 1111' }], /card/);
  // Only a read or a wait after the checkout step: it is where Nova stops.
  refused([{ do: 'navigate', url: 'http://127.0.0.1:5000/checkout' }, checkout, { do: 'fill', selector: '#note', value: 'x' }], /after the checkout/);
  // Two checkouts, or a checkout with no pay control named, can't be checked.
  refused([checkout, checkout], /one checkout/);
  refused([{ do: 'checkout', lines: '.line', total: '#total' }], /pay/);
  const ok = validatePlan({ ...base, steps: [{ do: 'navigate', url: 'http://127.0.0.1:5000/checkout' }, checkout, { do: 'read', selector: '#total' }] });
  assert.equal(ok.steps.length, 3);
});

test('tiers: a checkout plan is tier 3, always; a plan that types or clicks is tier 2; a read is 0', () => {
  const h = ['127.0.0.1:5000'];
  assert.equal(minTierOf(validatePlan({ allowed_hosts: h, steps: [{ do: 'navigate', url: 'http://127.0.0.1:5000/checkout' }, { do: 'checkout', lines: '.line', total: '#total', pay: '#complete' }] })), 3);
  assert.equal(minTierOf(validatePlan({ allowed_hosts: h, steps: [{ do: 'navigate', url: 'http://127.0.0.1:5000/' }, { do: 'click', selector: '#add' }] })), 2);
  assert.equal(minTierOf(validatePlan({ allowed_hosts: h, steps: [{ do: 'navigate', url: 'http://127.0.0.1:5000/login' }, { do: 'login', username: '#u', password: '#p', submit: '#go' }] })), 2);
  assert.equal(minTierOf(validatePlan({ allowed_hosts: h, steps: [{ do: 'navigate', url: 'http://127.0.0.1:5000/' }, { do: 'read', selector: 'h1' }] })), 0);
});

test('login steps name fields, never values; a11y targets name a role and a name', () => {
  const h = ['127.0.0.1:5000'];
  const p = validatePlan({ allowed_hosts: h, steps: [{ do: 'navigate', url: 'http://127.0.0.1:5000/login' }, { do: 'login', username: '#u', password: '#p', submit: '#go', done_when: '#account' }] });
  assert.equal(p.steps[1]!.do, 'login');
  assert.throws(() => validatePlan({ allowed_hosts: h, steps: [{ do: 'login', username: '#u', password: '#p', submit: '#go', value: 'hunter2' }] }), (e: any) => /never a value|password/.test(e.details.join(' ')));
  assert.throws(() => validatePlan({ allowed_hosts: h, steps: [{ do: 'login', username: '#u', submit: '#go' }] }), (e: any) => /password/.test(e.details.join(' ')));
  const a = validatePlan({ allowed_hosts: h, steps: [{ do: 'click', target: { role: 'button', name: 'Add to cart' } }] });
  assert.deepEqual((a.steps[0] as any).target, { role: 'button', name: 'Add to cart' });
  assert.throws(() => validatePlan({ allowed_hosts: h, steps: [{ do: 'click' }] }), (e: any) => /selector or a target/.test(e.details.join(' ')));
  assert.throws(() => validatePlan({ allowed_hosts: h, steps: [{ do: 'click', target: { role: 'button' } }] }), (e: any) => /target/.test(e.details.join(' ')));
  assert.throws(() => validatePlan({ allowed_hosts: h, profile: 'yours', steps: [{ do: 'read', selector: 'h1' }] }), (e: any) => /profile/.test(e.details.join(' ')));
  assert.throws(() => validatePlan({ allowed_hosts: h, learn: 'Has Spaces', steps: [{ do: 'read', selector: 'h1' }] }), (e: any) => /learn/.test(e.details.join(' ')));
});

// ---- upsells, obstacles, intent -------------------------------------------------------------------

test('upsells: a box ticked for you that adds money or names an extra; one the plan ticked is not', () => {
  const found = upsells([
    { label: 'Add a protection plan (+$4.99)', touched: false },
    { label: 'Gift wrap', touched: true },
    { label: 'Standard delivery', touched: false, radio: true },
    { label: 'Yes, sign me up for offers', touched: false },
  ]);
  assert.deepEqual(found.map((f) => f.label), ['Add a protection plan (+$4.99)', 'Yes, sign me up for offers']);
  assert.equal(found[0]!.cents, 499);
});

test('obstacles: a CAPTCHA, a login wall with no sign-in step, a paywall', () => {
  assert.equal(obstacles({ captcha: true, password_fields: 0, paywall: false }, { loginNext: false }).kind, 'captcha');
  assert.equal(obstacles({ captcha: false, password_fields: 1, paywall: false }, { loginNext: false }).kind, 'login');
  assert.equal(obstacles({ captcha: false, password_fields: 1, paywall: false }, { loginNext: true }).kind, null, 'the plan signs in next');
  assert.equal(obstacles({ captcha: false, password_fields: 0, paywall: true }, { loginNext: false }).kind, 'paywall');
  assert.equal(obstacles({ captcha: false, password_fields: 0, paywall: false }, { loginNext: false }).kind, null);
});

test('intent: words of the intent against the element’s accessible name', () => {
  assert.equal(intentMatches('add the mug to the cart', 'Add to cart'), true);
  assert.equal(intentMatches('add the mug to the cart', 'Remove'), false);
  assert.equal(intentMatches('sign in', 'Sign in'), true);
});

// ---- ground truth and the co-pilot ----------------------------------------------------------------

test('the co-pilot template: six Noul questions, valid against the decision-template contract', () => {
  const t = validateTemplate(STEP_TEMPLATE);
  assert.deepEqual(t.questions.map((q) => [q.id, q.type]), [
    ['element_matches_intent', 'noul'], ['page_changed_as_expected', 'noul'], ['obstacle', 'noul'],
    ['dark_pattern', 'noul'], ['total_matches', 'noul'], ['dialog_injection', 'noul'],
  ]);
});

test('ground truth outranks a probability; a sure model against it stops the step', () => {
  assert.deepEqual(judge(true, null), { answer: true, by: 'ground truth', disagree: false });
  assert.deepEqual(judge(false, 0.6), { answer: false, by: 'ground truth', disagree: false }, 'an unsure model changes nothing');
  assert.deepEqual(judge(false, 0.95), { answer: false, by: 'ground truth', disagree: true });
  assert.deepEqual(judge(true, 0.1), { answer: true, by: 'ground truth', disagree: true });
  assert.deepEqual(judge(null, 0.9), { answer: true, by: 'co-pilot', disagree: false });
  assert.deepEqual(judge(null, 0.1), { answer: false, by: 'co-pilot', disagree: false });
  assert.deepEqual(judge(null, 0.5), { answer: null, by: 'co-pilot', disagree: false });
  assert.deepEqual(judge(null, null), { answer: null, by: 'none', disagree: false });
});

// ---- secrets ----------------------------------------------------------------------------------------

test('the redactor masks every value a session used, wherever it appears, and nothing shorter than 3', () => {
  const r = new Redactor();
  r.add('pw-Example-7f3a9c');
  r.add('ab');
  assert.equal(r.text('typed pw-Example-7f3a9c and pw-Example-7f3a9c'), 'typed [redacted] and [redacted]');
  assert.equal(r.text('ab stays'), 'ab stays');
  assert.deepEqual(r.value({ a: ['x pw-Example-7f3a9c'], b: 2 }), { a: ['x [redacted]'], b: 2 });
  assert.equal(r.has('…pw-Example-7f3a9c…'), true);
});

test('sign-ins live in the vault under the host they were saved for', () => {
  assert.equal(loginName('127.0.0.1:5000', 'password'), 'browser/login/127.0.0.1_5000/password');
  assert.equal(loginName('shop.example.test', 'username'), 'browser/login/shop.example.test/username');
  assert.equal(loginHost('browser/login/127.0.0.1_5000/password'), '127.0.0.1:5000');
  assert.throws(() => loginName('not a host', 'password'));
});
