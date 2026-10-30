// The Home Assistant connector (M5 plan §2) against the stand-in Home Assistant
// (scripts/fake-home-assistant.js, REST and WebSocket): connecting with an address and a
// long-lived token (kept in the vault), reading states (tier 0), a service call that waits for an
// OK (tier 2) and Nova's own read-back as evidence, a marked domain that needs a confirmation
// every time (tier 3), state changes becoming event trigger records for the entities a rule
// listens to, reconnecting after the socket drops, a token Home Assistant stops accepting, egress
// and local-only, and disconnecting: the token deleted at Home Assistant and in the vault, the
// rules and the subscription gone. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { egressOf, tokenIssuer } from '../../src/core/index.ts';
import { startFakeHomeAssistant } from '../../scripts/fake-home-assistant.js';
import { bootCore, sleep, until } from './connector-support.ts';

const HA = '/connectors/home-assistant';

async function connected() {
  const ha = await startFakeHomeAssistant();
  const nova = await bootCore();
  const r = await nova.call('POST', `${HA}/connect`, { url: `${ha.base}/`, token: ha.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await until(() => nova.get(HA), (v) => v.live === 'listening');
  return { ha, nova, done: async () => { await nova.stop(); await ha.close(); } };
}

test('connecting: plain words when it is wrong; the token goes into the vault, the address into its settings', async () => {
  const ha = await startFakeHomeAssistant();
  const { call, get, core, home, stop } = await bootCore();
  try {
    const list = (await get('/connectors')).connectors;
    const view = list.find((c: { id: string }) => c.id === 'home-assistant');
    assert.equal(view.connected, false);
    assert.equal(view.recommended, true, 'the one Nova recommends connecting, local-only being the default');
    assert.ok(view.can.some((s: string) => /after asking you first/.test(s)));
    assert.deepEqual((await get('/extensions')).filter((x: { kind: string }) => x.kind === 'connector'), [], 'nothing in the extension host until it is connected');

    assert.match((await call('POST', `${HA}/connect`, { url: 'not an address', token: 'x' })).body.error, /Enter your Home Assistant’s address/);
    assert.match((await call('POST', `${HA}/connect`, { url: 'ftp://192.168.1.5', token: 'x' })).body.error, /http:\/\/ or https:\/\//);
    assert.match((await call('POST', `${HA}/connect`, { url: ha.base, token: '' })).body.error, /long-lived access token/);
    assert.match((await call('POST', `${HA}/connect`, { url: ha.base, token: 'wrong-token-value' })).body.error, /didn’t accept that token/);
    assert.match((await call('POST', `${HA}/connect`, { url: 'http://127.0.0.1:9', token: ha.token })).body.error, /Couldn’t reach Home Assistant/);

    const ok = await call('POST', `${HA}/connect`, { url: ha.base, token: ha.token });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.body.connected, ok.body.account, ok.body.egress], [true, 'Home', 'local']);
    assert.deepEqual(ok.body.secrets, ['HA_TOKEN']);
    assert.equal(core.vault.get('connector/home-assistant/HA_TOKEN'), ha.token);
    const settings = readFileSync(join(home, 'extensions', 'home-assistant', 'config.json'), 'utf8');
    assert.match(settings, new RegExp(ha.base.replace(/[.:/]/g, '\\$&')));
    assert.ok(!settings.includes(ha.token), 'the token is not in its settings');
    const ext = (await get('/extensions')).find((x: { id: string }) => x.id === 'home-assistant');
    assert.deepEqual([ext.kind, ext.state], ['connector', 'enabled']);
    await until(() => get(HA), (v) => v.live === 'listening');
    assert.equal(ha.state.subscriptions, 1);
    assert.equal((await get('/health')).checks.connectors.connected, 1);
  } finally {
    await stop();
    await ha.close();
  }
});

test('reading states is tier 0: Nova looks, and no task or approval is involved', async () => {
  const { ha, nova, done } = await connected();
  try {
    const all = await nova.get(`${HA}/states`);
    assert.ok(all.some((s: { entity_id: string; name: string; state: string }) => s.entity_id === 'light.kitchen' && s.name === 'Kitchen light' && s.state === 'off'));
    assert.deepEqual((await nova.get(`${HA}/states?domain=lock`)).map((s: { entity_id: string }) => s.entity_id), ['lock.back_door']);
    assert.equal((await nova.get(`${HA}/states/sensor.living_room_temperature`)).state, '21.5');
    assert.equal((await nova.call('GET', `${HA}/states/not-an-entity`)).status, 400);
    assert.equal((await nova.call('GET', `${HA}/states/light.nowhere`)).status, 404);
    assert.deepEqual(await nova.get('/tasks'), []);
    assert.equal(ha.state.calls.length, 0);
  } finally { await done(); }
});

test('a service call is tier 2: it waits for your OK, then Nova reads the result back itself as evidence', async () => {
  const { ha, nova, done } = await connected();
  try {
    const made = await nova.call('POST', `${HA}/services/light/turn_on`, { entity_id: 'light.kitchen' });
    assert.equal(made.status, 201);
    const task = await until(() => nova.get(`/tasks/${made.body.id}`), (t) => t.state === 'waiting');
    assert.deepEqual([task.state, task.approval_tier, task.owner], ['waiting', 2, 'home-assistant']);
    assert.match(task.reason, /Needs your OK/);
    await sleep(100);
    assert.equal(ha.state.calls.length, 0, 'nothing changed in the home before the OK');
    assert.equal(ha.state.entities.get('light.kitchen').state, 'off');

    assert.equal((await nova.call('POST', `/tasks/${task.id}/approve`, {})).status, 200);
    const finished = await until(() => nova.get(`/tasks/${task.id}`), (t) => ['done', 'failed', 'blocked'].includes(t.state));
    assert.equal(finished.state, 'done', JSON.stringify(finished));
    assert.equal(ha.state.entities.get('light.kitchen').state, 'on');
    assert.deepEqual(ha.state.calls, [{ domain: 'light', service: 'turn_on', data: { entity_id: 'light.kitchen' } }]);
    assert.equal(finished.verification.ok, true);
    assert.match(finished.verification.checks[0].why, /Nova read light\.kitchen from Home Assistant itself after the call: on/);
    // The trace: a reactive trigger record for the request.
    assert.ok((await nova.get('/triggers')).some((t: { ledger_task_id: string; source: string }) => t.ledger_task_id === task.id && t.source === 'connector:home-assistant'));

    // A task can't lower its own gate: tier 0 straight to the worker is refused without a call.
    const sneaky = await nova.call('POST', '/tasks', { title: 'Switch the fan on', owner: 'home-assistant', goal: 'The fan is on.', approval_tier: 0, evidence_required: [{ kind: 'confirmation' }], inputs: { domain: 'switch', service: 'turn_on', data: { entity_id: 'switch.fan' } } });
    const blocked = await until(() => nova.get(`/tasks/${sneaky.body.id}`), (t) => !['queued', 'active'].includes(t.state));
    assert.notEqual(blocked.state, 'done');
    assert.equal(ha.state.entities.get('switch.fan').state, 'off');
    assert.equal(ha.state.calls.length, 1);
  } finally { await done(); }
});

test('a domain the person marks is tier 3: an explicit confirmation every time; unmarking needs one too', async () => {
  const { ha, nova, done } = await connected();
  try {
    assert.deepEqual((await nova.get(`${HA}/settings`)).tier3_domains, ['lock', 'alarm_control_panel']);
    const made = (await nova.call('POST', `${HA}/services/lock/unlock`, { entity_id: 'lock.back_door' })).body;
    assert.equal(made.approval_tier, 3);
    await until(() => nova.get(`/tasks/${made.id}`), (t) => t.state === 'waiting');
    assert.match((await nova.call('POST', `/tasks/${made.id}/approve`, {})).body.error, /explicit confirmation/);
    assert.equal(ha.state.calls.length, 0);
    assert.equal((await nova.call('POST', `/tasks/${made.id}/approve`, { confirm: true })).status, 200);
    assert.equal((await until(() => nova.get(`/tasks/${made.id}`), (t) => t.state === 'done')).state, 'done');
    assert.equal(ha.state.entities.get('lock.back_door').state, 'unlocked');

    // Marking another domain tightens the gate: no confirmation needed. Unmarking loosens it.
    assert.deepEqual((await nova.call('PUT', `${HA}/settings`, { tier3_domains: ['lock', 'alarm_control_panel', 'switch'] })).body.tier3_domains, ['lock', 'alarm_control_panel', 'switch']);
    assert.equal((await nova.call('POST', `${HA}/services/switch/turn_on`, { entity_id: 'switch.fan' })).body.approval_tier, 3);
    const loosen = await nova.call('PUT', `${HA}/settings`, { tier3_domains: ['switch'] });
    assert.equal(loosen.status, 400);
    assert.match(loosen.body.error, /Taking lock, alarm_control_panel off the list/);
    assert.equal((await nova.call('PUT', `${HA}/settings`, { tier3_domains: ['switch'], confirm: true })).status, 200);
    assert.equal((await nova.call('POST', `${HA}/services/lock/lock`, { entity_id: 'lock.back_door' })).body.approval_tier, 2);
  } finally { await done(); }
});

test('state changes become event trigger records, for the entities a rule listens to', async () => {
  const { ha, nova, done } = await connected();
  try {
    const bad = await nova.call('POST', '/triggers/rules', { name: 'Door', class: 'event', connector: 'home-assistant', topic: 'front door', action: { kind: 'message', text: 'x' } });
    assert.equal(bad.status, 400);
    assert.match((await nova.call('POST', '/triggers/rules', { name: 'Door', class: 'event', connector: 'nowhere', topic: 'a.b', action: { kind: 'message', text: 'x' } })).body.error, /no connector called nowhere/);
    const made = await nova.call('POST', '/triggers/rules', { name: 'Front door opened', class: 'event', connector: 'home-assistant', topic: 'binary_sensor.front_door', action: { kind: 'message', text: 'The front door opened.' }, dedup_window_s: 0 });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const rule = made.body.rule;
    assert.equal(rule.source, 'connector:home-assistant/binary_sensor.front_door');
    assert.equal(made.body.token, undefined, 'no webhook token: the connector fires it');

    ha.setState('light.hallway', 'off'); // nobody listens to this one
    ha.setState('binary_sensor.front_door', 'off', { battery: 90 }); // attributes only: not a change
    ha.setState('binary_sensor.front_door', 'on');
    const fired = await until(() => nova.get(`/triggers?rule=${rule.id}`), (l) => l.length > 0);
    assert.equal(fired.length, 1);
    assert.deepEqual([fired[0].class, fired[0].source, fired[0].triage.decision], ['event', 'connector:home-assistant/binary_sensor.front_door', 'act']);
    assert.ok(fired[0].message_id);
    assert.ok((await nova.get('/messages')).some((m: { text: string; trigger_id: string }) => m.text === 'The front door opened.' && m.trigger_id === fired[0].trigger_id));
    await sleep(100);
    assert.equal((await nova.get('/triggers')).filter((t: { class: string }) => t.class === 'event').length, 1, 'only the entity a rule listens to');
  } finally { await done(); }
});

test('the socket drops: Nova reconnects by itself and keeps listening', async () => {
  const { ha, nova, done } = await connected();
  try {
    const rule = (await nova.call('POST', '/triggers/rules', { name: 'Fan', class: 'event', connector: 'home-assistant', topic: 'switch.fan', action: { kind: 'message', text: 'The fan changed.' }, dedup_window_s: 0 })).body.rule;
    ha.dropSockets();
    await until(() => ha.state.subscriptions, (n) => n >= 2);
    assert.equal(ha.state.subscriptions, 2, 'subscribed again on a new socket');
    assert.equal((await until(() => nova.get(HA), (v) => v.live === 'listening')).live, 'listening');
    ha.setState('switch.fan', 'on');
    assert.equal((await until(() => nova.get(`/triggers?rule=${rule.id}`), (l) => l.length > 0)).length, 1);
  } finally { await done(); }
});

test('a token Home Assistant stops accepting: says so plainly and stops retrying', async () => {
  const { ha, nova, done } = await connected();
  try {
    ha.state.tokens.clear();
    ha.dropSockets();
    const v = await until(() => nova.get(HA), (x) => x.broken === true);
    assert.equal(v.broken, true);
    assert.match(v.detail, /no longer accepts Nova’s token/);
    assert.ok((await nova.get('/problems')).some((p: { message: string }) => /no longer accepts Nova’s token/.test(p.message)));
    const auths = ha.state.auths;
    await sleep(300);
    assert.equal(ha.state.auths, auths, 'no retry loop against a token that is refused');
    assert.match((await nova.call('GET', `${HA}/states`)).body.error, /needs reconnecting/);
  } finally { await done(); }
});

test('egress: local for this network or the mesh, remote otherwise; local-only never contacts a remote one', async () => {
  for (const u of ['http://127.0.0.1:8123', 'http://192.168.1.20:8123', 'http://10.0.0.2', 'http://172.20.1.1', 'http://homeassistant.local:8123', 'http://homeassistant:8123', 'http://[fd00::1]:8123', 'http://[::1]:8123']) assert.equal(egressOf(u), 'local', u);
  for (const u of ['https://home.example.com', 'http://8.8.8.8', 'http://172.40.1.1', 'not a url']) assert.equal(egressOf(u), 'remote', u);
  assert.equal(egressOf('https://hub.example.net:4318', ['hub.example.net']), 'local', 'a device in the mesh');

  // A Home Assistant reached at a public name: Nova's fetch is pointed at the stand-in.
  const ha = await startFakeHomeAssistant();
  const via = (input: string | URL | Request, init?: RequestInit) => fetch(String(input).replace('https://home.example.com', ha.base), init);
  const nova = await bootCore({ homeAssistant: { fetch: via as typeof fetch, reconnectMs: { first: 30, max: 200 } } });
  try {
    assert.match((await nova.call('POST', `${HA}/connect`, { url: 'https://home.example.com', token: ha.token })).body.error, /local-only, so Nova doesn’t contact it/);
    await nova.call('PUT', '/profile/privacy/default', { value: 'cloud-allowed' });
    const ok = await nova.call('POST', `${HA}/connect`, { url: 'https://home.example.com', token: ha.token });
    assert.deepEqual([ok.body.connected, ok.body.egress], [true, 'remote']);
    assert.equal((await nova.get('/workers')).find((w: { id: string }) => w.id === 'home-assistant').egress, 'remote');
    await nova.call('PUT', '/profile/privacy/default', { value: 'local-only' });
    const view = await nova.get(HA);
    assert.equal(view.allowed, false);
    assert.match(view.blocked, /local-only/);
    assert.match((await nova.call('GET', `${HA}/states`)).body.error, /outside your network \(home\.example\.com\)/);
    // The ledger refuses the task itself: a local-only task never goes to a remote worker.
    const refused = await nova.call('POST', `${HA}/services/light/turn_on`, { entity_id: 'light.kitchen' });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Home Assistant sends data off your devices, and this task is local-only/);
    assert.equal(ha.state.calls.length, 0);
  } finally {
    await nova.stop();
    await ha.close();
  }
});

test('disconnecting revokes: the token deleted at Home Assistant and in the vault, rules and subscription gone', async () => {
  const { ha, nova, done } = await connected();
  try {
    const rule = (await nova.call('POST', '/triggers/rules', { name: 'Door', class: 'event', connector: 'home-assistant', topic: 'binary_sensor.front_door', action: { kind: 'message', text: 'Door.' } })).body.rule;
    assert.equal(tokenIssuer(ha.token), ha.tokenId);
    const r = await nova.call('POST', `${HA}/disconnect`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.revoked, r.body.connected, r.body.rules_removed, r.body.note], [true, false, 1, null]);
    assert.deepEqual(ha.state.revoked, [ha.tokenId], 'deleted at Home Assistant itself');
    assert.equal((await fetch(`${ha.base}/api/`, { headers: { authorization: `Bearer ${ha.token}` } })).status, 401, 'the token no longer works anywhere');
    assert.deepEqual(nova.core.vault.list('connector/home-assistant/'), []);
    assert.equal((await nova.call('GET', `/triggers/rules/${rule.id}`)).status, 404);
    assert.equal(existsSync(join(nova.home, 'extensions', 'home-assistant')), false);
    assert.equal((await nova.get('/extensions')).some((x: { id: string }) => x.id === 'home-assistant'), false);
    await until(() => ha.sockets().length, (n) => n === 0);
    assert.equal(ha.sockets().length, 0, 'no socket left open');
    const subs = ha.state.subscriptions;
    await sleep(200);
    assert.equal(ha.state.subscriptions, subs, 'and it doesn’t come back');
    assert.equal((await nova.get(HA)).connected, false);
  } finally { await done(); }
});

test('removing it through the extension host revokes the same way', async () => {
  const { ha, nova, done } = await connected();
  try {
    await nova.call('POST', '/triggers/rules', { name: 'Door', class: 'event', connector: 'home-assistant', topic: 'binary_sensor.front_door', action: { kind: 'message', text: 'Door.' } });
    assert.equal((await nova.call('DELETE', '/extensions/home-assistant')).status, 200);
    assert.deepEqual(nova.core.vault.list('connector/home-assistant/'), []);
    assert.deepEqual(nova.core.triggers.connectorTopics('home-assistant'), []);
    await until(() => ha.state.revoked.length, (n) => n === 1);
    assert.deepEqual(ha.state.revoked, [ha.tokenId]);
    assert.equal((await nova.get(HA)).connected, false);
  } finally { await done(); }
});
