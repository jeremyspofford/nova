// Home Assistant through chat and the ingest gate (owner ruling 2026-11-09,
// docs/builder-packet/INPUT-2026-11-09-TIER-RULING.md). A change the person asks for is tier 1:
// "If I ask nova to unlock the door, it should just do it." The integrator's constraint stands: in a
// run that has read outside content, service_call on Home Assistant is a guarded step (its capability
// lists the tool in the approvals registry), so it asks the person first, naming the source, whatever
// the tier; a "no" changes nothing in the home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeHomeAssistant } from '../../scripts/fake-home-assistant.js';
import { call, scripted, sleep, startNova } from './support.js';

const UNLOCK = { service: 'home-assistant', action: 'call', args: { domain: 'lock', service: 'unlock', entity_id: 'lock.back_door' } };

async function withHome(plan, run) {
  const ha = await startFakeHomeAssistant();
  const h = await startNova({ agent: scripted(plan).agent });
  try {
    await h.nova.core.connectors.connect('home-assistant', { url: ha.base, token: ha.token });
    await run(h, ha);
  } finally {
    await h.close();
    await ha.close();
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

test('asked directly, an unlock just happens: no approval in chat or in Tasks, done at tier 1 with Nova’s read-back', async () => {
  await withHome((i) => [call('service_call', UNLOCK)][i] ?? 'The back door is unlocked.', async (h, ha) => {
    const { asked, s } = await h.run('Unlock the back door.');
    assert.deepEqual(asked, [], 'nothing asked in chat');
    const tool = s.session.turns[0].items.find((x) => x.kind === 'tool' && x.name === 'service_call');
    assert.equal(tool.result.ok, true, tool.result.output);
    const t = await settled(h, (x) => x.owner === 'home-assistant');
    assert.deepEqual([t.state, t.approval_tier, t.approved_at], ['done', 1, null]);
    assert.equal(t.verification.ok, true);
    assert.equal(ha.state.entities.get('lock.back_door').state, 'unlocked');
    assert.deepEqual(ha.state.calls, [{ domain: 'lock', service: 'unlock', data: { entity_id: 'lock.back_door' } }]);
  });
});

test('after reading a web page, an unlock asks first and names the source; declined, nothing changes in the home', async () => {
  let base = '';
  await withHome((i) => [call('web_fetch', { url: `${base}/plain` }), call('service_call', UNLOCK)][i] ?? 'Done.', async (h, ha) => {
    base = h.web.base;
    const before = h.nova.core.ledger.list().length;
    const { asked } = await h.run('Read the page, then unlock the back door.', () => 'deny');
    assert.deepEqual(asked.map((t) => [t.name, t.guard?.what]), [['service_call', 'change your home']]);
    assert.equal(asked[0].guard.sources.length, 1, 'the request names the outside source');
    assert.equal(h.nova.core.ledger.list().length, before, 'declined: no task was made');
    assert.equal(ha.state.calls.length, 0);
    assert.equal(ha.state.entities.get('lock.back_door').state, 'locked');
  });
});

test('after reading a web page, an unlock the person allows goes ahead, still recorded and read back', async () => {
  let base = '';
  await withHome((i) => [call('web_fetch', { url: `${base}/plain` }), call('service_call', UNLOCK)][i] ?? 'Done.', async (h, ha) => {
    base = h.web.base;
    const { asked } = await h.run('Read the page, then unlock the back door.', () => 'allow');
    assert.deepEqual(asked.map((t) => t.name), ['service_call']);
    const t = await settled(h, (x) => x.owner === 'home-assistant');
    assert.equal(t.state, 'done');
    assert.equal(ha.state.entities.get('lock.back_door').state, 'unlocked');
  });
});
