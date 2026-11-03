import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Supervisor } from '../../src/supervisor/supervisor.ts';
import { fakeRepo, fakeRelease, git, FAST } from './fake.ts';
import { Person } from '../support/broker-support.ts';
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
  const file = join(repo, 'src/server.js');
  writeFileSync(file, readFileSync(file, 'utf8').replace("const marker =", `import { BrokerClient } from './core/broker/client.ts';
let broker;
const boot = new Promise((done) => process.on('message', async (m) => {
  if (m?.nova !== 'broker') return;
  if (m.context) {
    broker = new BrokerClient(m.context);
    const a = await broker.listRefs();
    if (!a.ok || Object.keys(m.context).sort().join() !== 'socket,token') process.exit(71);
    // The supervisor role token is never present in this child or its launch context.
    if (Object.values(process.env).includes(m.context.token) || process.argv.includes(m.context.token)) process.exit(72);
  }
  done();
}));
if (process.send && process.env.NOVA_SANDBOX !== '1') { process.send({ nova: 'broker-ready' }); await boot; }
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

test('supervised keychain reset retries interruption without reading/recreating removed keys and preserves unrelated accounts', { timeout: 30000 }, async () => {
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
    const stage = await c.reset.stage({ confirm: true, who: { principal: { kind: 'console' }, listener: 'console', address: '127.0.0.1' } });
    await stage.done; await c.close(); writeFileSync(denied, 'deny');
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
