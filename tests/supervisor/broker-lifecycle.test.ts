import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Supervisor } from '../../src/supervisor/supervisor.ts';
import { fakeRepo, fakeRelease, git, FAST } from './fake.ts';
import { Person } from '../support/broker-support.ts';
import { startBroker } from '../../src/broker/spawn.ts';
import { fileSha256 } from '../../src/broker/origin.ts';
import { readMark } from '../../src/core/resilience/home-mark.ts';
import { open } from '../core/resilience-support.ts';
import { until, ROOT } from './support.ts';
import { validate } from '../../src/core/services/definition.ts';
import { consoleDefinition } from '../../src/core/services/console.ts';

function fixture(change?: (root: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-broker-life-'));
  const repo = fakeRepo(dir);
  cpSync(join(ROOT, 'src/broker'), join(repo, 'src/broker'), { recursive: true });
  cpSync(join(ROOT, 'src/core/broker'), join(repo, 'src/core/broker'), { recursive: true });
  cpSync(join(ROOT, 'src/core/resilience/link.ts'), join(repo, 'src/core/resilience/link.ts'));
  const file = join(repo, 'src/server.js');
  writeFileSync(file, readFileSync(file, 'utf8').replace("const marker =", `import { BrokerClient } from './core/broker/client.ts';
import { ipcBroker } from './core/resilience/link.ts';
let broker;
const context = await ipcBroker(process);
if (context) {
  broker = new BrokerClient(context);
  const a = await broker.listRefs();
  if (!a.ok || Object.keys(context).sort().join() !== 'socket,token') process.exit(71);
  if (Object.values(process.env).includes(context.token) || process.argv.includes(context.token)) process.exit(72);
}
const marker =`).replace("const u = req.url || '';", `const u = req.url || '';
  if (u === '/test-broker' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const q = JSON.parse(body); return json(await broker.call(q.m, q.f));
  }`));
  change?.(repo);
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'broker-aware fixture');
  const home = join(dir, 'home'); mkdirSync(home);
  const sup = new Supervisor({ dir: join(dir, 'supervisor'), home, repo, base: repo, env: { PATH: process.env.PATH!, HOME: dir, NOVA_PORT: '0', NOVA_VAULT_KEY: 'file' }, tests: [process.execPath, '-e', ''], timings: FAST });
  return { dir, repo, home, sup };
}

test('actual supervisor starts broker before Core IPC, rotates roles on restart, uses release code and stops both', async () => {
  const f = fixture();
  try {
    await f.sup.run();
    await until(() => f.sup.state.mode === 'running', 'broker boot before Core', 4000);
    const first = (f.sup.state as any).broker;
    assert.equal(first?.status, 'running'); assert.ok(first.pid > 0);
    assert.ok(readMark(f.home), 'supervisor marks home before creating owned broker storage');
    const initial = readFileSync(join(f.home, 'broker/device.json'), 'utf8');
    assert.equal((await f.sup.restart()).ok, true);
    assert.notEqual((f.sup.state as any).broker.pid, first.pid);
    assert.equal(readFileSync(join(f.home, 'broker/device.json'), 'utf8'), initial);
    fakeRelease(f.repo, 'v1.1.0', 'two');
    assert.equal((await f.sup.deploy('v1.1.0')).ok, true);
    const root = f.sup.codeRoot();
    assert.ok(root.endsWith('/v1.1.0'));
    assert.ok(readFileSync(`/proc/${(f.sup.state as any).broker.pid}/cmdline`, 'utf8').includes(join(root, 'src/broker/main.ts')), 'broker runs the promoted release source');
    assert.equal((await f.sup.rollback({ auto: false, reason: 'test', target: 'base' })).ok, true);
    await f.sup.close();
    assert.throws(() => process.kill((f.sup.state as any).broker.pid ?? first.pid, 0));
  } finally { await f.sup.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('three broker crashes hold Core and credentials in safe mode, recovery starts a fresh broker', async () => {
  const f = fixture();
  try {
    await f.sup.run();
    await until(() => f.sup.state.mode === 'running', 'initial broker', 4000);
    for (let i = 0; i < 3; i++) {
      const pid = (f.sup.state as any).broker.pid;
      process.kill(pid, 'SIGKILL');
      if (i < 2) await until(() => (f.sup.state as any).broker?.pid !== pid && f.sup.state.mode === 'running', 'broker recovery', 4000);
    }
    await until(() => f.sup.state.mode === 'safe_mode', 'three-crash hold', 4000);
    assert.equal(f.sup.server, null);
    assert.notEqual((f.sup.state as any).broker.status, 'running');
    assert.equal((await f.sup.recover()).ok, true);
  } finally { await f.sup.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('broker name is reserved, never an editable image/program workload', () => {
  const d = { ...consoleDefinition({ version: 'v1', port: 1234 }), service: 'nova-broker', contract_tests: [], artifact: { image: 'example/broker@sha256:' + 'a'.repeat(64) } };
  const r = validate(d); assert.equal(r.ok, false);
  assert.match(JSON.stringify(r), /reserved.*supervisor/i);
});


test('supervisor reset finishes authenticated cleanup before deleting keys and starts fresh identity', async () => {
  const f = fixture();
  // The real Core stages its authenticated reset; the fake console exercises only supervision.
  const firstCore = open(f.home); await firstCore.close();
  try {
    await f.sup.run(); await until(() => f.sup.state.mode === 'running', 'running');
    const before = readFileSync(join(f.home, 'broker/device.json'), 'utf8');
    writeFileSync(join(f.home, 'person.txt'), 'keep');
    const c = open(f.home);
    const stage = await c.reset.stage({ confirm: true, who: { principal: { kind: 'console' }, listener: 'console', address: '127.0.0.1' } });
    await stage.done; await c.close();
    assert.equal((await f.sup.restart()).ok, true);
    assert.notEqual(readFileSync(join(f.home, 'broker/device.json'), 'utf8'), before);
    assert.equal(existsSync(join(f.home, 'factory-reset.json')), false);
    assert.equal(readFileSync(join(f.home, 'person.txt'), 'utf8'), 'keep');
    assert.ok(JSON.parse(readFileSync(join(f.home, 'reset-report.json'), 'utf8')).wiped.home.includes('broker'));
  } finally { await f.sup.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('retained owned run blocks supervisor reset and leaves authenticated marker plus broker evidence intact', async () => {
  const f = fixture(); const firstCore = open(f.home); await firstCore.close();
  try {
    await f.sup.run(); await until(() => f.sup.state.mode === 'running', 'running');
    const c = open(f.home);
    const stage = await c.reset.stage({ confirm: true, who: { principal: { kind: 'console' }, listener: 'console', address: '127.0.0.1' } });
    await stage.done; await c.close();
    const retained = join(f.home, 'broker/run/programs/ambiguous'); mkdirSync(retained, { recursive: true });
    assert.equal((await f.sup.restart()).ok, false);
    await until(() => f.sup.state.mode === 'safe_mode', 'failed cleanup hold');
    assert.ok(existsSync(retained)); assert.ok(existsSync(join(f.home, 'factory-reset.json')));
    assert.ok(existsSync(join(f.home, 'broker/device.json')));
  } finally { await f.sup.close(); rmSync(f.dir, { recursive: true, force: true }); }
});


test('supervisor restart awaits real TERM-resistant credentialed process cleanup before new Core', { timeout: 30000 }, async () => {
  const f = fixture(); let pid = 0;
  try {
    await f.sup.run(); await until(() => f.sup.state.mode === 'running', 'running');
    const base = `http://127.0.0.1:${f.sup.server!.port}`;
    const call = async (m: string, fields: any = {}) => {
      const r = await fetch(`${base}/test-broker`, { method: 'POST', body: JSON.stringify({ m, f: fields }) });
      return r.json();
    };
    const p = new Person(call); await p.setup();
    const program = join(f.dir, 'owned.py'), log = join(f.dir, 'owned.json');
    writeFileSync(program, '#!/usr/bin/python3\nimport os,time,signal,json\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nwith open(os.environ["TF_VAR_LOG"],"w") as f: json.dump([os.getpid(),os.environ["CREDENTIAL_FILE"]],f)\nwhile True: time.sleep(1)\n', { mode: 0o755 });
    const target = { kind: 'process', path: program, sha256: fileSha256(program) };
    const made = await p.approve('create', { meta: { name: 'test/STOP', kind: 'secret', class: 'standard' }, source: 'sealed', bind: [{ target, inject: { how: 'file', env: 'CREDENTIAL_FILE' }, consent: {} }] }, { seal: 'task6-private-stop-canary', sealAt: (v, sealed) => ({ ...v, source: { sealed } }) });
    assert.equal(made.ok, true);
    const use = call('use', { ref: made.ref, target, request: { argv: [], env: { TF_VAR_LOG: log }, timeout_ms: 20000 } }).catch(() => null);
    await until(() => existsSync(log), 'owned program active');
    const owned = JSON.parse(readFileSync(log, 'utf8')); pid = owned[0];
    assert.ok(existsSync(owned[1]));
    assert.equal((await f.sup.restart('owned cleanup test', 100)).ok, true);
    await use;
    const alive = existsSync(`/proc/${pid}/stat`) && !/^[^)]*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    assert.equal(alive, false);
    assert.equal(existsSync(owned[1]), false);
  } finally {
    await f.sup.close(); rmSync(f.dir, { recursive: true, force: true });
  }
});


test('failed broker owned shutdown never starts replacement Core or reports broker running', async () => {
  const f = fixture((root) => {
    const path = join(root, 'src/broker/main.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace('await broker.stopPrograms();', 'await Promise.reject(new Error("injected owned cleanup failure"));'));
  });
  try {
    await f.sup.run(); await until(() => f.sup.state.mode === 'running', 'running');
    await assert.rejects(() => f.sup.restart(), /cleanup/);
    assert.equal(f.sup.server, null);
    assert.equal((f.sup.state as any).broker.status, 'failed');
    await assert.rejects(() => f.sup.recover(), /cleanup/, 'recover cannot bypass unconfirmed owned shutdown');
    assert.ok(existsSync(join(f.home, 'broker/device.json')));
  } finally {
    await assert.rejects(() => f.sup.close(), /cleanup/);
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('first supervised start finishes a previously staged legacy reset before creating broker storage', async () => {
  const f = fixture(); const c = open(f.home);
  const stage = await c.reset.stage({ confirm: true, who: { principal: { kind: 'console' }, listener: 'console', address: '127.0.0.1' } });
  await stage.done; await c.close();
  try {
    await f.sup.run(); await until(() => f.sup.state.mode === 'running', 'running');
    assert.equal(existsSync(join(f.home, 'factory-reset.json')), false);
    assert.ok(existsSync(join(f.home, 'reset-report.json')));
    assert.ok(existsSync(join(f.home, 'broker/device.json')));
  } finally { await f.sup.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('a service cleanup rejection still drains broker and Core, releases control and reports failure', async () => {
  const f = fixture();
  try {
    await f.sup.run(); await until(() => f.sup.state.mode === 'running', 'running');
    const pid = (f.sup.state as any).broker.pid;
    const original = f.sup.services.close.bind(f.sup.services);
    f.sup.services.close = async () => { await original(); throw new Error('injected service cleanup failure'); };
    await assert.rejects(() => f.sup.close(), /cleanup/);
    assert.throws(() => process.kill(pid, 0), 'owned broker drained despite another cleanup failure');
    assert.equal(f.sup.server, null);
    assert.equal(existsSync(join(f.sup.o.dir, 'control.sock')), false);
    assert.equal(f.sup.state.mode, 'safe_mode');
    f.sup.services.close = original;
  } finally { await f.sup.close().catch(() => {}); rmSync(f.dir, { recursive: true, force: true }); }
});

test('concurrent restarts admit one replacement broker/Core pair', async () => {
  const f = fixture();
  try {
    await f.sup.run(); await until(() => f.sup.state.mode === 'running', 'running');
    const results = await Promise.all([f.sup.restart(), f.sup.restart()]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.match(results.find((r) => !r.ok)!.said, /restart.*running/i);
  } finally { await f.sup.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

for (const resetKind of ['hub', 'standby']) test(`supervised ${resetKind} keychain reset retries interruption without reading/recreating removed keys and preserves unrelated accounts`, { timeout: 30000 }, async () => {
  const f = fixture();
  const bin = join(f.dir, 'bin'), keys = join(f.dir, 'keys'); mkdirSync(bin); mkdirSync(keys);
  const denied = join(f.dir, 'deny-sign');
  writeFileSync(join(keys, 'nova-broker-unrelated'), 'keep-other-account');
  writeFileSync(join(bin, 'secret-tool'), `#!/usr/bin/python3
import os,sys
args=sys.argv
service=args[args.index('service')+1]; account=args[args.index('account')+1]
p=os.path.join(${JSON.stringify(keys)},service+'-'+account)
if args[1]=='lookup':
    if not os.path.exists(p): sys.exit(1)
    print(open(p).read())
elif args[1]=='store': open(p,'w').write(sys.stdin.read())
elif args[1]=='clear':
    if account.startswith('sign-') and os.path.exists(${JSON.stringify(denied)}):
        print('private injected denial',file=sys.stderr); sys.exit(7)
    if os.path.exists(p): os.unlink(p)
    else: sys.exit(1)
`, { mode: 0o755 });
  Object.assign(f.sup.o.env, { NOVA_VAULT_KEY: 'keychain', PATH: `${bin}:/usr/bin:/bin`, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/private-fake-no-socket' });
  const firstCore = open(f.home); await firstCore.close();
  try {
    await f.sup.run(); await until(() => f.sup.state.mode === 'running', 'running');
    const base = `http://127.0.0.1:${f.sup.server!.port}`;
    const p = new Person(async (m, fields = {}) => (await fetch(`${base}/test-broker`, { method: 'POST', body: JSON.stringify({ m, f: fields }) })).json());
    await p.setup();
    const old = JSON.parse(readFileSync(join(f.home, 'broker/device.json'), 'utf8')).id;
    // A synthetic signing entry covers both fixed accounts even if no outbox was needed yet.
    writeFileSync(join(keys, `nova-broker-sign-${old}`), Buffer.alloc(32, 9).toString('base64'));
    const c = open(f.home);
    if (resetKind === 'standby') await c.reset.standbyWipe({ id: 'public-standby-reset', said: 'Public reset notice' });
    else {
      const stage = await c.reset.stage({ confirm: true, who: { principal: { kind: 'console' }, listener: 'console', address: '127.0.0.1' } });
      await stage.done;
    }
    await c.close(); writeFileSync(denied, 'deny');
    assert.equal((await f.sup.restart()).ok, false);
    await until(() => f.sup.state.mode === 'safe_mode', 'interrupted reset held');
    assert.equal(existsSync(join(keys, `nova-broker-device-${old}`)), false);
    assert.equal(existsSync(join(keys, `nova-broker-sign-${old}`)), true);
    assert.equal(JSON.parse(readFileSync(join(f.home, 'broker/device.json'), 'utf8')).id, old);
    assert.ok(existsSync(join(f.home, 'factory-reset.json')));
    rmSync(denied);
    assert.equal((await f.sup.recover()).ok, true);
    assert.equal(existsSync(join(keys, `nova-broker-sign-${old}`)), false);
    assert.notEqual(JSON.parse(readFileSync(join(f.home, 'broker/device.json'), 'utf8')).id, old);
    assert.equal(readFileSync(join(keys, 'nova-broker-unrelated'), 'utf8'), 'keep-other-account');
    assert.equal(existsSync(join(f.home, 'factory-reset.json')), false);
  } finally { await f.sup.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('supervisor refuses a foreign home before broker retries or problem writes', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const f = fixture(); const db = new DatabaseSync(join(f.home, 'nova.db'));
  db.exec('CREATE TABLE problem (id INTEGER PRIMARY KEY, at TEXT, source TEXT, message TEXT, detail TEXT, resolved_at TEXT)');
  try {
    await assert.rejects(() => f.sup.run(), /home|folder|Nova/i);
    assert.equal((db.prepare('SELECT count(*) AS n FROM problem').get() as any).n, 0);
    assert.equal(existsSync(join(f.home, 'broker')), false);
  } finally { db.close(); await f.sup.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

// Review I1: cleanup failure must hold at the shared admission boundary, including rollback.
test('rollback retains failed owned cleanup and refuses every replacement admission', { timeout: 20000 }, async () => {
  const f = fixture((root) => {
    const path = join(root, 'src/broker/main.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace('await broker.stopPrograms();', 'await Promise.reject(new Error("injected owned cleanup failure"));'));
  });
  try {
    fakeRelease(f.repo, 'v1.1.0', 'two');
    await f.sup.slots.ensure('v1.1.0'); f.sup.slots.point('v1.1.0');
    await f.sup.run(); await until(() => f.sup.state.mode === 'running', 'running');
    const result = await f.sup.rollback({ auto: false, reason: 'cleanup contract', target: 'base' });
    assert.equal(result.ok, false);
    assert.equal(f.sup.server === null, true, 'rollback must not start Core after unconfirmed cleanup');
    assert.equal(f.sup.state.mode, 'safe_mode');
    assert.equal((f.sup.state as any).broker.status, 'failed');
    assert.doesNotMatch(result.said, /kept .* running/);
    await assert.rejects(() => f.sup.restart(), /cleanup/);
    await assert.rejects(() => f.sup.recover(), /cleanup/);
    assert.equal((await f.sup.rollback({ auto: false, reason: 'repeat', target: 'base' })).ok, false);
    assert.equal(f.sup.server, null);
    assert.ok(existsSync(join(f.home, 'broker/device.json')));
  } finally { await f.sup.close().catch(() => {}); rmSync(f.dir, { recursive: true, force: true }); }
});

// Only the private copied release is instrumented, never production. The real broker child
// reports its PID at a readiness barrier inside its allowed folder and waits for our release.
function readinessFixture() {
  return fixture((root) => {
    const path = join(root, 'src/broker/main.ts');
    let text = readFileSync(path, 'utf8');
    text = "import { existsSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\n" + text;
    text = text.replace("process.once('message'", `async function barrier(kind: string) {
  const hold = join(dir!, 'test-hold-' + kind);
  if (!existsSync(hold)) return;
  writeFileSync(join(dir!, 'test-ready-' + kind), String(process.pid));
  while (existsSync(hold)) await new Promise((r) => setTimeout(r, 10));
}
process.once('message'`);
    text = text.replace('process.send!({ ready: true });', "await barrier('reset'); process.send!({ ready: true });");
    text = text.replace('process.send!({ ready: true, socket:', "await barrier('normal'); process.send!({ ready: true, socket:");
    text = text.replace('await broker.stopPrograms();', `if (existsSync(join(dir!, 'test-fail-stop'))) throw new Error('injected late cleanup failure'); await broker.stopPrograms();`);
    writeFileSync(path, text);
  });
}

for (const scenario of ['replacement', 'initial', 'reset', 'late-failure'] as const) {
  test(`close joins owned startup readiness and cleanup: ${scenario}`, { timeout: 20000 }, async (t) => {
    const f = readinessFixture(); const kind = scenario === 'reset' ? 'reset' : 'normal';
    const hold = join(f.home, 'broker', 'test-hold-' + kind), ready = join(f.home, 'broker', 'test-ready-' + kind);
    let starting: Promise<unknown> | undefined, closing: Promise<{ ok: boolean; error?: Error }> | undefined;
    let requested = false, lateResume = 0, lateTimers = 0;
    const resume = f.sup.services.resume.bind(f.sup.services), interval = globalThis.setInterval;
    t.mock.method(f.sup.services, 'resume', async () => { if (requested) lateResume++; await resume(); });
    t.mock.method(globalThis, 'setInterval', (...args: Parameters<typeof setInterval>) => { if (requested && args[1] === f.sup.t.healthEveryMs) lateTimers++; return interval(...args); });
    try {
      // The real Core creates the home mark before any broker storage, including initial boot.
      const c = open(f.home); await c.close();
      if (scenario !== 'initial') { await f.sup.run(); await until(() => f.sup.state.mode === 'running', 'initial pair'); }
      if (scenario === 'reset') {
        const c = open(f.home);
        try { const staged = await c.reset.stage({ confirm: true, who: { principal: { kind: 'console' }, listener: 'console', address: '127.0.0.1' } }); await staged.done; } finally { await c.close(); }
      }
      mkdirSync(join(f.home, 'broker'), { recursive: true }); writeFileSync(hold, 'hold');
      starting = (scenario === 'initial' ? f.sup.run() : f.sup.restart()).catch((e) => e);
      await until(() => existsSync(ready), 'actual child waiting before readiness', 4000);
      const pid = Number(readFileSync(ready, 'utf8')); process.kill(pid, 0);
      if (scenario === 'late-failure') writeFileSync(join(f.home, 'broker/test-fail-stop'), 'fail');
      requested = true;
      let settled = false, secondSettled = false;
      closing = f.sup.close().then(() => ({ ok: true }), (error: Error) => ({ ok: false, error })).then((r) => { settled = true; return r; });
      const second: Promise<{ ok: boolean; error?: Error }> = f.sup.close().then(() => ({ ok: true }), (error: Error) => ({ ok: false, error })).then((r) => { secondSettled = true; return r; });
      await new Promise((r) => setTimeout(r, 60));
      const before = { settled, secondSettled, pidFile: existsSync(join(f.sup.o.dir, 'supervisor.pid')) };
      process.kill(pid, 0); // The controlled child is physically alive at this observation.
      rmSync(hold); await starting; const result = await closing, again = await second;
      assert.deepEqual(before, { settled: false, secondSettled: false, pidFile: true }, 'both close callers must await the owned child, not only request cleanup');
      assert.equal(result.ok, scenario !== 'late-failure'); assert.equal(again.ok, result.ok);
      if (!result.ok) {
        assert.match(result.error!.message, /cleanup/); assert.equal(again.error, result.error);
        assert.equal(f.sup.state.mode, 'safe_mode'); assert.ok(existsSync(join(f.sup.o.dir, 'supervisor.pid')));
      } else assert.equal(existsSync(join(f.sup.o.dir, 'supervisor.pid')), false);
      assert.throws(() => process.kill(pid, 0), 'close joined actual child exit');
      assert.equal(f.sup.server, null); assert.equal(lateResume, 0); assert.equal(lateTimers, 0);
      if (scenario === 'reset') assert.ok(existsSync(join(f.home, 'factory-reset.json')), 'closing cannot continue reset directory deletion or boot');
      assert.equal(existsSync(join(f.sup.o.dir, 'control.sock')), false);
    } finally {
      rmSync(hold, { force: true });
      await starting; await closing; await f.sup.close().catch(() => {});
      t.mock.restoreAll(); rmSync(f.dir, { recursive: true, force: true });
    }
  });
}


after(() => {
  const log = process.env.NOVA_EGRESS_LOG;
  if (log) { assert.equal(existsSync(log) ? readFileSync(log, 'utf8') : '', '', 'lifecycle egress guard never fired'); console.log('lifecycle egress guard: never fired'); }
});

test('failed release Core startup with confirmed broker cleanup can recover the previous release', { timeout: 20000 }, async () => {
  const f = fixture((root) => {
    const path = join(root, 'src/server.js');
    writeFileSync(path, readFileSync(path, 'utf8').replace('const waiting =', "if (marker === 'two' && process.env.NOVA_SANDBOX !== '1') process.exit(1);\nconst waiting ="));
  });
  try {
    fakeRelease(f.repo, 'v1.1.0', 'two');
    await f.sup.run(); await until(() => f.sup.state.mode === 'running', 'original ready');
    const result = await f.sup.deploy('v1.1.0');
    // Rolled back is not deployed: the release didn't stay, so the deploy says it failed.
    assert.equal(result.ok, false, result.said); assert.match(result.said, /Rolled back/);
    assert.equal(f.sup.state.releases.current, 'base'); assert.equal(f.sup.state.mode, 'running');
    assert.ok(f.sup.server); assert.equal((f.sup.state as any).broker.status, 'running');
  } finally { await f.sup.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('failed broker readiness remains pending until the actual child closes', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-start-failure-')), dir = join(root, 'broker'), source = join(root, 'source');
  mkdirSync(dir); mkdirSync(source);
  const hold = join(dir, 'hold'), at = join(dir, 'pid'); writeFileSync(hold, 'hold');
  writeFileSync(join(source, 'main.ts'), `import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2];
process.once('message', async () => {
  process.send({ ready: false, problem: 'synthetic refused startup' });
  writeFileSync(join(dir, 'pid'), String(process.pid));
  while (existsSync(join(dir, 'hold'))) await new Promise((r) => setTimeout(r, 10));
  process.exit(1);
});`);
  let settled = false;
  const pending = startBroker(dir, { source, keyMode: 'file', pipe: true }).then(() => { throw new Error('unexpected ready'); }, (e: Error) => e).then((r) => { settled = true; return r; });
  try {
    await until(() => existsSync(at), 'actual failing child', 2000);
    const pid = Number(readFileSync(at, 'utf8')); await new Promise((r) => setTimeout(r, 60)); process.kill(pid, 0);
    const early = settled; rmSync(hold); const error = await pending;
    assert.equal(early, false, 'a failed ready message must not detach the child lifetime');
    assert.match(error.message, /synthetic refused startup/);
    assert.throws(() => process.kill(pid, 0));
  } finally { rmSync(hold, { force: true }); await pending; rmSync(root, { recursive: true, force: true }); }
});

test('close joins a replacement stop already draining the actual Core child', { timeout: 15000 }, async () => {
  const f = fixture((root) => {
    const path = join(root, 'src/server.js');
    let text = readFileSync(path, 'utf8').replace("import { readFileSync }", "import { readFileSync, existsSync, writeFileSync }");
    text = text.replace("process.on('SIGTERM', () => process.exit(0));", `process.on('SIGTERM', async () => {
      const hold = process.env.NOVA_HOME + '/broker/test-core-hold';
      if (existsSync(hold)) {
        writeFileSync(process.env.NOVA_HOME + '/broker/test-core-stopping', String(process.pid));
        while (existsSync(hold)) await new Promise((r) => setTimeout(r, 10));
      }
      process.exit(0);
    });`);
    writeFileSync(path, text);
  });
  const hold = join(f.home, 'broker/test-core-hold'), at = join(f.home, 'broker/test-core-stopping');
  let restarting: Promise<unknown> | undefined, closing: Promise<void> | undefined;
  try {
    await f.sup.run(); await until(() => f.sup.state.mode === 'running', 'running');
    writeFileSync(hold, 'hold'); restarting = f.sup.restart();
    await until(() => existsSync(at), 'Core physically draining');
    const pid = Number(readFileSync(at, 'utf8')); let done = false;
    closing = f.sup.close().then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 60)); process.kill(pid, 0);
    const early = done; rmSync(hold); await restarting; await closing;
    assert.equal(early, false, 'close must join the stop that already owns this live Core');
    assert.throws(() => process.kill(pid, 0)); assert.equal(f.sup.server, null);
  } finally { rmSync(hold, { force: true }); await restarting; await closing; await f.sup.close(); rmSync(f.dir, { recursive: true, force: true }); }
});
