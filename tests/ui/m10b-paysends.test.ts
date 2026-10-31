// Review of PR #238, must-fix 2: the pay guard is structural, not a word list. While Nova drives,
// nothing that isn't a GET leaves unless the step acting says it sends there; on a checkout flow
// only what a step declares; after the itemised-total stop, nothing; and GETs to pay addresses are
// refused too. Seven hostile stand-in pages try to pay without saying so: a tokenised payment
// fetch()ed to /charge from "Continue", "Complete" posting to /api/orders, "Pagar ahora" posting to
// /procesar, GETs to pay addresses from script, a sendBeacon, a form that sends itself on load, and a
// link dressed as a button. Each runs on a checkout flow and on a plain plan; the stand-in shop's
// server log shows none of them reached it. Runs where Chromium can start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canBrowse, startNova, startShop } from './m10b-support.ts';

const VARIANTS = ['continue-charge', 'complete-orders', 'pagar', 'get-pay', 'beacon', 'autosubmit', 'link-button'];
// What each would have reached.
const TARGETS = ['/charge', '/x/commit', '/api/orders', '/procesar', '/payments/execute', '/collect-order', '/api/commit', '/pay'];

test('review 2: no hostile page pays or sends an order, on a checkout flow or a plain plan; the shop’s log shows none of it', { timeout: 600_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const shop = await startShop();
  const n = await startNova('nova-m10b-paysends-');
  try {
    const lines: string[] = [];
    for (const v of VARIANTS) {
      for (const flow of ['checkout', 'plain'] as const) {
        const acts = v === 'autosubmit' ? [{ do: 'wait', selector: '#act' }] : [{ do: 'click', selector: '#act' }];
        const steps = flow === 'checkout'
          ? [
            { do: 'navigate', url: `${shop.url}/cart/empty` }, { do: 'navigate', url: `${shop.url}/shop` },
            { do: 'click', selector: '#add-mug', sends: '/cart/add' },
            { do: 'navigate', url: `${shop.url}/evil/${v}` }, ...acts,
            { do: 'navigate', url: `${shop.url}/cart` }, { do: 'click', selector: '#to-checkout' },
            { do: 'checkout', lines: '#lines .line', total: '#total', pay: '#pay', quoted: '9.00' },
          ]
          : [{ do: 'navigate', url: `${shop.url}/evil/${v}` }, ...acts, { do: 'navigate', url: `${shop.url}/cart` }];
        const { id, created } = await n.task({ allowed_hosts: [shop.host], steps, verify: { url: `${shop.url}/cart`, expect: ['cart'] } }, `Review the order (${v}, ${flow})`);
        assert.ok(id, JSON.stringify(created.body));
        const done = await n.done(id!);
        const ev = await n.events(id!);
        const refused = ev.filter((e) => e.kind === 'pay_refused' || e.kind === 'send_refused');
        assert.ok(refused.length >= 1 || /pay control/.test(done.reason ?? ''), `${v} (${flow}): refused, and said so: ${done.state} ${done.reason} ${JSON.stringify(ev.map((e) => e.kind))}`);
        const reached = shop.log.filter((l) => TARGETS.includes(l.path));
        assert.deepEqual(reached, [], `${v} (${flow}): the shop’s log shows none of it`);
        lines.push(`${v}/${flow}: ${done.state}${done.state === 'failed' ? ` (${(done.reason ?? '').slice(0, 60)}…)` : ''}; refused: ${refused.map((e) => `${e.detail.method} ${e.kind}`).join(', ') || 'at the click'}`);
      }
    }
    assert.equal(shop.paid(), 0);
    console.log(`  · ${lines.join('\n  · ')}`);
  } finally {
    await n.close();
    await shop.close();
  }
});

test('review 2: after the itemised-total stop nothing that isn’t a GET leaves the page, whatever its script does', { timeout: 180_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const shop = await startShop();
  const n = await startNova('nova-m10b-locked-');
  try {
    // The checkout page's script posts the pay form a moment after load, after Nova has read it.
    shop.set({ checkoutScript: "setTimeout(() => { fetch('/api/commit', { method: 'POST', body: 'x' }).catch(() => {}); navigator.sendBeacon('/collect-order', 'x'); const i = document.createElement('i'); i.id = 'tried'; document.body.append(i); setTimeout(() => document.querySelector('form').submit(), 100); }, 600);" });
    const steps = [
      { do: 'navigate', url: `${shop.url}/cart/empty` }, { do: 'navigate', url: `${shop.url}/shop` },
      { do: 'click', selector: '#add-mug', sends: '/cart/add' }, { do: 'click', selector: '#to-checkout' },
      { do: 'checkout', lines: '#lines .line', total: '#total', pay: '#pay', quoted: '9.00' },
      { do: 'wait', selector: '#tried', timeout_ms: 5000 }, { do: 'read', selector: '#total' },
    ];
    const { id } = await n.task({ allowed_hosts: [shop.host], steps, verify: { url: `${shop.url}/cart`, expect: ['Example mug'] } }, 'Fill the cart');
    const done = await n.done(id!);
    assert.equal(done.state, 'done', `${done.reason}`);
    assert.deepEqual(shop.log.filter((l) => ['/api/commit', '/collect-order', '/pay'].includes(l.path)), []);
    const ev = await n.events(id!);
    assert.ok(ev.some((e) => e.kind === 'pay_refused' && e.detail.method === 'POST'), JSON.stringify(ev.map((e) => e.kind)));
  } finally {
    await n.close();
    await shop.close();
  }
});
