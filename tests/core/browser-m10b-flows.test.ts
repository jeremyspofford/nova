// Site templates (M10b) without a browser, in a real core: a learnt flow goes through the
// decision-template path (propose, dry runs, activation as a ledger task Nova verifies by re-running
// the dry runs itself), a plan that names the flow gets its steps from the active version, the rule
// stops a step whose ground truth no longer matches, and a template whose steps press pay is
// refused by the plan validator, whatever it says. Sign-ins: saved by host, never returned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../../src/core/index.ts';
import { FLOW_RULE, dryRuns, flowDef, flowTemplateId, stepsOf, type Learnt } from '../../src/core/browser/flows.ts';
import { until } from './connector-support.ts';

const SITE = '127.0.0.1:4555';
const learnt = (pay = false): Learnt => ({
  host: SITE, name: 'order',
  steps: [
    { step: { do: 'navigate', url: `http://${SITE}/shop` }, path: '/shop', marker: '#add-mug' },
    { step: { do: 'click', selector: '#add-mug' }, path: '/cart', marker: pay ? '#pay' : '' },
    ...(pay ? [{ step: { do: 'click' as const, selector: '#pay' }, path: '/paid', marker: '' }] : []),
  ],
});

function core() {
  return createCore({ home: mkdtempSync(join(tmpdir(), 'nova-flows-')), version: '0.1.0', trustedOrigin: () => true, vault: { mode: 'file' } });
}

test('a learnt flow is a decision template: dry runs both ways, activated through the ledger, then its steps run', async () => {
  const c = core();
  try {
    const id = flowTemplateId(SITE, 'order');
    assert.equal(id, 'browser-site.127.0.0.1-4555.order');
    c.templates.propose(flowDef(SITE, 'order', 1), 'test');
    const cases = dryRuns(learnt());
    assert.equal(cases.filter((x) => x.expect?.next === 'continue').length, 2, 'one case per step');
    assert.ok(cases.filter((x) => x.expect?.next === 'stop').length >= 2, 'negative controls');
    const dry = c.templates.dryRun(id, 1, cases);
    assert.equal(dry.ok, true, JSON.stringify(dry.results.map((r) => r.why)));
    const task = c.templates.activate(id, 1);
    await until(() => c.templates.version(id, 1)!.state, (s) => s === 'active');
    assert.equal(c.ledger.get(task.id).state, 'done', 'the activation task was verified');
    assert.match(c.ledger.get(task.id).verification!.checks[0]!.why, /re-ran .* dry runs .* itself/);
    // The steps come back out, in order.
    assert.deepEqual(stepsOf(c.templates.version(id, 1)!).map((x) => x.step.do), ['navigate', 'click']);
    // A plan that names the flow runs those steps, at the tier they need.
    const t = c.ledger.create({
      title: 'Order again', owner: 'browser', goal: 'The cart has the mug.', origin: { kind: 'user' }, evidence_required: [{ kind: 'screenshot' }, { kind: 'url' }],
      inputs: { allowed_hosts: [SITE], flow: { name: 'order', site: SITE, version: 1 }, verify: { url: `http://${SITE}/cart`, expect: ['mug'] } },
    });
    assert.equal(t.approval_tier, 2, 'it clicks, so it asks first');
    assert.equal(c.ledger.get(t.id).state, 'waiting');
    c.ledger.cancel(t.id);
    // A version that isn't active, or doesn't exist, is refused.
    assert.throws(() => c.ledger.create({
      title: 'Order', owner: 'browser', goal: 'x', origin: { kind: 'user' }, evidence_required: [{ kind: 'screenshot' }],
      inputs: { allowed_hosts: [SITE], flow: { name: 'order', site: SITE, version: 2 } },
    }), (e: any) => /no active version 2/.test(e.details.join(' ')));
    // GET /browser/flows lists it, with its shape only.
    assert.deepEqual(c.browser.flows().map((f) => [f.template_id, f.version, f.state, f.steps]), [[id, 1, 'active', 2]]);
  } finally {
    await c.close();
  }
});

test('the template’s rule is the ground truth: a wrong path, a missing marker or an obstacle stops the step', () => {
  const base = { step: 1, action: '{}', expect_path: '/cart', seen_path: '/cart', expect_marker: '#checkout', marker_seen: true, obstacle: false };
  assert.equal(FLOW_RULE(base).answers.next, 'continue');
  assert.equal(FLOW_RULE({ ...base, seen_path: '/login' }).answers.next, 'stop');
  assert.equal(FLOW_RULE({ ...base, marker_seen: false }).answers.next, 'stop');
  assert.equal(FLOW_RULE({ ...base, obstacle: true }).answers.next, 'stop');
  assert.match(FLOW_RULE({ ...base, seen_path: '/login' }).why, /\/login, not \/cart/);
});

test('whatever a template says, a step that presses pay is refused when its flow is run', async () => {
  const c = core();
  try {
    const id = flowTemplateId(SITE, 'order');
    // A template whose steps press pay passes its own dry runs: they check the rule, not the steps.
    c.templates.propose(flowDef(SITE, 'order', 1), 'test');
    assert.equal(c.templates.dryRun(id, 1, dryRuns(learnt(true))).ok, true);
    c.templates.activate(id, 1);
    await until(() => c.templates.version(id, 1)!.state, (s) => s === 'active');
    // Running it is refused by the plan validator, before anything opens.
    assert.throws(() => c.ledger.create({
      title: 'Order and pay', owner: 'browser', goal: 'x', origin: { kind: 'user' }, evidence_required: [{ kind: 'screenshot' }, { kind: 'url' }],
      inputs: { allowed_hosts: [SITE], flow: { name: 'order', site: SITE, version: 1 }, verify: { url: `http://${SITE}/cart`, expect: ['mug'] } },
    }), (e: any) => /pay or place an order/.test(e.details.join(' ')));
  } finally {
    await c.close();
  }
});

test('sign-ins: saved by host in the vault, listed without values, deleted only with confirm', async () => {
  const c = core();
  try {
    const user = `user-${Math.random().toString(36).slice(2, 10)}`;
    const pass = `pw-${Math.random().toString(36).slice(2, 14)}`;
    assert.deepEqual(c.browser.saveLogin(SITE, { username: user, password: pass }), { site: SITE, saved: true });
    assert.equal(c.vault.get(`browser/login/127.0.0.1_4555/password`), pass);
    const sites = c.browser.sites();
    assert.deepEqual(sites.map((s) => [s.site, s.login]), [[SITE, true]]);
    assert.ok(!JSON.stringify(sites).includes(pass) && !JSON.stringify(sites).includes(user), 'never a value');
    assert.throws(() => c.browser.deleteLogin(SITE, false), /tier 3/);
    assert.throws(() => c.browser.saveLogin('not a host', { username: 'a', password: 'b' }), /isn’t a site/);
    assert.deepEqual(c.browser.deleteLogin(SITE, true), { site: SITE, deleted: true });
    assert.equal(c.vault.get(`browser/login/127.0.0.1_4555/password`), null);
  } finally {
    await c.close();
  }
});
