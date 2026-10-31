// M10b gate 3, 4, 5: checkout. Nova fills the cart on the stand-in shop, shows the itemised total
// and stops, at tier 3 (confirmed every time). The pay control is refused three ways, and the
// stand-in shop's own server log proves it was never used: by the plan validator, at run time by
// the element it would click, and in the browser for what a page's script would send. A total
// that doesn't match its lines stops the run; a box ticked for the person is flagged, and theirs to
// untick. Runs where Chromium can start (scripts/ui-test.sh; CI's UI gate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canBrowse, shopPlan, sleep, startNova, startShop, until } from './m10b-support.ts';

test('M10b gate 5: checkout stops at the itemised total with tier 3; the pay control is never used, by plan, by click or by script', { timeout: 300_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const shop = await startShop();
  const n = await startNova('nova-m10b-checkout-');
  try {
    const { m, api } = n;
    // Tier 3: an OK without confirm is refused, every time.
    const r = await m.send('POST', api('/tasks'), { title: 'Fill the cart on the example shop', owner: 'browser', goal: 'The cart is filled and the total shown.', evidence_required: [{ kind: 'screenshot' }, { kind: 'url' }], inputs: shopPlan(shop, { quoted: '12.50' }) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.approval_tier, 3, 'checkout is tier 3, always');
    assert.equal(r.body.state, 'waiting');
    const plain = await m.send('POST', api(`/tasks/${r.body.id}/approve`), {});
    assert.equal(plain.status, 400, 'a tier-3 OK needs confirm');
    assert.equal((await m.send('POST', api(`/tasks/${r.body.id}/approve`), { confirm: true })).status, 200);
    const done = await n.done(r.body.id);
    assert.equal(done.state, 'done', `${done.reason}`);
    assert.match(done.report.summary, /Stopped at the checkout: 2 lines, total \$12\.50, as quoted\. Paying is yours/);
    const checkout = JSON.parse(readFileSync(join(m.home, 'workers', 'browser', r.body.id, 'checkout.json'), 'utf8'));
    assert.deepEqual([checkout.total, checkout.sum, checkout.quoted, checkout.ok, checkout.pay_pressed], [1250, 1250, 1250, true, false]);
    assert.deepEqual(checkout.lines.map((l: { cents: number }) => l.cents), [900, 350]);
    const ev = await n.events(r.body.id);
    assert.ok(ev.some((e) => e.kind === 'checkout_reached' && e.detail.total === '$12.50' && e.detail.pay_pressed === false));
    assert.equal(shop.paid(), 0, 'the shop’s log has no request to /pay');
    assert.ok(shop.hits('/checkout').length >= 1, 'it did reach the checkout');

    // 1. The plan validator: a plan or template that clicks pay never starts.
    for (const steps of [
      [{ do: 'navigate', url: `${shop.url}/checkout` }, { do: 'checkout', lines: '#lines .line', total: '#total', pay: '#pay' }, { do: 'click', selector: '#pay' }],
      [{ do: 'navigate', url: `${shop.url}/checkout` }, { do: 'click', selector: '#pay' }],
      [{ do: 'navigate', url: `${shop.url}/checkout` }, { do: 'click', target: { role: 'button', name: 'Pay $12.50' } }],
    ]) {
      const bad = await m.send('POST', api('/tasks'), { title: 'Pay', owner: 'browser', goal: 'x', evidence_required: [{ kind: 'screenshot' }, { kind: 'url' }], inputs: { allowed_hosts: [shop.host], steps, verify: { url: `${shop.url}/cart`, expect: ['x'] } } });
      assert.equal(bad.status, 400, JSON.stringify(bad.body));
      assert.match(bad.body.details.join(' '), /pay control|pay or place an order|after the checkout/);
    }

    // 2. At run time: a selector that doesn't look like pay, on the element that pays.
    const sneaky = await n.task({ allowed_hosts: [shop.host], steps: [{ do: 'navigate', url: `${shop.url}/checkout` }, { do: 'click', selector: 'main form button' }], verify: { url: `${shop.url}/cart`, expect: ['x'] } }, 'Press the button');
    const refused = await n.done(sneaky.id!);
    assert.equal(refused.state, 'failed');
    assert.match(refused.reason ?? '', /it is a pay control .*never presses pay/);
    assert.ok((await n.events(sneaky.id!)).some((e) => e.kind === 'pay_refused'));

    // 3. In the browser: "Continue" looks harmless, and its script submits the pay form.
    const trap = await n.task({ allowed_hosts: [shop.host], steps: [{ do: 'navigate', url: `${shop.url}/trap` }, { do: 'click', selector: '#continue' }, { do: 'read', selector: 'h1' }], verify: { url: `${shop.url}/trap`, expect: ['Review'] } }, 'Continue on the review page');
    const trapped = await n.done(trap.id!);
    const tev = await n.events(trap.id!);
    assert.ok(tev.some((e) => e.kind === 'pay_refused' && /refused in the browser/.test(e.detail.why)), JSON.stringify(tev.map((e) => e.kind)));
    assert.ok(['done', 'failed'].includes(trapped.state));
    await sleep(500);
    assert.equal(shop.paid(), 0, 'the shop’s log still has no request to /pay, from any of them');
    console.log(`  · Checkout: tier 3 (an OK without confirm refused), stopped at $12.50 for 2 lines; the pay control refused by the validator (3 plans), at the click (${refused.reason?.slice(0, 60)}…), and in the browser (the trap); /pay requests in the shop's log: ${shop.paid()}.`);
  } finally {
    await n.close();
    await shop.close();
  }
});

test('M10b gate 4: a total that doesn’t match its lines stops the run, before anything else happens', { timeout: 180_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  // A charge on the total that no line shows.
  const shop = await startShop({ fee: 199 });
  const n = await startNova('nova-m10b-total-');
  try {
    const { id } = await n.task(shopPlan(shop), 'Fill the cart on the example shop');
    const done = await n.done(id!);
    assert.equal(done.state, 'failed');
    assert.match(done.reason ?? '', /total on the page is \$14\.49, but its lines add up to \$12\.50.*Nothing was paid/);
    assert.ok((await n.events(id!)).some((e) => e.kind === 'total_mismatch' && e.detail.total === '$14.49'));
    assert.equal(shop.paid(), 0);
  } finally {
    await n.close();
    await shop.close();
  }
});

test('M10b gate 3: an extra ticked for the person is flagged, and theirs to untick; then the total matches', { timeout: 180_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const shop = await startShop({ upsell: true });
  const n = await startNova('nova-m10b-upsell-');
  try {
    const { m, api } = n;
    const { id } = await n.task(shopPlan(shop, { items: ['mug'], quoted: '9.00' }), 'Fill the cart on the example shop');
    // Flagged, and Nova waits for the person.
    const ev = await until(() => n.events(id!), (e) => e.some((x) => x.kind === 'upsell_flagged'));
    const flag = ev.find((x) => x.kind === 'upsell_flagged')!;
    assert.equal(flag.detail.adds, '$4.99');
    const view = await until(() => m.get(api(`/browser/tasks/${id}`)), (v) => v.mode === 'needs_person');
    assert.match(view.asked, /already ticked for you and adds \$4\.99/);
    // The person unticks it: takes over, clicks the box (the stand-in keeps it at 20–420 × 20–60 px
    // of the 1280 × 800 page), hands back.
    assert.equal((await m.send('POST', api(`/browser/tasks/${id}/takeover`))).status, 200);
    assert.equal((await m.send('POST', api(`/browser/tasks/${id}/input`), { type: 'click', x: 40 / 1280, y: 40 / 800 })).status, 200);
    await sleep(300);
    assert.equal((await m.send('POST', api(`/browser/tasks/${id}/handback`))).status, 200);
    const done = await n.done(id!);
    assert.equal(done.state, 'done', `${done.reason}`);
    const all = await n.events(id!);
    assert.ok(all.some((x) => x.kind === 'upsell_declined'), JSON.stringify(all.map((x) => x.kind)));
    assert.match(done.report.summary, /total \$9\.00, as quoted/);
    assert.equal(shop.paid(), 0);
  } finally {
    await n.close();
    await shop.close();
  }
});
