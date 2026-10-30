// A Home Assistant service call says what it will do, and is gated by what it touches (M5 review):
// its data is checked (entity names, plain keys and values) and shown in the approval; the tier
// comes from the entities as well as the domain, so homeassistant.turn_off on a lock needs the
// lock's confirmation; and a bare name (homeassistant, ha.lan) counts as local only once it has
// been resolved to an address on this network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressEgress } from '../../src/core/index.ts';
import { startFakeHomeAssistant } from '../../scripts/fake-home-assistant.js';
import { bootCore, until } from './connector-support.ts';

const HA = '/connectors/home-assistant';

async function connected() {
  const ha = await startFakeHomeAssistant();
  const nova = await bootCore();
  const r = await nova.call('POST', `${HA}/connect`, { url: ha.base, token: ha.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ha, nova, done: async () => { await nova.stop(); await ha.close(); } };
}

test('the tier comes from the entities too: turning off a lock through the homeassistant domain needs its confirmation', async () => {
  const { nova, done } = await connected();
  try {
    assert.equal((await nova.call('POST', `${HA}/services/homeassistant/turn_off`, { entity_id: 'lock.back_door' })).body.approval_tier, 3);
    assert.equal((await nova.call('POST', `${HA}/services/homeassistant/turn_off`, { data: { entity_id: ['light.kitchen', 'lock.back_door'] } })).body.approval_tier, 3);
    assert.equal((await nova.call('POST', `${HA}/services/homeassistant/turn_off`, { entity_id: 'light.kitchen' })).body.approval_tier, 2);
  } finally { await done(); }
});

test('service data is checked and shown in the approval', async () => {
  const { nova, done } = await connected();
  try {
    for (const data of [{ entity_id: 'not an entity' }, { 'Bad Key': 1 }, { brightness: { nested: 1 } }, { entity_id: ['light.kitchen', 7] }, { note: 'x'.repeat(3000) }]) {
      const r = await nova.call('POST', `${HA}/services/light/turn_on`, { data });
      assert.equal(r.status, 400, JSON.stringify(data));
    }
    assert.equal((await nova.call('POST', `${HA}/services/light/turn_on`, { entity_id: 'light.kitchen', data: { entity_id: 'light.porch' } })).status, 400, 'two different entities named');
    const made = await nova.call('POST', `${HA}/services/light/turn_on`, { entity_id: 'light.kitchen', data: { brightness: 120, color_name: 'warm white' } });
    assert.equal(made.status, 201);
    const t = await until(() => nova.get(`/tasks/${made.body.id}`), (x) => x.state === 'waiting');
    assert.match(t.brief.goal, /brightness 120/);
    assert.match(t.brief.goal, /color_name warm white/);
  } finally { await done(); }
});

test('a bare name counts as local only once it resolves to this network', async () => {
  for (const u of ['http://homeassistant:8123', 'http://ha.lan:8123', 'http://ha.internal']) assert.equal(addressEgress(u), 'remote', u);
  assert.equal(addressEgress('http://homeassistant:8123', [], ['homeassistant']), 'local');
  assert.equal(addressEgress('http://homeassistant.local:8123'), 'local', 'mDNS names are on this network by definition');

  const ha = await startFakeHomeAssistant();
  const via = (input: string | URL | Request, init?: RequestInit) => fetch(String(input).replace(/^http:\/\/ha-box:\d+/, ha.base), init);
  let answer = ['192.168.1.20'];
  const nova = await bootCore({ homeAssistant: { fetch: via as typeof fetch, lookup: async () => answer, reconnectMs: { first: 30, max: 200 } } });
  try {
    const ok = await nova.call('POST', `${HA}/connect`, { url: 'http://ha-box:8123', token: ha.token });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.egress, 'local');
    await nova.call('POST', `${HA}/disconnect`);
    // A bare name that resolves to the internet is the internet: local-only doesn't contact it.
    answer = ['8.8.8.8'];
    const no = await nova.call('POST', `${HA}/connect`, { url: 'http://ha-box:8123', token: ha.token });
    assert.match(no.body.error, /local-only/);
  } finally {
    await nova.stop();
    await ha.close();
  }
});
