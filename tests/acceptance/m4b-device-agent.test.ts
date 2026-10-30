// M4b against the real server process, with a mesh listener on loopback: a computer joins by the
// exact one-line command (curl | sh, the hub's own join.sh), the boot agent starts the runtime,
// the runtime heartbeats and the registry shows it Online. Then the hub is killed: the computer
// queues a task request and a memory note, both agents restart while it is down, the hub comes
// back, and each item arrives exactly once. Then the computer is revoked: its agent stops and says
// so. Neutral placeholders only; the device home is a temp folder, never ~/.nova-device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { blank, start, stop, until, sleep, type Running } from './support.ts';

const freePort = () => new Promise<number>((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => ok(port)); }); });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('M4b: join by the one-line command, Online, offline queue across a hub outage (exactly once), revocation', { timeout: 120_000 }, async () => {
  const m = blank('nova-m4b-');
  const port = await freePort();
  const mesh = `http://127.0.0.1:${port}`;
  // No Ollama for the model manager to read here (port 9 answers nothing): only the device map is checked.
  const meshEnv = { NOVA_MESH_URL: mesh, NOVA_MESH_TRANSPORT: 'network', NOVA_MESH_PUBLIC_URL: mesh, NOVA_OLLAMA_URL: 'http://127.0.0.1:9' };
  let hub: Running = await m.start(meshEnv);
  const deviceHome = join(m.dir, 'device-home');
  // The agent's environment: its own home folder, quick timings for the test.
  const agentEnv = {
    PATH: process.env.PATH ?? '', HOME: join(m.dir, 'user'), NOVA_DEVICE_HOME: deviceHome, TZ: 'UTC',
    NOVA_DEVICE_POLL_MS: '200', NOVA_DEVICE_HEARTBEAT_MS: '300', NOVA_DEVICE_TICK_MS: '200', NOVA_DEVICE_RETRY_MS: '300', NOVA_DEVICE_BACKOFF_MS: '100',
  };
  const boot = join(deviceHome, 'agent', 'src', 'device', 'boot.ts');
  const agent = (...args: string[]) => spawnSync(process.execPath, [boot, ...args], { env: agentEnv, encoding: 'utf8' });
  const bootPid = () => Number(readFileSync(join(deviceHome, 'boot', 'run.pid'), 'utf8'));
  const procs: ChildProcess[] = [];
  try {
    // 1. The command, exactly as the hub hands it out.
    const pairing = await m.send('POST', '/api/v1/mesh/pairings');
    assert.equal(pairing.status, 201, JSON.stringify(pairing.body));
    assert.equal(pairing.body.command, `curl -fsS ${mesh}/join.sh | sh -s -- ${pairing.body.code}`);
    const sh = spawn('sh', ['-c', pairing.body.command], { env: agentEnv });
    procs.push(sh);
    let out = '';
    sh.stdout!.on('data', (d) => { out += d; });
    sh.stderr!.on('data', (d) => { out += d; });
    const digits = (await until(async () => /these digits: (\d{3}) (\d{3})/.exec(out), Boolean, 400))?.slice(1).join('');
    assert.ok(digits, `no digits from join.sh:\n${out}`);
    // The hub's prompt shows the same digits; approve on the console with confirm.
    const requests = (await m.get('/api/v1/mesh/requests')) as Array<{ id: string; confirmation: string; kind: string }>;
    const req = requests.find((r) => r.confirmation === digits);
    assert.ok(req, `no request with digits ${digits}: ${JSON.stringify(requests)}`);
    assert.equal(req.kind, 'computer');
    assert.equal((await m.send('POST', `/api/v1/mesh/requests/${req.id}/approve`, { confirm: true })).status, 200);
    const shCode = await new Promise<number | null>((r) => (sh.exitCode !== null ? r(sh.exitCode) : sh.on('exit', r)));
    assert.equal(shCode, 0, out);
    assert.match(out, /The agent is running in the background/);
    // Nothing system-wide: the agent, its keys and its state are in the device home.
    for (const f of ['agent/package.json', 'agent/src/core/mesh/wire.ts', 'boot/keys.json', 'boot/device.json']) assert.ok(existsSync(join(deviceHome, f)), f);
    assert.equal(readFileSync(join(deviceHome, 'boot', 'keys.json')).length > 0 && (spawnSync('stat', ['-c', '%a', join(deviceHome, 'boot', 'keys.json')], { encoding: 'utf8' }).stdout.trim()), '600');

    // 2. The boot agent (background) starts the runtime; the runtime heartbeats; Online.
    const computer = async () => ((await m.get('/api/v1/mesh/devices')) as Array<{ id: string; kind: string; online: boolean; agent?: { runtime_version: string; safe_mode: boolean } }>).find((d) => d.kind === 'computer' && d.agent);
    const online = await until(computer, (d) => !!d?.online, 400);
    assert.ok(online?.online, 'the computer shows Online');
    assert.equal(online!.agent!.safe_mode, false);
    assert.match(online!.agent!.runtime_version, /^0\.1\.0\+[0-9a-f]{12}$/, 'running the runtime the hub signed');
    // M6b: its heartbeat carries what it can run models on, read by the boot agent; the hub's
    // device map shows it.
    const mapped = await until(async () => ((await m.get('/api/v1/models')) as { devices: { id: string; hub: boolean; hardware: { cpu: { threads: number }; ram_bytes: number } | null }[] }).devices.find((d) => d.id === online!.id), (d) => !!d?.hardware, 400);
    assert.ok(mapped?.hardware && mapped.hardware.ram_bytes > 0 && mapped.hardware.cpu.threads > 0, 'the computer’s hardware reached the hub');
    const first = bootPid();
    assert.ok(alive(first));
    const rt = JSON.parse(readFileSync(join(deviceHome, 'state', 'runtime.json'), 'utf8')) as { pid: number; hub_url: string };
    assert.equal(rt.hub_url, mesh);
    const ppid = Number(/PPid:\s+(\d+)/.exec(readFileSync(`/proc/${rt.pid}/status`, 'utf8'))?.[1]);
    assert.equal(ppid, first, 'the runtime is the boot agent’s child');

    // Online, a note goes straight through the queue.
    assert.equal(agent('queue', 'memory_note', JSON.stringify({ content: 'The test lamp is in the hall.' })).status, 0);
    const mem = await until(async () => ((await m.get('/api/v1/memory')) as Array<{ content: string; recorded_by: string }>).find((x) => x.content === 'The test lamp is in the hall.'), Boolean, 400);
    assert.equal(mem?.recorded_by, `device:${online!.id}`);

    // 3. The hub dies. The computer keeps working: a task request and a memory note wait offline.
    hub.proc.kill('SIGKILL');
    await new Promise((r) => hub.proc.on('exit', r));
    const task = { title: 'Test task from the computer', owner: 'workspace', goal: 'A test note exists in the workspace.', evidence_required: [{ kind: 'read_back', target: 'notes/from-computer.md' }], inputs: { path: 'notes/from-computer.md', content: 'hello' } };
    assert.equal(agent('queue', 'task_request', JSON.stringify(task), '--key', 'outage-task-0001').status, 0);
    assert.equal(agent('queue', 'memory_note', JSON.stringify({ content: 'Noted while the hub was down.' }), '--key', 'outage-note-0001').status, 0);
    // Both agents restart while the hub is down: the queue is on disk.
    process.kill(first, 'SIGTERM');
    await until(async () => alive(first), (a) => !a, 200);
    assert.ok(!alive(first));
    await until(async () => alive(rt.pid), (a) => !a, 200);
    assert.ok(!alive(rt.pid), 'the runtime went with it');
    const again = spawn(process.execPath, [boot, 'run'], { env: agentEnv });
    procs.push(again);
    let runOut = '';
    again.stdout!.on('data', (d) => { runOut += d; });
    again.stderr!.on('data', (d) => { runOut += d; });
    await until(async () => runOut, (o) => /can’t be reached yet/.test(o), 200);
    const st = JSON.parse(agent('status', '--json').stdout);
    assert.equal(st.queue.pending, 2, JSON.stringify(st));
    assert.equal(st.running, true);

    // 4. The hub comes back (same home, same address): each item arrives, once.
    hub = await start({ ...m.env, ...meshEnv, NOVA_PORT: String(new URL(m.base).port) });
    const tasks = async () => ((await m.get('/api/v1/tasks?limit=500')) as Array<{ title: string; origin: { kind: string } }>).filter((t) => t.title === task.title);
    const delivered = await until(tasks, (t) => t.length > 0, 400);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.origin.kind, 'device');
    const notes = await until(async () => ((await m.get('/api/v1/memory')) as Array<{ content: string }>).filter((x) => x.content === 'Noted while the hub was down.'), (x) => x.length > 0, 400);
    assert.equal(notes.length, 1);
    const settled = await until(async () => JSON.parse(agent('status', '--json').stdout), (s) => s.queue.pending === 0, 400);
    assert.equal(settled.queue.pending, 0);
    // Sending the same keys again, as after a lost reply, changes nothing.
    await sleep(500);
    assert.equal((await tasks()).length, 1);
    assert.ok(/Connected to the hub/.test(runOut), runOut);

    // 5. Revoked: the agent stops, says so, and won't start again.
    const id = online!.id;
    assert.equal((await m.send('POST', `/api/v1/mesh/devices/${id}/revoke`, { confirm: true, reason: 'Test revocation.' })).status, 200);
    const code = await new Promise<number | null>((r) => (again.exitCode !== null ? r(again.exitCode) : again.on('exit', r)));
    assert.equal(code, 3, runOut);
    assert.match(runOut, /the hub revoked it\. The agent has stopped/);
    const after = JSON.parse(agent('status', '--json').stdout);
    assert.equal(after.revoked, true);
    assert.equal(after.running, false);
    const rerun = agent('run');
    assert.equal(rerun.status, 3);
    assert.match(rerun.stdout, /revoked/);
  } finally {
    for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
    try { const pid = bootPid(); if (alive(pid)) process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    await stop(hub);
  }
});

// The gate's transport: HTTPS with a certificate the system doesn't know. curl trusts it through
// NOVA_CA_FILE (--cacert), the boot agent copies it into boot/ at join, and the runtime is handed
// it over IPC, so all three reach the hub with no system-wide change.
test('M4b over HTTPS: NOVA_CA_FILE carries trust to curl, the boot agent and the runtime', { timeout: 90_000 }, async (t) => {
  const certs = mkdtempSync(join(tmpdir(), 'nova-m4b-tls-'));
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(certs, 'key.pem'), '-out', join(certs, 'cert.pem')], { encoding: 'utf8' });
  if (made.status !== 0) return t.skip('openssl is not available to make a test certificate');
  const ca = join(certs, 'cert.pem');
  const m = blank('nova-m4b-tls-');
  const port = await freePort();
  const mesh = `https://127.0.0.1:${port}`;
  const hub = await m.start({ NOVA_MESH_URL: mesh, NOVA_MESH_PUBLIC_URL: mesh, NOVA_TLS_CERT: ca, NOVA_TLS_KEY: join(certs, 'key.pem') });
  const deviceHome = join(m.dir, 'device-home');
  const env = { PATH: process.env.PATH ?? '', HOME: join(m.dir, 'user'), NOVA_DEVICE_HOME: deviceHome, NOVA_DEVICE_POLL_MS: '200', NOVA_DEVICE_HEARTBEAT_MS: '300', TZ: 'UTC' };
  let joining: ChildProcess | null = null;
  try {
    const pairing = await m.send('POST', '/api/v1/mesh/pairings');
    // Without the CA, curl refuses the hub: nothing is downloaded or run. (The pipe's status is
    // sh's, which read an empty script; curl's complaint is what the person sees.)
    const refused = spawnSync('sh', ['-c', pairing.body.command], { env, encoding: 'utf8' });
    assert.match(refused.stderr, /certificate/i);
    assert.ok(!existsSync(join(deviceHome, 'agent')));
    // The command as handed out; the first curl (the one fetching join.sh) trusts the CA through
    // curl's own CURL_CA_BUNDLE, everything after it through NOVA_CA_FILE.
    joining = spawn('sh', ['-c', pairing.body.command], { env: { ...env, NOVA_CA_FILE: ca, CURL_CA_BUNDLE: ca } });
    let out = '';
    joining.stdout!.on('data', (d) => { out += d; });
    joining.stderr!.on('data', (d) => { out += d; });
    const digits = (await until(async () => /these digits: (\d{3}) (\d{3})/.exec(out), Boolean, 400))?.slice(1).join('');
    assert.ok(digits, out);
    const req = ((await m.get('/api/v1/mesh/requests')) as Array<{ id: string; confirmation: string }>).find((r) => r.confirmation === digits)!;
    assert.equal((await m.send('POST', `/api/v1/mesh/requests/${req.id}/approve`, { confirm: true })).status, 200);
    const j = joining;
    assert.equal(await new Promise((r) => (j.exitCode !== null ? r(j.exitCode) : j.on('exit', r))), 0, out);
    assert.ok(existsSync(join(deviceHome, 'boot', 'ca.pem')), 'the CA is kept with the boot agent');
    const dev = await until(async () => ((await m.get('/api/v1/mesh/devices')) as Array<{ kind: string; online: boolean; agent?: unknown }>).find((d) => d.kind === 'computer' && d.agent), (d) => !!d?.online, 400);
    const log = existsSync(join(deviceHome, 'agent.log')) ? readFileSync(join(deviceHome, 'agent.log'), 'utf8') : '';
    assert.ok(dev?.online, `not Online over HTTPS:\n${out}\n${log}`);
  } finally {
    if (joining?.exitCode === null) joining.kill('SIGKILL');
    try {
      const pid = Number(readFileSync(join(deviceHome, 'boot', 'run.pid'), 'utf8'));
      if (alive(pid)) process.kill(pid, 'SIGTERM');
      await until(async () => alive(pid), (a) => !a, 200);
    } catch { /* gone */ }
    await stop(hub);
  }
});
