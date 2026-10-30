// The hub's side of a computer's device agent (M4 plan §2): heartbeat → Online, the inbox and its
// conflict rules, exactly-once by key, who may call what, the signed runtime bundle, the challenge
// a node answers, and the installer and archive. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { helloProofMessage, runtimeManifest, runtimeManifestMessage, verifyDeviceSignature } from '../../src/core/index.ts';
import { call, enroll, hub } from './mesh-support.ts';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test('a heartbeat marks the computer Online, records its versions, and reports safe mode once', async () => {
  const h = await hub();
  try {
    const { dev, token } = await enroll(h, { kind: 'computer', name: 'Test computer' });
    const view = async () => (await h.c('GET', '/mesh/devices')).body.find((d: { id: string }) => d.id === dev.deviceId);
    h.tick(10 * 60_000);
    assert.equal((await view()).online, false, 'not heard from for ten minutes: Offline');
    const hb = await call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { capabilities: ['heartbeat', 'queue'], version: '0.1.0', runtime_version: 'r1', safe_mode: false }, bearer(token));
    assert.equal(hb.status, 200, JSON.stringify(hb.body));
    assert.equal(hb.body.epoch, 1);
    assert.match(hb.body.runtime.version, /^0\.1\.0\+[0-9a-f]{12}$/);
    let v = await view();
    assert.equal(v.online, true);
    assert.deepEqual(v.capabilities, ['heartbeat', 'queue']);
    assert.equal(v.agent.runtime_version, 'r1');
    assert.equal(v.agent.safe_mode, false);
    h.tick(3 * 60_000);
    assert.equal((await view()).online, false, 'a missed heartbeat window: Offline again');

    // Safe mode: one problem, however many heartbeats say so.
    for (let i = 0; i < 3; i++) assert.equal((await call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { safe_mode: true }, bearer(token))).status, 200);
    v = await view();
    assert.equal(v.agent.safe_mode, true);
    assert.equal(v.online, true);
    const problems = (await h.c('GET', '/problems?open=1')).body.filter((p: { message: string }) => /safe mode/.test(p.message));
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /Test computer/);

    // Bad capabilities are refused.
    assert.equal((await call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { capabilities: ['Not A Name!'] }, bearer(token))).status, 400);
  } finally {
    await h.stop();
  }
});

test('device routes: only a computer’s session; a phone is forbidden, no session is 401, the console is told it isn’t a device', async () => {
  const h = await hub();
  try {
    const { token: phone } = await enroll(h, { kind: 'phone' });
    const { token: computer } = await enroll(h, { kind: 'computer' });
    const item = { items: [{ key: 'k-00000001', kind: 'event', body: { name: 'started' } }] };
    for (const [method, path, body] of [['POST', '/api/v1/mesh/devices/me/heartbeat', {}], ['POST', '/api/v1/mesh/inbox', item], ['GET', '/api/v1/mesh/runtime', undefined]] as const) {
      assert.equal((await call(h.mesh, method, path, body)).status, 401, `${path} without a session`);
      assert.equal((await call(h.mesh, method, path, body, bearer(phone))).status, 403, `${path} from a phone`);
      assert.equal((await call(h.mesh, method, path, body, bearer(computer))).status, 200, `${path} from a computer`);
    }
    // The computer can't use the person's routes.
    assert.equal((await call(h.mesh, 'GET', '/api/v1/tasks', undefined, bearer(computer))).status, 403);
    assert.equal((await call(h.mesh, 'GET', '/api/v1/mesh/inbox/refusals', undefined, bearer(computer))).status, 403);
    // The console may read the runtime, but isn't a device agent.
    assert.equal((await h.c('POST', '/mesh/devices/me/heartbeat', {})).status, 403);
    // X-Nova is needed on every change, devices included.
    assert.equal((await call(h.mesh, 'POST', '/api/v1/mesh/inbox', item, { ...bearer(computer), 'x-nova': '' })).status, 403);
  } finally {
    await h.stop();
  }
});

test('the inbox takes each key exactly once, in order, and keeps what each item became', async () => {
  const h = await hub();
  try {
    const { dev, token } = await enroll(h, { kind: 'computer', name: 'Test computer' });
    const send = (items: unknown[]) => call(h.mesh, 'POST', '/api/v1/mesh/inbox', { items }, bearer(token));
    const task = { title: 'Write the test note', owner: 'workspace', goal: 'A note exists in the workspace.', evidence_required: [{ kind: 'read_back', target: 'notes/test.md' }], inputs: { path: 'notes/test.md', content: 'hello' } };
    const items = [
      { key: 'evt-00000001', kind: 'event', body: { name: 'woke', data: { battery: 80 } }, created_at: '2026-10-29T09:00:00.000Z' },
      { key: 'task-0000001', kind: 'task_request', body: task },
      { key: 'mem-00000001', kind: 'memory_note', body: { content: 'The test plant needs water on Fridays.' } },
      { key: 'task-0000002', kind: 'task_request', body: { title: 'No worker named' } },
      { key: 'odd-00000001', kind: 'teleport', body: {} },
    ];
    const first = await send(items);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const r = first.body.results;
    assert.deepEqual(r.map((x: { key: string }) => x.key), items.map((i) => i.key), 'answered in order');
    assert.deepEqual(r.map((x: { status: string }) => x.status), ['accepted', 'accepted', 'accepted', 'refused', 'refused']);
    assert.ok(r.every((x: { duplicate: boolean }) => x.duplicate === false));

    // The task is in the ledger, from this device; the memory has the device's provenance.
    const t = (await h.c('GET', `/tasks/${r[1].ref}`)).body;
    assert.equal(t.title, 'Write the test note');
    assert.deepEqual(t.origin, { kind: 'device', ref: dev.deviceId });
    const m = (await h.c('GET', '/memory')).body.find((x: { id: string }) => x.id === r[2].ref);
    assert.equal(m.recorded_by, `device:${dev.deviceId}`);
    assert.equal(m.user_state, 'unreviewed');
    // The refusal is kept with its reason and the request itself: a ledger entry is never lost.
    assert.match(r[3].reason, /worker/);
    const refusals = (await h.c('GET', `/mesh/inbox/refusals?device=${dev.deviceId}`)).body;
    assert.equal(refusals.find((x: { key: string }) => x.key === 'task-0000002').body.title, 'No worker named');
    assert.ok((await h.c('GET', '/problems?open=1')).body.some((p: { message: string }) => /asked for by “Test computer” wasn’t created/.test(p.message)));

    // The same keys again (the reply was lost): the same answers, marked duplicate, nothing twice.
    const again = await send(items);
    assert.deepEqual(again.body.results.map((x: { status: string; duplicate: boolean; ref?: string }) => [x.status, x.duplicate, x.ref]), r.map((x: { status: string; ref?: string }) => [x.status, true, x.ref]));
    const tasks = (await h.c('GET', '/tasks?limit=500')).body.filter((x: { title: string }) => x.title === 'Write the test note');
    assert.equal(tasks.length, 1);
    const mems = (await h.c('GET', '/memory')).body.filter((x: { content: string }) => x.content === 'The test plant needs water on Fridays.');
    assert.equal(mems.length, 1);

    // Forgetting the memory leaves nothing of its words in the inbox.
    assert.equal((await h.c('DELETE', `/memory/${r[2].ref}`)).status, 200);
    const raw = h.core.db.all<{ body: string | null }>('SELECT body FROM device_inbox');
    assert.ok(raw.every((x) => !String(x.body ?? '').includes('plant')), 'no memory words kept by the inbox');

    // Malformed batches are refused whole.
    assert.equal((await send([])).status, 400);
    assert.equal((await send([{ key: 'short', kind: 'event', body: {} }])).status, 400);
    assert.equal((await send(Array.from({ length: 101 }, (_, i) => ({ key: `bulk-${String(i).padStart(6, '0')}`, kind: 'event', body: { name: 'x' } })))).status, 400);

    // Another device's keys are its own.
    const other = await enroll(h, { kind: 'computer', name: 'Second computer' });
    const theirs = await call(h.mesh, 'POST', '/api/v1/mesh/inbox', { items: [items[0]] }, bearer(other.token));
    assert.equal(theirs.body.results[0].duplicate, false);
  } finally {
    await h.stop();
  }
});

test('a task request that fails part-way is refused, and leaves no task behind', async () => {
  const h = await hub();
  try {
    const { token } = await enroll(h, { kind: 'computer', name: 'Test computer' });
    // The task is created, then what follows it (the reactive triggers) fails.
    const triggers = h.core.triggers as unknown as { reactive: (...a: unknown[]) => unknown };
    triggers.reactive = () => { throw new Error('placeholder failure'); };
    const task = { title: 'Half-made placeholder task', owner: 'workspace', goal: 'A note exists.', evidence_required: [{ kind: 'read_back', target: 'notes/half.md' }], inputs: { path: 'notes/half.md', content: 'x' } };
    const r = await call(h.mesh, 'POST', '/api/v1/mesh/inbox', { items: [{ key: 'half-0000001', kind: 'task_request', body: task }] }, bearer(token));
    assert.equal(r.body.results[0].status, 'refused');
    const tasks = h.core.db.all<{ id: string }>("SELECT id FROM task WHERE title = 'Half-made placeholder task'");
    assert.deepEqual(tasks, [], 'the inbox says refused, so there is no task either');
  } finally {
    await h.stop();
  }
});

test('config from a device is server-wins: a stale base version is rejected and reported; privacy stays with the person', async () => {
  const h = await hub();
  try {
    const { token } = await enroll(h, { kind: 'computer', name: 'Test computer' });
    const send = (key: string, body: unknown) => call(h.mesh, 'POST', '/api/v1/mesh/inbox', { items: [{ key, kind: 'config_change', body }] }, bearer(token));
    const read = () => call(h.mesh, 'GET', '/api/v1/mesh/config/tuning/verbosity', undefined, bearer(token));
    assert.deepEqual((await read()).body, { section: 'tuning', key: 'verbosity', value: null, version: null });
    const a = await send('cfg-00000001', { section: 'tuning', key: 'verbosity', value: 'brief', base_version: null });
    assert.equal(a.body.results[0].status, 'accepted', JSON.stringify(a.body));
    const v1 = (await read()).body;
    assert.equal(v1.value, 'brief');
    assert.equal(a.body.results[0].version, v1.version);

    // The person changes it on the hub; then a change the device made offline, against v1, arrives.
    h.tick(1000);
    assert.equal((await h.c('PUT', '/profile/tuning/verbosity', { value: 'detailed' })).status, 200);
    const stale = await send('cfg-00000002', { section: 'tuning', key: 'verbosity', value: 'chatty', base_version: v1.version });
    assert.equal(stale.body.results[0].status, 'rejected');
    assert.match(stale.body.results[0].reason, /hub’s value stands/);
    assert.equal((await h.c('GET', '/profile')).body.tuning.verbosity, 'detailed', 'the hub’s value stands');
    assert.ok((await h.c('GET', '/problems?open=1')).body.some((p: { message: string }) => /older than the hub’s and wasn’t applied/.test(p.message)));

    // Against the current version it applies.
    const fresh = await send('cfg-00000003', { section: 'tuning', key: 'verbosity', value: 'chatty', base_version: (await read()).body.version });
    assert.equal(fresh.body.results[0].status, 'accepted');
    assert.equal((await h.c('GET', '/profile')).body.tuning.verbosity, 'chatty');

    for (const section of ['privacy', 'appearance', 'setup']) {
      const r = await send(`cfg-${section}-0001`, { section, key: 'default', value: 'cloud-ok', base_version: null });
      assert.equal(r.body.results[0].status, 'refused', section);
    }
    assert.equal((await send('cfg-00000009', { section: 'tuning', key: 'verbosity', value: 'x' })).body.results[0].status, 'refused', 'base_version is required');
  } finally {
    await h.stop();
  }
});

test('a computer reads only the settings it may change: never the setup conversation, privacy or appearance', async () => {
  const h = await hub();
  try {
    const { token } = await enroll(h, { kind: 'computer', name: 'Test computer' });
    h.core.profile.set('setup', 'state', { transcript: [{ from: 'person', text: 'Example Person lives at the example address.' }] }, 'setup');
    h.core.profile.set('privacy', 'default', 'local-only', 'settings');
    h.core.profile.set('appearance', 'mode', 'dark', 'settings');
    const read = (section: string, key: string) => call(h.mesh, 'GET', `/api/v1/mesh/config/${section}/${key}`, undefined, bearer(token));
    for (const [section, key] of [['setup', 'state'], ['privacy', 'default'], ['appearance', 'mode'], ['mesh', 'auto_failover_after_s'], ['nope', 'x']]) {
      const r = await read(section!, key!);
      assert.equal(r.status, 403, `${section}/${key}`);
      assert.doesNotMatch(JSON.stringify(r.body), /Example Person|local-only|dark/);
    }
    assert.equal((await read('tuning', 'Not%20a%20key')).status, 403, 'keys as the inbox takes them');
    assert.equal((await read('tuning', 'verbosity')).status, 200);
    assert.equal((await read('user', 'timezone')).status, 200);
  } finally {
    await h.stop();
  }
});

test('the runtime bundle is signed by this node and matches its files; the challenge is answered with the node’s key', async () => {
  const h = await hub();
  try {
    const { token } = await enroll(h, { kind: 'computer' });
    const b = (await call(h.mesh, 'GET', '/api/v1/mesh/runtime', undefined, bearer(token))).body;
    assert.equal(b.signer, h.core.mesh.identity.publicKey);
    assert.ok(verifyDeviceSignature(b.signer, runtimeManifestMessage(b.manifest), b.signature));
    const files = Object.fromEntries(Object.entries(b.files as Record<string, string>).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
    assert.deepEqual(Object.keys(files).sort(), ['queue.ts', 'runtime.ts']);
    assert.equal(runtimeManifest('', files).sha256, b.manifest.sha256);
    assert.equal(files['runtime.ts']!.toString(), readFileSync(join(import.meta.dirname, '../../src/device/runtime.ts'), 'utf8'));

    const challenge = 'c'.repeat(32);
    const p = (await call(h.mesh, 'GET', `/api/v1/mesh/hello/proof?challenge=${challenge}`)).body;
    assert.deepEqual([p.role, p.epoch, p.public_key, p.id], ['hub', 1, h.core.mesh.identity.publicKey, h.core.mesh.identity.id]);
    assert.ok(verifyDeviceSignature(p.public_key, helloProofMessage(challenge, { id: p.id, role: p.role, epoch: p.epoch, public_key: p.public_key }), p.signature));
    assert.ok(!verifyDeviceSignature(p.public_key, helloProofMessage('d'.repeat(32), { id: p.id, role: p.role, epoch: p.epoch, public_key: p.public_key }), p.signature));
    assert.equal((await call(h.mesh, 'GET', '/api/v1/mesh/hello/proof?challenge=short')).status, 400);

    // A report from the agent is a problem, once.
    for (let i = 0; i < 2; i++) assert.equal((await call(h.mesh, 'POST', '/api/v1/mesh/devices/me/report', { problem: 'runtime_update_refused', detail: 'Its signature doesn’t match its manifest.' }, bearer(token))).status, 200);
    assert.equal((await h.c('GET', '/problems?open=1')).body.filter((x: { message: string }) => /refused a runtime update/.test(x.message)).length, 1);
    assert.equal((await call(h.mesh, 'POST', '/api/v1/mesh/devices/me/report', { problem: 'anything' }, bearer(token))).status, 400);
  } finally {
    await h.stop();
  }
});

test('join.sh and device-agent.tar are public, and the archive unpacks to the agent and the one core file it needs', async () => {
  const h = await hub();
  try {
    const sh = await fetch(`${h.mesh}/join.sh`);
    assert.equal(sh.status, 200);
    const script = await sh.text();
    assert.match(script, /^#!\/bin\/sh/);
    assert.match(script, /HUB='http:\/\/hub\.example:4320'/);
    const dir = mkdtempSync(join(tmpdir(), 'nova-agent-tar-'));
    writeFileSync(join(dir, 'join.sh'), script);
    assert.equal(spawnSync('sh', ['-n', join(dir, 'join.sh')]).status, 0, 'join.sh parses as POSIX sh');

    const tarRes = await fetch(`${h.mesh}/device-agent.tar`);
    assert.equal(tarRes.status, 200);
    assert.equal(tarRes.headers.get('content-type'), 'application/x-tar');
    writeFileSync(join(dir, 'agent.tar'), Buffer.from(await tarRes.arrayBuffer()));
    const list = spawnSync('tar', ['-tf', join(dir, 'agent.tar')], { encoding: 'utf8' });
    assert.equal(list.status, 0, list.stderr);
    const files = list.stdout.trim().split('\n').filter((f) => !f.endsWith('/')).sort();
    assert.deepEqual(files, ['package.json', 'src/core/mesh/wire.ts', 'src/device/boot.ts', 'src/device/queue.ts', 'src/device/runtime.ts', 'src/device/trust.ts', 'src/device/watchdog.ts']);
    assert.equal(spawnSync('tar', ['-xf', join(dir, 'agent.tar'), '-C', dir]).status, 0);
    assert.equal(readFileSync(join(dir, 'src/core/mesh/wire.ts'), 'utf8'), readFileSync(join(import.meta.dirname, '../../src/core/mesh/wire.ts'), 'utf8'));
    assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).type, 'module');
    // The unpacked agent runs on its own, with nothing else of Nova beside it.
    const help = spawnSync(process.execPath, [join(dir, 'src/device/boot.ts'), 'help'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', NOVA_DEVICE_HOME: join(dir, 'home') } });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /join <hub-url> --code <code>/);

    // Without a mesh listener there is nothing to join, and the script says so.
    const lone = await hub({ mesh: false });
    try {
      const text = await (await fetch(`${lone.console}/join.sh`)).text();
      assert.match(text, /no address other devices can reach/);
    } finally {
      await lone.stop();
    }
  } finally {
    await h.stop();
  }
});

test('the device agent imports nothing of Nova but the wire format', () => {
  const src = join(import.meta.dirname, '../../src');
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(/^import[^'"]*from '([^']+)'/gm)) {
      const spec = m[1]!;
      if (spec.startsWith('node:')) continue;
      assert.ok(spec.startsWith('.'), `${file} imports a package (${spec})`);
      visit(join(file, '..', spec));
    }
  };
  for (const f of ['boot.ts', 'runtime.ts', 'queue.ts', 'trust.ts', 'watchdog.ts']) visit(join(src, 'device', f));
  const outside = [...seen].map((f) => f.slice(src.length + 1)).filter((f) => !f.startsWith('device/'));
  assert.deepEqual(outside, ['core/mesh/wire.ts']);
  // The runtime carries only itself and its queue.
  assert.deepEqual([...readFileSync(join(src, 'device', 'runtime.ts'), 'utf8').matchAll(/^import[^'"]*from '(\.[^']+)'/gm)].map((m) => m[1]), ['./queue.ts']);
});
