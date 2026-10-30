// The hub is a role, not a box (ADR-11), with two real Nova processes on loopback: a hub with
// data of every kind, a standby enrolled through the real protocol with its own identity keys,
// catch-up, the hub killed with SIGKILL while a task is running, promotion on the standby's
// console, no data loss by content hash, the running task recovered, the revoked phone still
// revoked, the old hub fencing itself when it comes back, and automatic failover only when it was
// turned on. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { loadIdentity, type DeviceKeys } from '../../src/core/index.ts';
import { Joiner, call } from '../core/mesh-support.ts';
import { ROOT, blank, sleep, stop, until, type Running } from './support.ts';

const nowS = () => Math.floor(Date.now() / 1000);
const sha = (v: unknown) => createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex');
const agent = { NOVA_AGENT_CMD: `FAKE_DELAY=1 node ${join(ROOT, 'scripts/fake-agent.js')}`, NOVA_AGENT_EGRESS: 'none' };

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

async function kill(r: Running) {
  r.proc.kill('SIGKILL');
  for (let i = 0; i < 200 && r.proc.exitCode === null && r.proc.signalCode === null; i++) await sleep(25);
}

// A hub and a standby home, each with a mesh listener on its own loopback port. The standby enrolls
// the way `boot.ts join --kind standby --nova-home` does: with the keys in its home's identity file,
// then writes mesh/role.json.
async function setup(prefix: string, hubExtra: (home: string) => void = () => {}) {
  const hub = blank(`${prefix}-hub-`);
  const standby = blank(`${prefix}-standby-`);
  const hubMesh = `http://127.0.0.1:${await freePort()}`;
  const standbyMesh = `http://127.0.0.1:${await freePort()}`;
  const env = (url: string) => ({ ...agent, NOVA_MESH_URL: url, NOVA_MESH_TRANSPORT: 'network', NOVA_SYNC_WAIT_S: '5' });
  hubExtra(hub.home);
  const hubProc = await hub.start(env(hubMesh));

  const id = loadIdentity(standby.home);
  const keys = { ed25519: { publicKey: id.publicKey, privateKey: id.signer() }, x25519: { publicKey: id.x25519PublicKey, privateKey: null } } as unknown as DeviceKeys;
  const code = (await hub.send('POST', '/api/v1/mesh/pairings')).body.code;
  const dev = new Joiner(hubMesh, nowS, { name: 'Standby', platform: 'test', kind: 'standby', capabilities: [], address: standbyMesh }, keys);
  assert.equal((await dev.join(code)).status, 201);
  assert.equal((await dev.reveal()).status, 200);
  assert.equal((await hub.send('POST', `/api/v1/mesh/requests/${dev.requestId}/approve`, { confirm: true })).status, 200);
  const polled = await dev.poll();
  assert.equal(polled.body.state, 'approved');
  const r = polled.body.roster.roster;
  writeFileSync(join(standby.home, 'mesh', 'role.json'), JSON.stringify({
    version: 1, role: 'standby', device_id: dev.deviceId, epoch: r.epoch, roster: polled.body.roster,
    hub: { id: r.hub.id, url: r.hub.url, public_key: r.hub.public_key, x25519_public_key: r.hub.x25519_public_key },
  }, null, 2));
  assert.equal(r.hub.url, hubMesh, 'the roster names the hub where devices reach it');
  return { hub, standby, hubMesh, standbyMesh, hubProc, env, standbyId: dev.deviceId };
}

// Every byte under a folder, as text, for scanning: database, write-ahead log, backups, files.
function everything(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...everything(p));
    else if (e.isFile()) out.push({ path: p, text: readFileSync(p).toString('latin1') });
  }
  return out;
}

// Rows by key, hashed, from a database file (read-only, while the server runs).
function rows(home: string, sql: string, key: string, ...params: string[]): Record<string, string> {
  const db = new DatabaseSync(join(home, 'nova.db'), { readOnly: true });
  try {
    return Object.fromEntries((db.prepare(sql).all(...params) as Record<string, unknown>[]).map((r) => [String(r[key]), sha(r)]));
  } finally {
    db.close();
  }
}

test('kill the hub, promote the standby: nothing lost, the running task recovered, trust intact, the old hub fenced', { timeout: 180_000 }, async () => {
  const s = await setup('nova-m4c', (home) => {
    mkdirSync(join(home, 'schedules'), { recursive: true });
    writeFileSync(join(home, 'schedules', 'slow-review.md'), '---\nname: Slow review\ncron: 0 9 * * *\ndeliver: main\n---\n\nslow review of the notes\n');
  });
  const { hub, standby } = s;
  let hubProc: Running | null = s.hubProc;
  let standbyProc: Running | null = null;
  try {
    // Data of every kind on the hub.
    assert.equal((await hub.send('PUT', '/api/v1/profile/user/name', { value: 'Sam' })).status, 200);
    const mem = (await hub.send('POST', '/api/v1/memory', { kind: 'preference', content: 'Prefers window seats on trains.' })).body;
    const fixed = (await hub.send('POST', `/api/v1/memory/${mem.id}/correct`, { content: 'Prefers aisle seats on trains.' })).body;
    await hub.get('/api/memory'); // Era 2 renders MEMORY.md from it
    const task = (await hub.send('POST', '/api/v1/tasks', {
      title: 'Save a packing list', owner: 'workspace', goal: 'The list is saved.', evidence_required: [{ kind: 'read_back', target: 'workspace:lists/packing.md' }],
      inputs: { action: 'write', path: 'lists/packing.md', content: '- charger\n- passport\n' },
    })).body;
    assert.equal((await until(() => hub.get(`/api/v1/tasks/${task.id}`), (t: any) => t.state === 'done')).state, 'done');
    const chat = (await hub.send('POST', '/api/sessions', { text: 'hello there' })).body;
    await until(() => hub.get(`/api/sessions/${chat.id}`), (v: any) => !v.live);
    const rule = (await hub.send('POST', '/api/v1/triggers/rules', { name: 'Stretch', class: 'proactive', action: { kind: 'message', text: 'Time to stretch.' } })).body.rule;
    assert.equal((await hub.send('POST', `/api/v1/triggers/rules/${rule.id}/fire`, {})).status, 200);
    mkdirSync(join(hub.home, 'workspace', 'notes'), { recursive: true });
    writeFileSync(join(hub.home, 'workspace', 'notes', 'plan.md'), '# Plan\n\n- book the train\n');
    // A phone, then revoked.
    const code = (await hub.send('POST', '/api/v1/mesh/pairings')).body.code;
    const phone = new Joiner(s.hubMesh, nowS);
    await phone.join(code);
    await phone.reveal();
    await hub.send('POST', `/api/v1/mesh/requests/${phone.requestId}/approve`, { confirm: true });
    await phone.poll();
    assert.equal((await phone.session()).status, 200);
    assert.equal((await hub.send('POST', `/api/v1/mesh/devices/${phone.deviceId}/revoke`, { confirm: true })).status, 200);

    // The standby starts from nothing and catches up.
    standbyProc = await standby.start(s.env(s.standbyMesh));
    assert.match(standbyProc.out.join(''), /This is the standby; .* is the hub\./);
    const health = await until(() => hub.get('/api/v1/health'), (h: any) => h.checks.mesh.standby?.lag?.acked_seq > 0 && h.checks.mesh.standby.lag.rows === 0, 400);
    assert.equal(health.checks.mesh.standby.id, s.standbyId);
    await until(() => standby.get('/api/v1/memory'), (m: any) => m.some((x: any) => x.id === fixed.id), 400);
    assert.equal((await standby.send('POST', '/api/v1/memory', { kind: 'fact', content: 'x' })).status, 409, 'the standby refuses changes');
    assert.equal((await standby.send('POST', '/api/sessions', { text: 'hi' })).status, 409, 'Era 2’s changes too');

    // Forgetting holds on the standby, in its database, its files and its backups.
    const words = 'Locker combination 7319 behind the quartz panel';
    const secret = (await hub.send('POST', '/api/v1/memory', { kind: 'fact', content: words })).body;
    await hub.get('/api/memory');
    await until(() => standby.get('/api/v1/memory'), (m: any) => m.some((x: any) => x.id === secret.id), 400);
    await until(async () => readFileSync(join(standby.home, 'MEMORY.md'), 'utf8'), (t) => t.includes(words), 400);
    mkdirSync(join(standby.home, 'backups'), { recursive: true });
    const backup = join(standby.home, 'backups', 'nova-2026-10-29T09-00-00-000Z-v5.db');
    new DatabaseSync(join(standby.home, 'nova.db')).exec(`VACUUM INTO '${backup}'`);
    assert.ok(readFileSync(backup).toString('latin1').includes(words), 'the backup holds the words before');
    assert.equal((await hub.send('DELETE', `/api/v1/memory/${secret.id}`)).status, 200);
    await until(() => standby.get('/api/v1/memory'), (m: any) => !m.some((x: any) => x.id === secret.id), 400);
    await until(async () => readFileSync(join(standby.home, 'MEMORY.md'), 'utf8'), (t) => !t.includes(words), 400);
    for (const node of [standby.home, hub.home]) {
      const held = everything(node).filter((f) => f.text.includes(words) || f.text.includes('quartz panel')).map((f) => f.path);
      assert.deepEqual(held, [], `nothing under ${node} still holds the words`);
    }

    // Work that is running when the hub dies.
    assert.ok([200, 202].includes((await hub.send('POST', '/api/schedules/slow-review/run', {})).status));
    const running = await until<any[]>(() => hub.get('/api/v1/tasks'), (ts) => ts.some((t) => t.owner === 'chat-run' && t.state === 'active'), 400);
    const slow = running.find((t) => t.owner === 'chat-run' && t.state === 'active');
    assert.ok(slow, 'a scheduled run is active');
    await until(() => standby.get(`/api/v1/tasks/${slow.id}`), (t: any) => t?.state === 'active', 400);
    // Everything from before, by content hash, and the hub's files, as the hub has them now.
    await until(() => hub.get('/api/v1/health'), (h: any) => h.checks.mesh.standby.lag.rows === 0, 400);
    const memIds = [mem.id, fixed.id];
    const snapshot = (home: string) => ({
      profile: rows(home, 'SELECT * FROM profile', 'key'),
      task: rows(home, 'SELECT * FROM task WHERE id = ?', 'id', task.id),
      events: rows(home, 'SELECT * FROM task_event WHERE task_id = ?', 'seq', task.id),
      memory: rows(home, `SELECT * FROM memory WHERE id IN (?, ?)`, 'id', ...memIds),
      memory_events: rows(home, `SELECT * FROM memory_event WHERE memory_id IN (?, ?)`, 'id', ...memIds),
      rules: rows(home, 'SELECT * FROM trigger_rule', 'id'),
      triggers: rows(home, 'SELECT * FROM "trigger" WHERE rule_id = ?', 'trigger_id', rule.id),
      messages: rows(home, 'SELECT * FROM message', 'id'),
      receipts: rows(home, 'SELECT * FROM receipt WHERE session_id = ?', 'id', chat.id),
      extensions: rows(home, 'SELECT * FROM extension', 'id'),
      trust: rows(home, 'SELECT id, trust, revoked_at, public_key FROM device', 'id'),
      files: Object.fromEntries(['workspace/lists/packing.md', 'workspace/notes/plan.md', `sessions/${chat.id}.jsonl`, 'schedules/slow-review.md'].map((f) => [f, sha(readFileSync(join(home, f)))])),
    });
    const before = snapshot(hub.home);
    assert.ok(Object.keys(before.receipts).length > 0 && Object.keys(before.messages).length + Object.keys(before.triggers).length > 0, 'there is something of each');

    await kill(hubProc);
    hubProc = null;

    // Automatic failover is off, so the standby waits for the person.
    await sleep(3000);
    const waiting = await standby.get('/api/v1/mesh/status');
    assert.equal(waiting.role, 'standby');
    assert.ok(waiting.replica.sync.unreachable_since, 'it knows the hub is gone');

    const promoted = await standby.send('POST', '/api/v1/mesh/promote', { confirm: true });
    assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
    assert.equal(promoted.body.epoch, 2);
    assert.equal(promoted.body.task.title, 'Standby promoted to hub');
    assert.equal(promoted.body.task.state, 'done', promoted.body.task.reason);
    assert.equal(promoted.body.task.report.evidence[0].kind, 'confirmation');
    assert.ok(promoted.body.recovered.requeued.includes(slow.id), 'the running task was recovered');

    // No data loss.
    assert.deepEqual(snapshot(standby.home), before);

    // The task that was running when the hub died is recovered by the new hub and settled the way
    // a restart settles it: a chat run that was under way isn't run again (its steps may have
    // changed things); it ends saying so. If the crash came before the run had started, it runs.
    const after = await until(() => standby.get(`/api/v1/tasks/${slow.id}`), (t: any) => ['done', 'failed', 'cancelled'].includes(t.state), 1200);
    assert.ok(after.state === 'done' || /stopped before it was done/.test(after.reason), `${after.state}: ${after.reason}`);
    const events = await standby.get(`/api/v1/tasks/${slow.id}/events`);
    assert.ok(events.some((e: any) => e.kind === 'recovered'), 'recovered after the failover');

    // No orphaned trust: the phone stays revoked; the new hub takes changes.
    const devices = await standby.get('/api/v1/mesh/devices');
    assert.equal(devices.find((d: any) => d.id === phone.deviceId).trust, 'revoked');
    assert.equal(devices.find((d: any) => d.id === s.standbyId).role, 'hub');
    assert.equal((await phone.session({ base: s.standbyMesh })).status, 401);
    assert.equal((await standby.send('POST', '/api/v1/memory', { kind: 'fact', content: 'The new hub takes changes.' })).status, 201);
    const hello = (await call(s.standbyMesh, 'GET', '/api/v1/mesh/hello')).body;
    assert.deepEqual([hello.role, hello.epoch], ['hub', 2]);

    // The old hub comes back: it asks its peers, finds a higher epoch, and steps down.
    hubProc = await hub.start(s.env(s.hubMesh));
    assert.match(hubProc.out.join(''), /isn’t the hub any more: “Standby” at .* became the hub \(epoch 2\)/);
    const fenced = await hub.get('/api/v1/mesh/status');
    assert.equal(fenced.role, 'standby');
    const refused = await hub.send('POST', '/api/v1/memory', { kind: 'fact', content: 'x' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /isn’t the hub any more/);
    assert.equal((await call(s.hubMesh, 'GET', '/api/v1/mesh/hello')).body.role, 'standby');
    assert.equal((await standby.get('/api/v1/mesh/status')).role, 'hub', 'still exactly one hub');
  } finally {
    if (hubProc) await stop(hubProc);
    if (standbyProc) await stop(standbyProc);
  }
});

test('automatic failover, when turned on: the standby takes over by itself once the hub has been gone that long', { timeout: 120_000 }, async () => {
  const s = await setup('nova-m4c-auto');
  let hubProc: Running | null = s.hubProc;
  let standbyProc: Running | null = null;
  try {
    assert.equal((await s.hub.send('PUT', '/api/v1/profile/mesh/auto_failover_after_s', { value: 2 })).status, 200);
    standbyProc = await s.standby.start(s.env(s.standbyMesh));
    await until(() => s.standby.get('/api/v1/profile'), (p: any) => p.mesh?.auto_failover_after_s === 2, 400);
    assert.equal((await s.standby.get('/api/v1/mesh/status')).role, 'standby');
    await kill(hubProc);
    hubProc = null;
    const st = await until(() => s.standby.get('/api/v1/mesh/status'), (v: any) => v.role === 'hub', 600);
    assert.equal(st.role, 'hub');
    assert.equal(st.epoch, 2);
    const t = await until<any[]>(() => s.standby.get('/api/v1/tasks'), (ts) => ts.some((x) => x.title === 'Standby promoted to hub' && x.state === 'done'), 400);
    assert.deepEqual(t.find((x) => x.title === 'Standby promoted to hub').origin, { kind: 'trigger', ref: 'mesh:auto-failover' });
  } finally {
    if (hubProc) await stop(hubProc);
    if (standbyProc) await stop(standbyProc);
  }
});
