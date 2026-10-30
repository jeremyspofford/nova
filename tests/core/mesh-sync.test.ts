// Hub, standby and sync (M4 plan §3), with two cores in this process talking over real HTTP: the
// sync log and its triggers, the home-file journal, catch-up from nothing and continuous sync,
// forgetting that reaches the standby and its backups, replica mode refusing changes, promotion
// with a roster signed by the standby's own key, fencing, revoked devices staying revoked, and
// automatic failover only when it is turned on. The two-process version with a real SIGKILL is
// tests/acceptance/m4c-failover.test.ts. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCore, loadIdentity, readRole, REPLICATED, verifyRoster, writeRole, type Core, type DeviceKeys, type Listener, type RoleFile,
} from '../../src/core/index.ts';
import { journalPath } from '../../src/core/mesh/sync.ts';
import { Joiner, call, hub } from './mesh-support.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!done(v) && Date.now() < end) { await sleep(25); v = await read(); }
  return v;
}

// A core behind a console listener and a mesh listener, both on loopback.
async function serve(core: Core) {
  const handler = (listener: Listener) => async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://nova.local');
    const p = core.gate(req, res, url, listener);
    if (!p) return;
    if (await core.handle(req, res, url, p, listener)) return;
    res.writeHead(404);
    res.end();
  };
  const listen = async (s: Server) => { await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };
  const c = createServer(handler('console'));
  const m = createServer(handler('mesh'));
  const consoleBase = await listen(c);
  const meshBase = await listen(m);
  return {
    console: consoleBase, mesh: meshBase,
    api: (method: string, path: string, body?: unknown) => call(consoleBase, method, `/api/v1${path}`, body),
    close() { for (const s of [c, m]) { s.closeAllConnections(); s.close(); } },
  };
}

// What Era 2 does when a memory is forgotten: MEMORY.md is written again without it.
function rendersMemory(core: Core, home: string) {
  core.memory.onForget((records) => {
    const file = join(home, 'MEMORY.md');
    if (!existsSync(file)) return;
    let text = readFileSync(file, 'utf8');
    for (const r of records) text = text.split('\n').filter((l) => !l.includes(r.content)).join('\n');
    writeFileSync(file, text);
  });
}

// A hub with a standby enrolled the way the plan says, with the standby's own identity keys, and
// the standby's role file written as the boot agent would.
async function pair(o: { failoverAfterS?: number } = {}) {
  const h = await hub();
  rendersMemory(h.core, h.home);
  const home = mkdtempSync(join(tmpdir(), 'nova-standby-'));
  const id = loadIdentity(home);
  // It enrolls with its own identity keys: the key devices pin for the standby is the one it will
  // sign rosters with once promoted.
  const keys = { ed25519: { publicKey: id.publicKey, privateKey: id.signer() }, x25519: { publicKey: id.x25519PublicKey, privateKey: null } } as unknown as DeviceKeys;
  if (o.failoverAfterS) assert.equal((await h.c('PUT', '/profile/mesh/auto_failover_after_s', { value: o.failoverAfterS })).status, 200);
  const code = (await h.c('POST', '/mesh/pairings')).body.code;
  const dev = new Joiner(h.mesh, h.nowS, { name: 'Standby', platform: 'test', kind: 'standby', capabilities: [], address: 'http://127.0.0.1:1' }, keys);
  assert.equal((await dev.join(code)).status, 201);
  assert.equal((await dev.reveal()).status, 200);
  assert.equal((await h.c('POST', `/mesh/requests/${dev.requestId}/approve`, { confirm: true })).status, 200);
  const polled = await dev.poll();
  assert.equal(polled.body.state, 'approved');
  const signed = polled.body.roster;
  const role: RoleFile = {
    version: 1, role: 'standby', device_id: dev.deviceId, epoch: signed.roster.epoch, roster: signed,
    hub: { id: signed.roster.hub.id, url: h.mesh, public_key: signed.roster.hub.public_key, x25519_public_key: signed.roster.hub.x25519_public_key, name: 'Hub' },
  };
  writeRole(home, role);
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, now: () => new Date(h.clock.t), mesh: { publicUrl: 'http://standby.example:4321', transport: 'network' } });
  rendersMemory(core, home);
  const s = await serve(core);
  // Now the standby's address is known: the hub's registry has it, as the join would have said.
  h.core.db.run('UPDATE device SET address = ? WHERE id = ?', s.console, dev.deviceId);
  return { h, home, core, s, dev };
}

const synced = (p: Awaited<ReturnType<typeof pair>>) => until(() => p.core.mesh.sync.cursor(), (c) => c >= p.h.core.mesh.sync.head());

// Every replicated table's rows, by key, hashed: what "the same data" means.
function tables(dbPath: string): Record<string, Record<string, string>> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const out: Record<string, Record<string, string>> = {};
    for (const [t, keys] of Object.entries(REPLICATED)) {
      out[t] = {};
      for (const r of db.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[]) {
        out[t]![keys.map((k) => String(r[k])).join('|')] = createHash('sha256').update(JSON.stringify(r)).digest('hex');
      }
    }
    return out;
  } finally {
    db.close();
  }
}

function files(home: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(home, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, files(home, r));
    else if (e.isFile()) out[r] = createHash('sha256').update(readFileSync(join(home, r))).digest('hex');
  }
  return out;
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

async function stopPair(p: Awaited<ReturnType<typeof pair>>) {
  p.s.close();
  await p.core.close();
  await p.h.stop();
}

test('the sync log: every replicated table is recorded, one entry per row; local tables are not', async () => {
  const h = await hub();
  try {
    const db = h.core.db;
    const count = (sql: string, ...a: string[]) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_log WHERE ${sql}`, ...a)!.n;
    // A fresh hub already has its builtins, its own device record, and the problem-free rest.
    assert.ok(count(`tbl = 'extension'`) >= 1, 'the built-in design systems are in the log');
    assert.equal(count(`tbl = 'device'`), 1, 'the hub itself');
    h.core.profile.set('user', 'name', 'Sam', 'settings');
    h.core.profile.set('user', 'name', 'Alex', 'settings');
    assert.equal(count(`tbl = 'profile'`), 1, 'one entry per row: the newest');
    assert.match(db.get<{ row: string }>(`SELECT row FROM sync_log WHERE tbl = 'profile'`)!.row, /Alex/);
    const m = h.core.memory.remember({ kind: 'fact', content: 'The spare key is under the blue pot.', recorded_by: 'person' });
    h.core.memory.correct(m.id, 'The spare key is under the green pot.', 'person');
    assert.equal(count(`tbl = 'memory'`), 2);
    assert.ok(count(`tbl = 'memory_event'`) >= 2, 'memory history is replicated');
    const before = db.get<{ s: number }>('SELECT MAX(seq) AS s FROM sync_log')!.s;
    // Pairing codes, join requests, sessions and the node's own state never enter the log.
    await h.c('POST', '/mesh/pairings');
    db.run(`UPDATE mesh_state SET updated_at = 'x'`);
    db.run(`UPDATE sync_state SET acked_at = 'x'`);
    assert.equal(db.get<{ s: number }>('SELECT MAX(seq) AS s FROM sync_log')!.s, before);
    assert.equal(count(`tbl IN ('pairing', 'join_request', 'device_session', 'mesh_state', 'sync_state', 'sync_log')`), 0);
    // Every replicated table has its triggers.
    const triggers = new Set(db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).map((r) => r.name));
    for (const t of Object.keys(REPLICATED)) for (const w of ['insert', 'update', 'delete']) assert.ok(triggers.has(`sync_${t}_${w}`), `${t} ${w}`);
    for (const r of db.all<{ hlc: string }>('SELECT hlc FROM sync_log')) assert.match(r.hlc, /^\d{15}-[0-9a-f]{4}-[A-Za-z0-9._:-]+$/);
    // Deleting a row leaves a delete, and nothing of what it said.
    h.core.memory.forget(m.id);
    assert.equal(count(`tbl = 'memory' AND op = 'put'`), 0);
    assert.equal(count(`tbl = 'memory' AND op = 'delete'`), 2);
    assert.equal(count(`instr(row, 'pot') > 0`), 0);
  } finally {
    await h.stop();
  }
});

test('migration 0006 puts what was already there into the log', () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-backfill-'));
  const db = new DatabaseSync(join(home, 'x.db'));
  for (const f of readdirSync(join(import.meta.dirname, '../../src/core/migrations')).sort()) {
    if (f.startsWith('0006')) {
      db.exec(`INSERT INTO profile VALUES ('user', 'name', '"Sam"', 'setup', 't')`);
      db.exec(`INSERT INTO memory_event (at, kind, memory_id, by) VALUES ('t', 'remembered', 'm1', 'person')`);
    }
    db.exec(readFileSync(join(import.meta.dirname, '../../src/core/migrations', f), 'utf8'));
  }
  const rows = db.prepare('SELECT tbl, pk, op FROM sync_log ORDER BY seq').all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ tbl: 'profile', pk: '["user","name"]', op: 'put' }, { tbl: 'memory_event', pk: '1', op: 'put' }]);
  db.close();
});

test('the journal: the person’s files go in the log, local state stays out, and paths can’t escape', async () => {
  const h = await hub();
  try {
    const put = (rel: string, text: string) => { mkdirSync(join(h.home, rel, '..'), { recursive: true }); writeFileSync(join(h.home, rel), text); };
    put('workspace/notes/plan.md', '# Plan\n');
    put('sessions/s1.jsonl', '{"type":"session"}\n');
    put('schedules/morning.md', '---\nname: Morning\n---\n');
    put('skills/example/SKILL.md', 'An example skill.\n');
    put('MEMORY.md', '# Memory\n');
    put('workspace/photo.bin', '');
    writeFileSync(join(h.home, 'workspace/photo.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x01]));
    put('connectors/gmail/token.json', '{"secret":"placeholder"}');
    put('logs/extra.log', 'x');
    put('backups/old.db', 'x');
    const s = h.core.mesh.sync.scan();
    for (const f of ['workspace/notes/plan.md', 'sessions/s1.jsonl', 'schedules/morning.md', 'skills/example/SKILL.md', 'MEMORY.md', 'workspace/photo.bin']) assert.ok(s.put.includes(f), f);
    for (const f of s.put) assert.ok(!/^(connectors|logs|backups|mesh|\.git)\/|^nova\.db/.test(f), `${f} stays local`);
    assert.deepEqual(h.core.mesh.sync.scan(), { put: [], deleted: [] }, 'nothing changed, nothing recorded');
    put('workspace/notes/plan.md', '# Plan\n\n- one\n');
    assert.deepEqual(h.core.mesh.sync.scan().put, ['workspace/notes/plan.md']);
    const { rmSync } = await import('node:fs');
    rmSync(join(h.home, 'sessions/s1.jsonl'));
    assert.deepEqual(h.core.mesh.sync.scan().deleted, ['sessions/s1.jsonl']);
    const binary = JSON.parse(h.core.db.get<{ row: string }>(`SELECT row FROM sync_log WHERE pk = 'workspace/photo.bin'`)!.row);
    assert.ok(binary.b64 && !binary.text, 'binary files travel as base64');
    for (const bad of ['../x', '/etc/passwd', 'a/../../x', 'mesh/identity.json', 'nova.db', 'nova.db-wal', 'logs/a', 'connectors/x', '.git/config', 'a//b', './a', 'a\\b', '']) assert.equal(journalPath(bad), null, bad);
    assert.equal(journalPath('workspace/a.md'), 'workspace/a.md');
  } finally {
    await h.stop();
  }
});

test('role.json: the documented shape, the tolerated variants, and a plain refusal when it can’t say who the hub is', () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-role-'));
  const hubKeys = { id: 'hub-1', url: 'https://hub.example:4320', public_key: 'k', x25519_public_key: 'x' };
  mkdirSync(join(home, 'mesh'));
  writeFileSync(join(home, 'mesh/role.json'), JSON.stringify({ role: 'standby', id: 'dev-1', roster: { roster: { epoch: 3, hub: hubKeys, issued_at: 't' }, signature: 's' }, extra: true }));
  const r = readRole(home)!;
  assert.equal(r.device_id, 'dev-1');
  assert.equal(r.epoch, 3);
  assert.deepEqual(r.hub, hubKeys);
  writeFileSync(join(home, 'mesh/role.json'), JSON.stringify({ role: 'standby', device_id: 'dev-1', hub_url: 'https://hub.example:4320/', hub: { id: 'hub-1', public_key: 'k', x25519_public_key: 'x' } }));
  assert.equal(readRole(home)!.hub.url, 'https://hub.example:4320');
  assert.equal(readRole(home)!.epoch, 1);
  writeFileSync(join(home, 'mesh/role.json'), JSON.stringify({ role: 'standby', device_id: 'dev-1' }));
  assert.throws(() => readRole(home), /missing hub\.id, hub\.url, hub\.public_key, hub\.x25519_public_key/);
  assert.equal(readRole(mkdtempSync(join(tmpdir(), 'nova-role-'))), null);
});

test('a standby catches up from nothing, keeps up, refuses changes, and gets forgetting right, backups included', async () => {
  const p = await pair();
  const { h, core } = p;
  try {
    // Before it starts: data of every kind on the hub.
    h.core.profile.set('user', 'name', 'Sam', 'settings');
    const m = h.core.memory.remember({ kind: 'preference', content: 'Prefers window seats.', recorded_by: 'person' });
    h.core.memory.correct(m.id, 'Prefers aisle seats.', 'person');
    const rule = h.core.triggers.createRule({ name: 'Stretch', class: 'proactive', action: { kind: 'message', text: 'Time to stretch.' } } as never, 'person').rule;
    await h.core.triggers.fireRule(rule.id, {});
    h.core.log.problem('test', 'A placeholder problem.');
    h.core.receipts.record({ task_id: null, session_id: 's1', provider: 'local', model: 'placeholder', purpose: 'chat', privacy_mode: 'local-only', egress: 'local', context_items: [] } as never);
    const t = h.core.ledger.create({ title: 'Save a list', owner: 'workspace', goal: 'Saved.', origin: { kind: 'user' }, evidence_required: [{ kind: 'read_back', target: 'workspace:lists/a.md' }], inputs: { action: 'write', path: 'lists/a.md', content: '- bread\n' } });
    await h.core.ledger.idle();
    assert.equal(h.core.ledger.get(t.id).state, 'done');
    mkdirSync(join(h.home, 'sessions'), { recursive: true });
    writeFileSync(join(h.home, 'sessions/s1.jsonl'), '{"type":"user","text":"hello"}\n');
    writeFileSync(join(h.home, 'connectors.txt'), 'a file at the top is the person’s too\n');
    mkdirSync(join(h.home, 'connectors/gmail'), { recursive: true });
    writeFileSync(join(h.home, 'connectors/gmail/token.json'), '{"placeholder":"secret"}');
    h.core.mesh.sync.scan();

    assert.equal(core.mesh.role.role(), 'standby');
    assert.equal(core.mesh.sync.logging(), false);
    assert.equal(core.mesh.identity.id, p.dev.deviceId, 'the standby is the same record on both nodes');
    core.start();
    await synced(p);
    assert.deepEqual(tables(join(p.home, 'nova.db')), tables(join(h.home, 'nova.db')), 'every replicated table is the same');
    const hubFiles = files(h.home);
    const mine = files(p.home);
    for (const [f, sha] of Object.entries(hubFiles)) {
      if (journalPath(f)) assert.equal(mine[f], sha, f);
    }
    assert.ok(!existsSync(join(p.home, 'connectors/gmail/token.json')), 'connector secrets stay on the hub');
    assert.notEqual(readFileSync(join(p.home, 'mesh/identity.json'), 'utf8'), readFileSync(join(h.home, 'mesh/identity.json'), 'utf8'));
    const hubLog = h.core.db.all<{ seq: number; pk: string }>('SELECT seq, pk FROM sync_log ORDER BY seq');
    assert.deepEqual(core.db.all<{ seq: number; pk: string }>('SELECT seq, pk FROM sync_log ORDER BY seq').map((r) => ({ ...r })), hubLog.map((r) => ({ ...r })), 'the hub’s seq is kept');

    // Continuous: a change on the hub arrives without asking.
    h.core.profile.set('user', 'timezone', 'UTC', 'settings');
    writeFileSync(join(h.home, 'workspace/later.md'), 'later\n');
    h.core.mesh.sync.scan();
    await synced(p);
    assert.equal(core.profile.get('user', 'timezone'), 'UTC');
    assert.equal(readFileSync(join(p.home, 'workspace/later.md'), 'utf8'), 'later\n');
    const lag = (await h.c('GET', '/health')).body.checks.mesh.standby;
    assert.equal(lag.id, p.dev.deviceId);
    assert.equal(lag.lag.rows, 0, 'the hub sees the standby caught up');

    // Replica mode: reads are served, changes refused with the reason.
    assert.equal((await p.s.api('GET', '/tasks')).status, 200);
    const refused = await p.s.api('POST', '/memory', { kind: 'fact', content: 'x' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /^This is the standby; “Hub” at http:\/\/127\.0\.0\.1:\d+ is the hub\.$/);
    assert.equal((await p.s.api('PUT', '/profile/user/name', { value: 'x' })).status, 409);
    const st = (await p.s.api('GET', '/mesh/status')).body;
    assert.equal(st.role, 'standby');
    assert.match(st.replica.reason, /This is the standby/);
    assert.equal(core.ledger.list().find((x) => x.id === t.id)?.state, 'done', 'tasks are readable on the standby');

    // Forgetting: the words, in a memory, in MEMORY.md, and in a backup the standby already had.
    const words = 'Locker combination 7319 behind the quartz panel';
    const secret = h.core.memory.remember({ kind: 'fact', content: words, recorded_by: 'person' });
    writeFileSync(join(h.home, 'MEMORY.md'), `# Memory\n\n- ${words}\n- Prefers aisle seats.\n`);
    h.core.mesh.sync.scan();
    await synced(p);
    assert.equal(core.memory.get(secret.id).content, words);
    mkdirSync(join(p.home, 'backups'), { recursive: true });
    new DatabaseSync(join(p.home, 'nova.db')).exec(`VACUUM INTO '${join(p.home, 'backups', 'nova-2026-10-29T09-00-00-000Z-v5.db')}'`);
    assert.ok(readFileSync(join(p.home, 'backups', 'nova-2026-10-29T09-00-00-000Z-v5.db')).toString('latin1').includes(words), 'the backup holds the words before');
    h.core.memory.forget(secret.id);
    await synced(p);
    assert.throws(() => core.memory.get(secret.id), /no memory/);
    assert.ok(core.memory.events(secret.id).some((e) => e.kind === 'forgotten'), 'the hub’s record of the forget arrived');
    for (const node of [p.home, h.home]) {
      const hits = everything(node).filter((f) => f.text.includes(words) || f.text.includes('quartz panel')).map((f) => f.path);
      assert.deepEqual(hits, [], `nothing under ${node} still holds the words`);
    }
    assert.ok(readFileSync(join(p.home, 'MEMORY.md'), 'utf8').includes('Prefers aisle seats.'), 'the rest of MEMORY.md is still there');
  } finally {
    await stopPair(p);
  }
});

test('promotion: a new epoch, a roster signed by the standby’s own key, a verified ledger record; the old hub fences itself; revoked stays revoked', async () => {
  const p = await pair();
  const { h, core } = p;
  try {
    // A phone, then revoked on the hub.
    const code = (await h.c('POST', '/mesh/pairings')).body.code;
    const phone = new Joiner(h.mesh, h.nowS);
    await phone.join(code);
    await phone.reveal();
    await h.c('POST', `/mesh/requests/${phone.requestId}/approve`, { confirm: true });
    await phone.poll();
    assert.equal((await h.c('POST', `/mesh/devices/${phone.deviceId}/revoke`, { confirm: true })).status, 200);
    core.start();
    await synced(p);
    assert.equal(core.mesh.devices.get(phone.deviceId).trust, 'revoked');

    // Promotion is tier 3, and only on the standby.
    assert.equal((await p.s.api('POST', '/mesh/promote', {})).status, 400);
    assert.equal((await h.c('POST', '/mesh/promote', { confirm: true })).status, 409, 'the hub is already hub');
    const pinned = h.core.mesh.devices.get(p.dev.deviceId).public_key;
    const oldHubId = h.core.mesh.identity.id;
    await h.stop(); // the hub is gone
    const r = await p.s.api('POST', '/mesh/promote', { confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.epoch, 2);
    assert.equal(core.mesh.role.role(), 'hub');
    assert.equal(core.mesh.sync.logging(), true);
    assert.ok(verifyRoster(r.body.roster, [core.mesh.identity.publicKey]), 'signed with the standby’s own key');
    assert.equal(r.body.roster.roster.hub.id, p.dev.deviceId);
    assert.equal(r.body.roster.roster.hub.public_key, pinned, 'the key devices pinned for the standby');
    const task = r.body.task;
    assert.equal(task.title, 'Standby promoted to hub');
    assert.equal(task.state, 'done', task.reason);
    assert.equal(task.verification.checks[0].evidence.kind, 'confirmation');
    assert.match(task.verification.checks[0].why, /hub at epoch 2/);
    assert.equal(readRole(p.home)!.role, 'hub');
    assert.equal((await p.s.api('POST', '/memory', { kind: 'fact', content: 'Now it takes changes.' })).status, 201);
    assert.ok(core.mesh.sync.head() > 0);
    const hello = (await call(p.s.mesh, 'GET', '/api/v1/mesh/hello')).body;
    assert.deepEqual([hello.role, hello.epoch, hello.roster.roster.epoch], ['hub', 2, 2]);
    assert.equal(core.mesh.devices.get(oldHubId).role, 'spoke', 'the old hub is just a computer now');

    // No orphaned trust: the revoked phone can't start a session with the new hub.
    const s = await phone.session({ base: p.s.mesh });
    assert.equal(s.status, 401);

    // The old hub comes back and asks its peers: it finds a higher epoch and steps down.
    const old = createCore({ home: h.home, version: '0.1.0', trustedOrigin: () => true, now: () => new Date(h.clock.t), mesh: { publicUrl: 'http://hub.example:4320', transport: 'network' } });
    const os = await serve(old);
    try {
      old.db.run(`INSERT INTO device_session (token_hash, device_id, created_at, expires_at) VALUES ('h', ?, 't', '9999')`, p.dev.deviceId);
      const f = await old.mesh.role.fence();
      assert.equal(f.demoted, true, JSON.stringify(f));
      assert.equal(old.mesh.role.role(), 'standby');
      assert.equal(old.mesh.sync.logging(), false);
      assert.equal(old.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM device_session')!.n, 0, 'its sessions ended');
      const w = await os.api('POST', '/memory', { kind: 'fact', content: 'x' });
      assert.equal(w.status, 409);
      assert.match(w.body.error, /isn’t the hub any more: “Standby” .* became the hub \(epoch 2\)/);
      assert.equal((await os.api('POST', '/mesh/promote', { confirm: true })).status, 409, 'a hub that stepped down can’t take the role back');
      assert.equal((await call(os.mesh, 'GET', '/api/v1/mesh/hello')).body.role, 'standby');
      assert.ok(old.log.problems().some((x) => /stepped down so there is only one hub/.test(x.message)));
      // Restarted again, it stays fenced.
      os.close();
      await old.close();
      const again = createCore({ home: h.home, version: '0.1.0', trustedOrigin: () => true, now: () => new Date(h.clock.t) });
      assert.equal(again.mesh.role.role(), 'standby');
      assert.equal(again.start().requeued.length, 0);
      await again.close();
    } finally {
      os.close();
    }
  } finally {
    p.s.close();
    await core.close();
  }
});

test('a forged higher epoch doesn’t make a hub step down', async () => {
  const h = await hub();
  const liar = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'someone', role: 'hub', epoch: 99, roster: { roster: { epoch: 99, hub: { id: 'someone', url: null, public_key: 'x', x25519_public_key: 'y' }, issued_at: 't' }, signature: 'z' } }));
  });
  await new Promise<void>((r) => liar.listen(0, '127.0.0.1', r));
  try {
    const { dev } = await import('./mesh-support.ts').then((m) => m.enroll(h, { kind: 'standby', name: 'Standby', address: `http://127.0.0.1:${(liar.address() as AddressInfo).port}` }));
    assert.ok(dev.deviceId);
    const f = await h.core.mesh.role.fence();
    assert.equal(f.demoted, false);
    assert.equal(f.checked.length, 1);
    assert.equal(h.core.mesh.role.role(), 'hub');
  } finally {
    liar.close();
    await h.stop();
  }
});

test('automatic failover: only when turned on, and only after the hub has been unreachable that long', async () => {
  const off = await pair();
  try {
    off.core.start();
    await synced(off);
    await off.h.stop();
    await sleep(2500);
    assert.equal(off.core.mesh.role.role(), 'standby', 'off by default: the standby waits for the person');
    assert.ok(off.core.mesh.role.status().replica!.sync!.unreachable_since);
  } finally {
    off.s.close();
    await off.core.close();
  }
  const on = await pair({ failoverAfterS: 1 });
  try {
    on.core.start();
    await synced(on);
    assert.equal(on.core.profile.get('mesh', 'auto_failover_after_s'), 1, 'the setting came over from the hub');
    assert.equal(on.core.mesh.role.role(), 'standby');
    await on.h.stop();
    await until(() => on.core.mesh.role.role(), (r) => r === 'hub', 10_000);
    assert.equal(on.core.mesh.role.role(), 'hub');
    const t = await until(() => on.core.ledger.list().find((x) => x.title === 'Standby promoted to hub'), (x) => x?.state === 'done');
    assert.deepEqual(t!.origin, { kind: 'trigger', ref: 'mesh:auto-failover' });
    assert.ok(on.core.log.problems().some((x) => /making itself the hub/.test(x.message)));
  } finally {
    on.s.close();
    await on.core.close();
  }
});

test('the failover setting is checked', async () => {
  const h = await hub();
  try {
    assert.equal((await h.c('PUT', '/profile/mesh/auto_failover_after_s', { value: 0 })).status, 400);
    assert.equal((await h.c('PUT', '/profile/mesh/auto_failover_after_s', { value: 'soon' })).status, 400);
    assert.equal((await h.c('PUT', '/profile/mesh/other', { value: 1 })).status, 400);
    assert.equal((await h.c('PUT', '/profile/mesh/auto_failover_after_s', { value: 120 })).status, 200);
    assert.equal((await h.c('PUT', '/profile/mesh/auto_failover_after_s', { value: null })).status, 200);
  } finally {
    await h.stop();
  }
});

test('only the standby may pull the log, and what it gets is sealed to it', async () => {
  const p = await pair();
  try {
    const { token: phoneToken } = await import('./mesh-support.ts').then((m) => m.enroll(p.h));
    const asPhone = await call(p.h.mesh, 'GET', '/api/v1/mesh/sync?after=0', undefined, { authorization: `Bearer ${phoneToken}` });
    assert.equal(asPhone.status, 403);
    assert.equal((await call(p.h.mesh, 'GET', '/api/v1/mesh/sync?after=0')).status, 401);
    // Pulled as the standby by hand: a box that opens only with the standby's key.
    p.h.core.profile.set('user', 'name', 'wire-check-placeholder', 'settings');
    const id = loadIdentity(p.home);
    const time = p.h.nowS();
    const { sessionMessage } = await import('../../src/core/index.ts');
    const s = await call(p.h.mesh, 'POST', '/api/v1/mesh/session', { device_id: p.dev.deviceId, time, signature: id.sign(sessionMessage(p.dev.deviceId, time)) });
    const r = await call(p.h.mesh, 'GET', '/api/v1/mesh/sync?after=0&wait=0', undefined, { authorization: `Bearer ${s.body.token}` });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['epoch', 'hub_id', 'sealed']);
    assert.ok(!JSON.stringify(r.body).includes('wire-check-placeholder'), 'nothing readable on the wire');
    const { SYNC_AAD } = await import('../../src/core/mesh/replica.ts');
    const payload = JSON.parse(id.open(p.h.core.mesh.identity.x25519PublicKey, Buffer.from(r.body.sealed, 'base64url'), SYNC_AAD(p.dev.deviceId, 0)).toString());
    assert.ok(payload.rows.some((x: { row: string | null }) => x.row?.includes('wire-check-placeholder')), 'the box carries the rows');
    assert.throws(() => id.open(p.h.core.mesh.identity.x25519PublicKey, Buffer.from(r.body.sealed, 'base64url'), SYNC_AAD(p.dev.deviceId, 1)), 'bound to the cursor it answers');
    // The standby's lag shows on the hub once it acknowledges, and a new standby starts from zero.
    const ack = await call(p.h.mesh, 'POST', '/api/v1/mesh/sync/ack', { seq: payload.upto }, { authorization: `Bearer ${s.body.token}` });
    assert.equal(ack.status, 200);
    assert.equal(ack.body.acked_seq, payload.upto);
  } finally {
    await stopPair(p);
  }
});

test('a standby that falls behind is a problem on the hub', async () => {
  const p = await pair();
  try {
    // Never started, so it acknowledged nothing; within the first minute that is not "behind".
    p.h.core.profile.set('user', 'name', 'Sam', 'settings');
    assert.equal(p.h.core.mesh.role.lag().behind, false);
    p.h.core.mesh.role.checkLag();
    assert.ok(!p.h.core.log.problems().some((x) => /fallen behind/.test(x.message)));
    p.h.tick(5 * 60_000);
    assert.equal(p.h.core.mesh.role.lag().behind, true);
    p.h.core.mesh.role.checkLag();
    p.h.core.mesh.role.checkLag();
    assert.equal(p.h.core.log.problems().filter((x) => /The standby “Standby” has fallen behind/.test(x.message)).length, 1, 'one problem, not one per check');
    const health = (await p.h.c('GET', '/health')).body.checks.mesh;
    assert.equal(health.standby.lag.behind, true);
    assert.ok(health.standby.lag.rows > 0);
    // Once it catches up, the next time it falls behind is a new problem.
    p.core.start();
    await synced(p);
    await until(() => p.h.core.mesh.role.lag().rows, (n) => n === 0);
    p.h.core.mesh.role.checkLag();
    assert.equal(p.h.core.db.get<{ b: string | null }>('SELECT behind_since AS b FROM sync_state')!.b, null);
  } finally {
    await stopPair(p);
  }
});
