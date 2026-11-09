// One chat tool for every connected service (the owner's direction, 2026-11-09: "whatever service
// they ask nova to build will require to be managed the same way"). A second service, a stand-in
// thermostat, declares one action in its manifest and nothing else: service_call lists it, runs it as
// the thermostat's own task at its capability's tier, and the outside-content guard covers it through
// the approvals registry, with no tool code of its own. home_call, the Home Assistant-only tool it
// replaced (#430), still works as an older name for service_call on Home Assistant, and is guarded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeHomeAssistant } from '../../scripts/fake-home-assistant.js';
import { reportOf } from '../../src/core/envelope.ts';
import { call, scripted, sleep, startNova } from './support.js';

const UNLOCK = { domain: 'lock', service: 'unlock', entity_id: 'lock.back_door' };
const SET = { service: 'acme-thermostat', action: 'set', args: { celsius: 21 } };

// A connector with one action, written only against the connector contract: a manifest that declares
// its capability and its action, a worker, its confirmation check, and act.
function thermostat(state) {
  return (ctx) => ({
    manifest: {
      id: 'acme-thermostat', version: '1.0.0', kind: 'connector', name: 'Acme thermostat', capabilities: [],
      permissions: [{ kind: 'device', target: 'your thermostat', why: 'to set it when you ask' }], secrets: [], config_schema: {}, setup_flow: null,
      health_check: {}, nova_compat: '>=0.1.0 <1.0.0', on_remove: { delete: [], keep: [], export: [] },
      // No `tools`: an action's capability lists service_call whatever the manifest says.
      approvals: [{ id: 'set', name: 'Set the thermostat', effect: 'irreversible', default: 1, guard: 'change the temperature' }],
      actions: [{ id: 'set', name: 'Set the temperature', words: 'Set the thermostat to a temperature, in degrees Celsius. Nova reads the thermostat back as the evidence.', args: { celsius: 'the temperature, like 21' }, approval: 'set' }],
    },
    summary: 'Your thermostat.', can: ['Set the temperature when you ask.'], never: ['Change it unless you ask.'], setup: { kind: 'form', fields: [] },
    egress: () => 'local', status: () => ({ connected: true }), disconnect: async () => ({ revoked: true }),
    worker: {
      id: 'acme-thermostat', name: 'Acme thermostat', about: 'Sets the thermostat when you ask.', egress: 'local', evidence: ['confirmation'],
      effects: () => 'external', health: () => ({ ok: true }),
      async run(brief) {
        state.celsius = Number(brief.inputs?.celsius);
        return reportOf(brief.task_id, 'done', `The thermostat is at ${state.celsius} °C now.`, { evidence: [{ kind: 'confirmation', system: 'acme-thermostat', id: `set:${state.celsius}@${brief.task_id}` }] });
      },
    },
    confirm: (e) => ({ ok: e.kind === 'confirmation' && state.celsius !== undefined, why: `Nova read the thermostat: ${state.celsius} °C.` }),
    act: (action, args) => ctx.delegate({
      title: `Set the thermostat to ${args.celsius} °C`, goal: `The thermostat shows ${args.celsius} °C.`,
      approval_tier: 1, evidence_required: [{ kind: 'confirmation' }], inputs: { celsius: args.celsius },
    }),
  });
}

async function withServices(plan, run, { home = true, acme = true } = {}) {
  const ha = home ? await startFakeHomeAssistant() : null;
  const model = scripted(plan);
  const h = await startNova({ agent: model.agent });
  const state = {};
  try {
    if (ha) await h.nova.core.connectors.connect('home-assistant', { url: ha.base, token: ha.token });
    if (acme) h.nova.core.connectors.register(thermostat(state));
    await run(h, { ha, state, calls: model.calls });
  } finally {
    await h.close();
    await ha?.close();
  }
}

async function settled(h, pick) {
  for (let i = 0; i < 400; i++) {
    const t = h.nova.core.ledger.list().find(pick);
    if (t && ['done', 'failed', 'waiting', 'cancelled'].includes(t.state)) return t;
    await sleep(20);
  }
  throw new Error('the task never settled');
}

test('a second service with one declared action: the same tool lists it and runs it at tier 1, as its own task, without asking', async () => {
  await withServices((i) => [call('service_call', SET)][i] ?? 'It’s 21 °C now.', async (h, { state, calls }) => {
    const { asked, s } = await h.run('Set the heating to 21.');
    assert.deepEqual(asked, [], 'nothing asked in chat');
    // The description the model read lists both connected services and their actions, in words.
    const system = calls[0].system;
    assert.match(system, /- service_call /);
    assert.match(system, /service "home-assistant" \(Home Assistant\), action "call": Call a Home Assistant service\./);
    assert.match(system, /service "acme-thermostat" \(Acme thermostat\), action "set": Set the temperature\. Set the thermostat to a temperature, in degrees Celsius\..*Nova runs it and reports it\. args: celsius: the temperature, like 21\./);
    const tool = s.session.turns[0].items.find((x) => x.kind === 'tool' && x.name === 'service_call');
    assert.equal(tool.result.ok, true, tool.result.output);
    const t = await settled(h, (x) => x.owner === 'acme-thermostat');
    assert.deepEqual([t.state, t.approval_tier, t.approved_at], ['done', 1, null]);
    assert.equal(t.verification.ok, true);
    assert.equal(state.celsius, 21);
    // Its capability lists the tool though its manifest didn't say so.
    assert.ok(h.nova.core.approvals.capability('acme-thermostat.set').tools.includes('service_call'));
  });
});

test('a second service after a web page: the registry’s guard covers its action, with its own words; declined, nothing changes', async () => {
  let base = '';
  await withServices((i) => [call('web_fetch', { url: `${base}/plain` }), call('service_call', SET)][i] ?? 'Done.', async (h, { state }) => {
    base = h.web.base;
    const before = h.nova.core.ledger.list().length;
    const { asked } = await h.run('Read the page, then set the heating to 21.', () => 'deny');
    assert.deepEqual(asked.map((t) => [t.name, t.guard?.what]), [['service_call', 'change the temperature']]);
    assert.equal(asked[0].guard.sources.length, 1, 'the request names the outside source');
    assert.equal(h.nova.core.ledger.list().length, before, 'declined: no task was made');
    assert.equal(state.celsius, undefined);
  });
});

test('a second service raised to tier 2 in the registry: its action waits for an OK, though the connector asked for 1', async () => {
  await withServices((i) => [call('service_call', SET)][i] ?? 'Asked.', async (h, { state }) => {
    h.nova.core.approvals.set('acme-thermostat.set', 2, {});
    await h.run('Set the heating to 21.');
    const t = await settled(h, (x) => x.owner === 'acme-thermostat');
    assert.deepEqual([t.state, t.approval_tier], ['waiting', 2]);
    assert.equal(state.celsius, undefined);
  });
});

test('home_call, the older name, still unlocks at tier 1 and reports: it runs as service_call on Home Assistant', async () => {
  await withServices((i) => [call('home_call', UNLOCK)][i] ?? 'The back door is unlocked.', async (h, { ha }) => {
    const { asked, s } = await h.run('Unlock the back door.');
    assert.deepEqual(asked, [], 'nothing asked in chat');
    const tool = s.session.turns[0].items.find((x) => x.kind === 'tool' && x.name === 'service_call');
    assert.equal(tool.result.ok, true, tool.result.output);
    assert.deepEqual(tool.args, { service: 'home-assistant', action: 'call', args: UNLOCK });
    const t = await settled(h, (x) => x.owner === 'home-assistant');
    assert.deepEqual([t.state, t.approval_tier, t.approved_at], ['done', 1, null]);
    assert.equal(ha.state.entities.get('lock.back_door').state, 'unlocked');
  }, { acme: false });
});

test('home_call, the older name, after a web page: still asks first with Home Assistant’s words; declined, nothing changes', async () => {
  let base = '';
  await withServices((i) => [call('web_fetch', { url: `${base}/plain` }), call('home_call', UNLOCK)][i] ?? 'Done.', async (h, { ha }) => {
    base = h.web.base;
    const before = h.nova.core.ledger.list().length;
    const { asked } = await h.run('Read the page, then unlock the back door.', () => 'deny');
    assert.deepEqual(asked.map((t) => [t.name, t.guard?.what]), [['service_call', 'change your home']]);
    assert.equal(h.nova.core.ledger.list().length, before, 'declined: no task was made');
    assert.equal(ha.state.calls.length, 0);
    assert.equal(ha.state.entities.get('lock.back_door').state, 'locked');
  }, { acme: false });
});

test('with no connected service that has actions, service_call isn’t offered, and neither is home_call', async () => {
  await withServices((i) => [call('home_call', UNLOCK)][i] ?? 'I can’t.', async (h, { calls }) => {
    const { s } = await h.run('Unlock the back door.');
    assert.doesNotMatch(calls[0].system, /- service_call /);
    const tool = s.session.turns[0].items.find((x) => x.kind === 'tool');
    assert.equal(tool.result.ok, false);
    assert.match(tool.result.output, /There is no tool named home_call/);
  }, { home: false, acme: false });
});
