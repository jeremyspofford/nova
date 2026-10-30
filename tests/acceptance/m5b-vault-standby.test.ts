// The vault on a standby (M5 plan §2), with two real Nova processes (M4's helpers): Home Assistant
// connected on the hub, its token in the hub's vault; the standby catches up and holds the vault
// sealed (its own key file, never the token in plaintext anywhere in its home, and neither node's
// sync log holding the key); the hub is killed; the standby is promoted and Home Assistant works
// there again: it reads states, listens, and a state change becomes an event trigger record.
// Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFakeHomeAssistant } from '../../scripts/fake-home-assistant.js';
import { stop, until, type Running } from './support.ts';
import { kill, setup } from './m4c-support.ts';

function everything(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...everything(p));
    else if (e.isFile()) out.push({ path: p, text: readFileSync(p).toString('latin1') });
  }
  return out;
}

const syncLogHas = (home: string, needle: string) => {
  const db = new DatabaseSync(join(home, 'nova.db'), { readOnly: true });
  try {
    return (db.prepare('SELECT row FROM sync_log WHERE row IS NOT NULL').all() as { row: string }[]).some((r) => r.row.includes(needle));
  } finally { db.close(); }
};

test('the vault replicates sealed: after a failover, Home Assistant works on the new hub', { timeout: 180_000 }, async () => {
  const ha = await startFakeHomeAssistant();
  const s = await setup('nova-m5b');
  const { hub, standby } = s;
  let hubProc: Running | null = s.hubProc;
  let standbyProc: Running | null = null;
  try {
    const connected = await hub.send('POST', '/api/v1/connectors/home-assistant/connect', { url: ha.base, token: ha.token });
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    const rule = (await hub.send('POST', '/api/v1/triggers/rules', { name: 'Front door opened', class: 'event', connector: 'home-assistant', topic: 'binary_sensor.front_door', action: { kind: 'message', text: 'The front door opened.' }, dedup_window_s: 0 })).body.rule;
    assert.ok(rule?.id);
    await until(() => hub.get('/api/v1/connectors/home-assistant'), (v: any) => v.live === 'listening', 400);

    standbyProc = await standby.start(s.env(s.standbyMesh));
    await until(() => hub.get('/api/v1/health'), (h: any) => h.checks.mesh.standby?.lag?.acked_seq > 0 && h.checks.mesh.standby.lag.rows === 0, 400);
    // The settings (journalled) and the vault (its own sealed entry) are there.
    await until(async () => { try { return statSync(join(standby.home, 'vault', 'secrets.json')).size; } catch { return 0; } }, (n) => n > 0, 400);
    await until(async () => { try { return readFileSync(join(standby.home, 'extensions', 'home-assistant', 'config.json'), 'utf8'); } catch { return ''; } }, (t) => t.includes(ha.base), 400);
    assert.equal(statSync(join(standby.home, 'vault', 'secrets.json')).mode & 0o777, 0o600);
    assert.equal(statSync(join(standby.home, 'vault', 'key')).mode & 0o777, 0o600);
    const key = readFileSync(join(hub.home, 'vault', 'key')).toString('base64');
    assert.equal(readFileSync(join(standby.home, 'vault', 'key')).toString('base64'), key, 'the standby holds the same key, in its own key store');
    // The standby runs nothing: no socket of its own to Home Assistant.
    assert.equal(ha.state.subscriptions, 1);
    for (const node of [hub.home, standby.home]) {
      assert.deepEqual(everything(node).filter((f) => f.text.includes(ha.token)).map((f) => f.path), [], `the token is in no file under ${node} in plaintext`);
      assert.equal(syncLogHas(node, key), false, `no sync log under ${node} holds the vault's key`);
    }

    await kill(hubProc);
    hubProc = null;
    const promoted = await standby.send('POST', '/api/v1/mesh/promote', { confirm: true });
    assert.equal(promoted.status, 200, JSON.stringify(promoted.body));

    // Home Assistant works again on the new hub, with the token it got through the vault.
    const view = await until(() => standby.get('/api/v1/connectors/home-assistant'), (v: any) => v.live === 'listening', 400);
    assert.deepEqual([view.connected, view.live, view.account], [true, 'listening', 'Home']);
    const states = await standby.get('/api/v1/connectors/home-assistant/states');
    assert.ok(Array.isArray(states) && states.some((x: any) => x.entity_id === 'light.kitchen'), JSON.stringify(states));
    ha.setState('binary_sensor.front_door', 'on');
    const fired = await until(() => standby.get(`/api/v1/triggers?rule=${rule.id}`), (l: any[]) => l.length > 0, 400);
    assert.equal(fired[0].class, 'event');
    assert.equal(fired[0].source, 'connector:home-assistant/binary_sensor.front_door');
  } finally {
    if (hubProc) await stop(hubProc);
    if (standbyProc) await stop(standbyProc);
    await ha.close();
  }
});
