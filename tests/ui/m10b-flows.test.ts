// M10b gate 6 and 7: a site template is learnt from a flow that succeeded and reused, a changed
// site stops it; and the person stays in control mid-flow (pause, resume, take over, hand back,
// stop). Runs where Chromium can start (scripts/ui-test.sh; CI's UI gate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canBrowse, shopPlan, sleep, startNova, startShop, until } from './m10b-support.ts';

test('M10b gate 6: a template is learnt from a verified flow, activated through the ledger, reused with each step re-checked; a changed site stops it', { timeout: 300_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const shop = await startShop();
  const n = await startNova('nova-m10b-flows-');
  try {
    const { m, api } = n;
    // 1. The flow, by hand, with learn.
    const first = await n.task(shopPlan(shop, { learn: 'order', items: ['mug'], quoted: '9.00' }), 'Fill the cart on the example shop');
    const one = await n.done(first.id!);
    assert.equal(one.state, 'done', `${one.reason}`);
    const learnt = await until(() => n.events(first.id!), (e) => e.some((x) => x.kind === 'flow_learnt'));
    const l = learnt.find((x) => x.kind === 'flow_learnt')!.detail;
    const tid = `browser-site.${shop.host.replace(':', '-')}.order`;
    assert.deepEqual([l.template_id, l.version, l.steps], [tid, 1, 5]);
    // Activated only once the ledger verified its dry runs.
    const act = await n.done(l.activation_task);
    assert.equal(act.state, 'done');
    assert.match(act.verification!.checks[0]!.why, /re-ran \d+ dry runs .* itself; all passed/);
    const flows = await until(() => m.get(api('/browser/flows')), (f) => f.flows.some((x: { state: string }) => x.state === 'active'));
    assert.deepEqual(flows.flows.map((f: any) => [f.template_id, f.version, f.state, f.steps]), [[tid, 1, 'active', 5]]);

    // 2. Reused: the plan names the flow; each step is checked against what was learnt.
    const flowPlan = { allowed_hosts: [shop.host], flow: { name: 'order', site: shop.host, version: 1 }, verify: { url: `${shop.url}/cart`, expect: ['Example mug'] } };
    const again = await n.task(flowPlan, 'Fill the cart again');
    assert.equal(again.created.body.approval_tier, 3, 'its checkout is still tier 3');
    const two = await n.done(again.id!);
    assert.equal(two.state, 'done', `${two.reason}`);
    const checked = (await n.events(again.id!)).filter((e) => e.kind === 'flow_checked');
    assert.equal(checked.length, 5, 'every step re-checked');
    assert.match(two.report.summary, /Followed the flow “order” v1, checking each step/);
    assert.equal((await m.get(api('/browser/flows'))).flows[0].uses, 1);

    // 3. The site changed (its checkout button has a new id): the re-check stops the run there.
    shop.set({ renamed: true });
    const third = await n.task(flowPlan, 'Fill the cart once more');
    const three = await n.done(third.id!);
    assert.equal(three.state, 'failed');
    assert.match(three.reason ?? '', /no longer matches the flow “order” v1 .*#to-checkout isn’t on the page/);
    assert.ok((await n.events(third.id!)).some((e) => e.kind === 'flow_stopped'));
    assert.equal(shop.hits('/checkout').length, 2, 'the third run never reached the checkout');
    assert.equal(shop.paid(), 0);
    console.log(`  · Template ${tid} v1 learnt from a verified flow (5 steps), activated by a verified ledger task, reused with 5 re-checks; a renamed button stopped the third run.`);
  } finally {
    await n.close();
    await shop.close();
  }
});

test('M10b gate 7: the person stays in control mid-flow: pause, resume, take over, hand back; stop', { timeout: 240_000 }, async (t) => {
  const why = await canBrowse();
  if (why) return t.skip(why);
  const shop = await startShop({ laterMs: 2500 });
  const n = await startNova('nova-m10b-control-');
  try {
    const { m, api } = n;
    const plan = {
      allowed_hosts: [shop.host],
      steps: [
        { do: 'navigate', url: `${shop.url}/cart/empty` },
        { do: 'navigate', url: `${shop.url}/later` },
        { do: 'wait', selector: '#later', timeout_ms: 20_000 },
        { do: 'navigate', url: `${shop.url}/shop` },
        { do: 'click', selector: '#add-mug' },
        { do: 'read', selector: '#cart', expect: 'Example mug' },
      ],
      verify: { url: `${shop.url}/cart`, expect: ['Example mug'] },
    };
    const { id } = await n.task(plan, 'Wait, then put a mug in the cart');
    await until(() => m.get(api(`/browser/tasks/${id}`)), (v) => v.step?.n === 3);
    // Pause mid-step: once the page is ready, Nova still doesn't go on.
    const paused = await m.send('POST', api(`/browser/tasks/${id}/pause`));
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    assert.equal(paused.body.mode, 'paused');
    await sleep(4000);
    assert.equal(shop.hits('/shop').length, 0, 'paused: nothing more happened');
    assert.equal((await m.send('POST', api(`/browser/tasks/${id}/resume`))).status, 200);
    // Take over as soon as it reaches the shop, before it clicks.
    await until(() => m.get(api(`/browser/tasks/${id}`)), (v) => v.step?.n >= 4, 30_000);
    const took = await m.send('POST', api(`/browser/tasks/${id}/takeover`));
    assert.equal(took.status, 200, JSON.stringify(took.body));
    const held = shop.log.length;
    await sleep(2000);
    assert.equal(shop.log.length, held, 'while the person holds it, Nova sends nothing');
    assert.equal(shop.cart().length, 0, 'and clicks nothing');
    assert.equal((await m.send('POST', api(`/browser/tasks/${id}/handback`))).status, 200);
    const done = await n.done(id!);
    assert.equal(done.state, 'done', `${done.reason}`);
    assert.deepEqual(shop.cart(), ['mug']);
    const kinds = (await n.events(id!)).map((e) => e.kind);
    for (const k of ['paused', 'resumed', 'takeover_started', 'takeover_ended']) assert.ok(kinds.includes(k), `${k} in ${kinds}`);

    // Stop: the task is cancelled, and its browser closes.
    const slow = await n.task({ ...plan, steps: plan.steps.slice(0, 3) }, 'Wait for the page');
    await until(() => m.get(api(`/browser/tasks/${slow.id}`)), (v) => v.step?.n === 3);
    assert.equal((await m.send('POST', api(`/browser/tasks/${slow.id}/stop`))).status, 200);
    const stopped = await n.done(slow.id!, 20_000);
    assert.equal(stopped.state, 'cancelled');
    assert.match(stopped.reason ?? '', /Stopped by The hub’s own screen/);
    await until(() => m.get(api(`/browser/tasks/${slow.id}`)), (v) => v.live === false, 10_000);
  } finally {
    await n.close();
    await shop.close();
  }
});
