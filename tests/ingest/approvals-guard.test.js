// The outside-content guard is not a tier (owner ruling 2026-11-09, the integrator's constraint): a
// run that has read outside content asks before a guarded step, whatever the approval tier is set
// to. Here Home Assistant's tier is set through the approvals registry (raised to 2, then lowered
// back to 1 with a confirmation, so the setting is explicitly 1), and the same approach as
// home-guard.test.js shows the unlock still asks after a web page, and changes nothing when declined.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeHomeAssistant } from '../../scripts/fake-home-assistant.js';
import { call, scripted, sleep, startNova } from './support.js';

const UNLOCK = { domain: 'lock', service: 'unlock', entity_id: 'lock.back_door' };

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

test('Home Assistant set to tier 1 through the approvals registry: after a web page, an unlock still asks, and declined changes nothing', async () => {
  let base = '';
  await withHome((i) => [call('web_fetch', { url: `${base}/plain` }), call('home_call', UNLOCK)][i] ?? 'Done.', async (h, ha) => {
    base = h.web.base;
    const approvals = h.nova.core.approvals;
    assert.equal(approvals.set('home-assistant.service', 2, {}).effective, 2);
    assert.equal(approvals.set('home-assistant.service', 1, { confirm: true }).override, 1);
    // The registry writes Home Assistant's own setting; its route reads the same.
    const settings = h.nova.core.routes.find((r) => r.method === 'GET' && r.path === '/connectors/home-assistant/settings');
    assert.equal((await settings.handle({ params: {}, query: new URLSearchParams(), body: {}, headers: {}, who: { principal: { kind: 'console' }, listener: 'console', address: 'console' } })).service_tier, 1);

    const before = h.nova.core.ledger.list().length;
    const { asked } = await h.run('Read the page, then unlock the back door.', () => 'deny');
    assert.deepEqual(asked.map((t) => [t.name, t.guard?.what]), [['home_call', 'change your home']]);
    assert.equal(h.nova.core.ledger.list().length, before, 'declined: no task was made');
    assert.equal(ha.state.calls.length, 0);
    assert.equal(ha.state.entities.get('lock.back_door').state, 'locked');
  });
});

test('Home Assistant raised to tier 2 through the registry: a direct unlock waits for an OK, as its own setting did', async () => {
  await withHome((i) => [call('home_call', UNLOCK)][i] ?? 'Asked.', async (h, ha) => {
    h.nova.core.approvals.set('home-assistant.service', 2, {});
    await h.run('Unlock the back door.');
    const t = await settled(h, (x) => x.owner === 'home-assistant');
    assert.deepEqual([t.state, t.approval_tier], ['waiting', 2]);
    assert.equal(ha.state.calls.length, 0);
  });
});
