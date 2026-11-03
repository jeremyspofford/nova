// Task 4: real owned processes and synthetic keychain only, in private temporary homes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileSha256 } from '../../src/broker/origin.ts';
import { startBroker } from '../../src/broker/spawn.ts';
import { BrokerClient } from '../../src/core/broker/client.ts';
import { Vault } from '../../src/core/vault.ts';
import { C, Person, inProcess, tmp } from '../support/broker-support.ts';

async function until(check: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await delay(20);
  assert.ok(check(), 'condition reached before deadline');
}
function running(pid: number) {
  try { return !/^[^)]*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
async function program(body: string, permission = false) {
  const home = tmp('nova-owned-launch-');
  const dir = join(home, 'broker');
  const local = permission ? null : inProcess(dir);
  const started = permission ? await startBroker(dir, { keyMode: 'file', pipe: true }) : null;
  const client = started ? new BrokerClient({ socket: started.socket, token: started.tokens.core }) : null;
  const call = local?.call ?? ((m: string, f = {}) => client!.call(m, f));
  const p = new Person(call);
  await p.setup();
  const path = join(home, 'program.py');
  writeFileSync(path, '#!/usr/bin/python3\n' + body, { mode: 0o755 });
  const target = { kind: 'process', path, sha256: fileSha256(path) };
  const made = await p.approve('create', { meta: { name: 'test/FILE', kind: 'secret', class: 'standard' }, source: 'sealed', bind: [{ target, inject: { how: 'file', env: 'CREDENTIAL_FILE' }, consent: {} }] }, { seal: C('owned-file'), sealAt: (f, e) => ({ ...f, source: { sealed: e } }) });
  assert.equal(made.ok, true);
  return { home, dir, local, started, use: (request = {}) => call('use', { ref: made.ref, target, request: { argv: [], ...request } }),
    close: async () => { client?.close(); if (started) { const exited = once(started.child, 'exit'); started.child.kill(); await exited; } } };
}
const stubborn = `import os,signal,time,json
signal.signal(signal.SIGTERM,signal.SIG_IGN)
pid=os.fork()
if pid==0:
    while True: time.sleep(1)
with open(os.environ['TF_VAR_LOG'],'w') as f: json.dump([os.getpid(),pid,os.environ['CREDENTIAL_FILE']],f)
time.sleep(.2)
with open(os.environ['CREDENTIAL_FILE']) as f: print(f.read(),flush=True)
while True: time.sleep(1)
`;

test('B3 timeout kills owned TERM-resistant descendants, preserves delayed file read and unrelated control', { timeout: 20000 }, async () => {
  const b = await program(stubborn, true);
  const log = join(b.home, 'pids.json');
  const control = spawn('/bin/sleep', ['30']);
  let pids: number[] = [];
  try {
    const use = b.use({ env: { TF_VAR_LOG: log }, timeout_ms: 1000 });
    await until(() => existsSync(log));
    const [parent, child, file] = JSON.parse(readFileSync(log, 'utf8'));
    pids = [parent, child];
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(file, '..')).mode & 0o777, 0o700);
    const result = await Promise.race([use, delay(8500).then(() => null)]);
    assert.ok(result, 'timeout settles after owned group cleanup');
    await until(() => pids.every((pid) => !running(pid)));
    assert.match(result.outcome.stdout, /\[redacted by the broker\]/);
    assert.ok(!JSON.stringify(result).includes(C('owned-file')));
    assert.deepEqual(readdirSync(join(b.dir, 'run')), []);
    assert.equal(running(control.pid!), true, 'unrelated process survives');
  } finally {
    for (const pid of pids) if (running(pid)) process.kill(pid, 'SIGKILL');
    control.kill('SIGKILL'); await b.close();
  }
});

test('B3 four lanes remain held during TERM escalation; stopPrograms awaits cleanup and refuses new uses', { timeout: 20000 }, async () => {
  const b = await program(stubborn);
  const logs = Array.from({ length: 4 }, (_, i) => join(b.home, `pid-${i}`));
  let pids: number[] = [];
  try {
    const uses = logs.map((log) => b.use({ env: { TF_VAR_LOG: log }, timeout_ms: 1000 }));
    await until(() => logs.every(existsSync));
    pids = logs.flatMap((log) => JSON.parse(readFileSync(log, 'utf8')).slice(0, 2));
    await delay(1300);
    assert.equal((await b.use()).refused, 'rate');
    assert.equal(typeof b.local!.broker.stopPrograms, 'function');
    await b.local!.broker.stopPrograms();
    await Promise.all(uses);
    assert.ok(pids.every((pid) => !running(pid)));
    assert.deepEqual(readdirSync(join(b.dir, 'run')), []);
    assert.equal((await b.use()).error, 'failed');
  } finally { for (const pid of pids) if (running(pid)) process.kill(pid, 'SIGKILL'); await b.close(); }
});

test('B3 ambiguous leftover directory refuses a fresh credentialed process without killing its recorded PID', async () => {
  const b = await program('print("must not execute")\n');
  const control = spawn('/bin/sleep', ['30']);
  try {
    const leftover = join(b.dir, 'run', 'nova-run-unknown');
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(leftover, 'pid'), String(control.pid));
    const result = await b.use();
    assert.equal(result.error, 'failed');
    assert.ok(existsSync(leftover));
    assert.equal(running(control.pid!), true);
  } finally { control.kill('SIGKILL'); await b.close(); }
});

test('B3 delayed file open succeeds normally; bad cwd spawn error and exit/timeout races settle without stale timers', async () => {
  const b = await program(`import os,time,sys\ntime.sleep(.25)\nwith open(os.environ['CREDENTIAL_FILE']) as f: print(f.read())\nprint('x'*4200000,file=sys.stderr)\n`);
  try {
    const normal = await b.use({ timeout_ms: 1000 });
    assert.equal(normal.outcome.exit, 0);
    assert.match(normal.outcome.stdout, /redacted/);
    assert.equal(normal.outcome.truncated, true);
    for (let i = 0; i < 5; i++) {
      const failed = await b.use({ cwd: join(b.home, 'absent'), timeout_ms: 1000 });
      assert.equal(failed.outcome.exit, 127);
      assert.deepEqual(readdirSync(join(b.dir, 'run')), []);
    }
    await delay(1200);
    assert.equal((await b.use()).outcome.exit, 0);
  } finally { await b.close(); }
});

test('B5 actual broker and migration stage/finish reach only the private synthetic keychain with finite context', { timeout: 20000 }, async () => {
  const home = tmp('nova-keychain-context-');
  const bin = join(home, 'bin'); mkdirSync(bin);
  const keydir = join(home, 'keys'); mkdirSync(keydir);
  const log = join(home, 'context.jsonl');
  const old = new Vault({ home, mode: 'file' }); old.put('provider/CONTEXT', C('context'));
  const id = JSON.parse(readFileSync(join(home, 'vault/secrets.json'), 'utf8')).id;
  writeFileSync(join(keydir, `nova-vault-vault-${id}`), readFileSync(join(home, 'vault/key')).toString('base64'));
  rmSync(join(home, 'vault/key'));
  writeFileSync(join(bin, 'secret-tool'), `#!/usr/bin/python3
import os,sys,json
home=os.environ.get('HOME')
if home!=${JSON.stringify(home)} or os.environ.get('DBUS_SESSION_BUS_ADDRESS')!='unix:path=/tmp/synthetic-no-socket': sys.exit(3)
with open(${JSON.stringify(log)},'a') as f: f.write(json.dumps({'argv':sys.argv[1:],'env':dict(os.environ)})+'\\n')
a=sys.argv; service=a[a.index('service')+1]; account=a[a.index('account')+1]
p=os.path.join(home,'keys',service+'-'+account)
if a[1]=='lookup':
    if not os.path.exists(p): sys.exit(1)
    print(open(p).read())
elif a[1]=='store': open(p,'w').write(sys.stdin.read())
elif a[1]=='clear' and os.path.exists(p): os.unlink(p)
`, { mode: 0o755 });
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/synthetic-no-socket', NODE_OPTIONS: '--no-warnings', HTTPS_PROXY: C('parent-proxy'), AWS_SECRET_ACCESS_KEY: C('parent-token'), NOVA_PARENT_CANARY: C('parent') };
  const started = await startBroker(join(home, 'broker'), { keyMode: 'keychain', env, pipe: true });
  const client = new BrokerClient({ socket: started.socket, token: started.tokens.core });
  const p = new Person((m, f = {}) => client.call(m, f));
  try {
    await p.setup();
    const stage = await client.call('create', { source: { migrate: 'stage' } });
    assert.equal(stage.ok, true, JSON.stringify(stage)); assert.equal(stage.outcome.staged, 1);
    const before = readFileSync(log, 'utf8').trim().split('\n').length;
    const finish = await p.approve('create', { source: { migrate: 'commit' } });
    assert.equal(finish.ok, true, JSON.stringify(finish)); assert.equal(finish.outcome.removed, 1);
    const entries = readFileSync(log, 'utf8').trim().split('\n').map((s) => JSON.parse(s));
    assert.ok(entries.slice(before).some((x) => x.argv.includes('nova-vault')));
    assert.ok(entries.some((x) => x.argv.includes('nova-broker')));
    for (const { env: observed } of entries) {
      assert.equal(observed.HOME, home); assert.equal(observed.PATH, env.PATH); assert.equal(observed.DBUS_SESSION_BUS_ADDRESS, env.DBUS_SESSION_BUS_ADDRESS);
      for (const key of ['NODE_OPTIONS', 'HTTPS_PROXY', 'AWS_SECRET_ACCESS_KEY', 'NOVA_PARENT_CANARY']) assert.equal(observed[key], undefined, key);
    }
    assert.equal(existsSync(join(home, 'vault/secrets.json')), false);
    assert.equal(existsSync(join(home, 'broker/device.key')), false);
  } finally { client.close(); const exited = once(started.child, 'exit'); started.child.kill(); await exited; }
});
