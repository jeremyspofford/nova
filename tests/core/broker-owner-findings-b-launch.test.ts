// Task 4: real owned processes and synthetic keychain only, in private temporary homes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileSha256 } from '../../src/broker/origin.ts';
import { startBroker } from '../../src/broker/spawn.ts';
import { BrokerClient } from '../../src/core/broker/client.ts';
import { Vault } from '../../src/core/vault.ts';
import { C, Person, inProcess, tmp, type A } from '../support/broker-support.ts';

async function until(check: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await delay(20);
  assert.ok(check(), 'condition reached before deadline');
}
function running(pid: number) {
  try { return !/^[^)]*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); }
  // A process that exits while its stat is read gives ESRCH, not ENOENT: it is gone either way.
  catch (e) { if (['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '')) return false; throw e; }
}
async function program(body: string, permission = false) {
  const home = tmp('nova-owned-launch-');
  const dir = join(home, 'broker');
  const local = permission ? null : inProcess(dir);
  const started = permission ? await startBroker(dir, { keyMode: 'file', pipe: false }) : null;
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
log=os.environ['TF_VAR_LOG']
with open(log+'.tmp','w') as f: json.dump([os.getpid(),pid,os.environ['CREDENTIAL_FILE']],f)
os.replace(log+'.tmp',log)
time.sleep(.2)
with open(os.environ['CREDENTIAL_FILE']) as f: print(f.read(),flush=True)
print('delayed read complete '*1000,flush=True)
while True: time.sleep(1)
`;

test('B3 timeout kills owned TERM-resistant descendants, preserves delayed file read and unrelated control', { timeout: 20000 }, async () => {
  const b = await program(stubborn, true);
  const log = join(b.home, 'pids.json');
  const control = spawn('/bin/sleep', ['30']);
  let pids: number[] = [];
  try {
    const use = b.use({ env: { TF_VAR_LOG: log }, timeout_ms: 1000 });
    await until(() => existsSync(log)).catch(async (e) => { throw new Error(`${e.message}: ${JSON.stringify(await use)}`); });
    const [parent, child, file] = JSON.parse(readFileSync(log, 'utf8'));
    pids = [parent, child];
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(file, '..')).mode & 0o777, 0o700);
    const result = await Promise.race([use, delay(8500).then(() => null)]);
    assert.ok(result, 'timeout settles after owned group cleanup');
    await until(() => pids.every((pid) => !running(pid)));
    assert.match(result.outcome.stdout, /\[redacted by the broker\]/);
    assert.ok(!JSON.stringify(result).includes(C('owned-file')));
    assert.deepEqual(readdirSync(join(b.dir, 'run/programs')), []);
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
    assert.deepEqual(readdirSync(join(b.dir, 'run/programs')), []);
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
      assert.deepEqual(readdirSync(join(b.dir, 'run/programs')), []);
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
  const started = await startBroker(join(home, 'broker'), { keyMode: 'keychain', env, pipe: false });
  const client = new BrokerClient({ socket: started.socket, token: started.tokens.core });
  const p = new Person((m, f = {}) => client.call(m, f));
  try {
    await p.setup();
    const stage = await client.call('create', { source: { migrate: 'stage' } }) as A;
    assert.equal(stage.ok, true, JSON.stringify(stage)); assert.equal(stage.outcome.staged, 1);
    const before = readFileSync(log, 'utf8').trim().split('\n').length;
    const finish = await p.approve('create', { source: { migrate: 'commit' } });
    assert.equal(finish.ok, true, JSON.stringify(finish)); assert.equal(finish.outcome.removed, 1);
    const entries = readFileSync(log, 'utf8').trim().split('\n').map((s) => JSON.parse(s));
    assert.ok(entries.slice(before).some((x) => x.argv.includes('nova-vault')));
    assert.ok(entries.some((x) => x.argv.includes('nova-broker')));
    for (const { env: observed } of entries) {
      assert.equal(observed.HOME, home); assert.equal(observed.PATH, env.PATH); assert.equal(observed.DBUS_SESSION_BUS_ADDRESS, env.DBUS_SESSION_BUS_ADDRESS);
      assert.deepEqual(Object.keys(observed).filter((k) => k !== 'LC_CTYPE').sort(), ['DBUS_SESSION_BUS_ADDRESS', 'HOME', 'PATH', 'TZ']);
      for (const key of ['NODE_OPTIONS', 'HTTPS_PROXY', 'AWS_SECRET_ACCESS_KEY', 'NOVA_PARENT_CANARY']) assert.equal(observed[key], undefined, key);
    }
    assert.equal(existsSync(join(home, 'vault/secrets.json')), false);
    assert.equal(existsSync(join(home, 'broker/device.key')), false);
  } finally { client.close(); const exited = once(started.child, 'exit'); started.child.kill(); await exited; }
});

for (const failure of ['missing', 'wrong', 'unavailable']) {
  test(`B5 explicit keychain ${failure} refuses migration even with a valid file key`, async () => {
    const { readOldVault } = await import('../../src/broker/oldvault.ts');
    const home = tmp('nova-no-fallback-');
    new Vault({ home, mode: 'file' }).put('provider/NO_FALLBACK', C('no-fallback'));
    const before = readFileSync(join(home, 'vault/secrets.json'));
    assert.throws(() => readOldVault(home, { env: { NOVA_VAULT_KEY: 'keychain' }, store: () => ({ kind: 'keychain', name: 'synthetic', available: () => ({ ok: true, detail: '' }), read: () => { if (failure === 'unavailable') throw new Error('synthetic unavailable'); return failure === 'wrong' ? Buffer.alloc(32, 4) : null; }, write: () => {}, remove: () => {} }) }));
    assert.deepEqual(readFileSync(join(home, 'vault/secrets.json')), before);
    assert.equal(new Vault({ home, mode: 'file' }).get('provider/NO_FALLBACK'), C('no-fallback'));
  });
}

test('B3 synchronous and asynchronous launcher spawn failures releases exactly once and leaves no stale owned entry', async () => {
  const b = await program('print("ok")\n');
  const executable = process.execPath;
  try {
    process.execPath = '';
    for (let i = 0; i < 5; i++) assert.equal((await b.use()).outcome.exit, 127);
    process.execPath = join(b.home, 'nonexistent-node');
    for (let i = 0; i < 5; i++) {
      const result = await b.use();
      assert.ok(result.outcome.exit !== 0);
      assert.deepEqual(readdirSync(join(b.dir, 'run/programs')), []);
    }
    process.execPath = executable;
    assert.equal((await b.use()).outcome.stdout.trim(), 'ok');
    await b.local!.broker.stopPrograms();
  } finally { process.execPath = executable; await b.close(); }
});

test('B3 normal parent exit cleans inherited descendants even after they close their output pipes', async () => {
  const b = await program(`import os,signal,time,json
pid=os.fork()
if pid==0:
    signal.signal(signal.SIGTERM,signal.SIG_IGN)
    os.close(1);os.close(2)
    while True: time.sleep(1)
with open(os.environ['TF_VAR_LOG'],'w') as f: json.dump([pid],f)
`);
  const log = join(b.home, 'descendant');
  let pid: number | undefined;
  try {
    const answer = await b.use({ env: { TF_VAR_LOG: log } });
    pid = JSON.parse(readFileSync(log, 'utf8'))[0];
    assert.equal(answer.outcome.exit, 0);
    await until(() => !running(pid!));
    assert.deepEqual(readdirSync(join(b.dir, 'run/programs')), []);
    await delay(1100);
    assert.equal((await b.use({ env: { TF_VAR_LOG: log }, timeout_ms: 1000 })).outcome.exit, 0);
  } finally { if (pid && running(pid)) process.kill(pid, 'SIGKILL'); await b.close(); }
});

test('B3 main graceful shutdown awaits real owned descendant cleanup', { timeout: 15000 }, async () => {
  const b = await program(stubborn, true);
  const log = join(b.home, 'shutdown-pids');
  let pids: number[] = [];
  try {
    const use = b.use({ env: { TF_VAR_LOG: log } }).catch(() => null);
    await until(() => existsSync(log));
    pids = JSON.parse(readFileSync(log, 'utf8')).slice(0, 2);
    const exited = once(b.started!.child, 'exit');
    b.started!.child.kill('SIGTERM');
    assert.equal((await exited)[0], 0);
    await use;
    await until(() => pids.every((pid) => !running(pid)));
    assert.deepEqual(readdirSync(join(b.dir, 'run/programs')), []);
  } finally { for (const pid of pids) if (running(pid)) process.kill(pid, 'SIGKILL'); }
});

test('B3 broker SIGKILL leaves ownership evidence and restarted broker refuses reuse without stale PID killing', async () => {
  const b = await program(stubborn, true);
  const log = join(b.home, 'unclean-pids');
  let pids: number[] = [];
  let replacement: Awaited<ReturnType<typeof startBroker>> | undefined;
  try {
    const use = b.use({ env: { TF_VAR_LOG: log } }).catch(() => null);
    await until(() => existsSync(log));
    const data = JSON.parse(readFileSync(log, 'utf8')); pids = data.slice(0, 2);
    const exited = once(b.started!.child, 'exit'); b.started!.child.kill('SIGKILL'); await exited; await use;
    assert.ok(existsSync(data[2]), 'broker death cannot erase run evidence');
    replacement = await startBroker(b.dir, { keyMode: 'file', pipe: false });
    const client = new BrokerClient({ socket: replacement.socket, token: replacement.tokens.core });
    try {
      const path = join(b.home, 'program.py');
      const result = await client.use('secret://test/FILE', { kind: 'process', path, sha256: fileSha256(path) }, { argv: [] });
      assert.equal(result.error, 'failed');
      assert.ok(existsSync(data[2]));
      assert.ok(pids.every(running), 'replacement never signals unknown old ownership');
    } finally { client.close(); }
  } finally {
    for (const pid of pids) if (running(pid)) process.kill(pid, 'SIGKILL');
    if (replacement) { const exited = once(replacement.child, 'exit'); replacement.child.kill(); await exited; }
  }
});

test('B3 cleanup failure retains evidence and blocks further credentialed use', async () => {
  const b = await program(`import time\ntime.sleep(.4)\n`);
  const root = join(b.dir, 'run/programs');
  try {
    const use = b.use();
    await until(() => existsSync(root) && readdirSync(root).length === 1);
    chmodSync(root, 0o500);
    assert.equal((await use).error, 'failed');
    assert.equal(readdirSync(root).length, 1);
    assert.equal((await b.use()).error, 'failed');
    await assert.rejects(b.local!.broker.stopPrograms(), /cleanup/);
  } finally { chmodSync(root, 0o700); await b.close(); }
});

test('B3 Windows credentialed process branch refuses before run directory or value injection', async () => {
  const b = await program('print("must not execute")\n');
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const result = await b.use();
    assert.equal(result.error, 'failed');
    assert.match(result.words, /POSIX process groups/);
    assert.equal(existsSync(join(b.dir, 'run/programs')), false);
  } finally { Object.defineProperty(process, 'platform', descriptor); await b.close(); }
});

test('B3 denied owned-group signal blocks new use immediately and shutdown rejects while retaining ownership', { timeout: 12000 }, async () => {
  const b = await program(stubborn);
  const log = join(b.home, 'signal-pids');
  const kill = process.kill;
  let pids: number[] = [];
  try {
    const use = b.use({ env: { TF_VAR_LOG: log }, timeout_ms: 1000 });
    await until(() => existsSync(log));
    pids = JSON.parse(readFileSync(log, 'utf8')).slice(0, 2);
    process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid < 0) throw Object.assign(new Error('synthetic denied signal'), { code: 'EPERM' });
      return kill(pid, signal);
    }) as typeof process.kill;
    await delay(1300);
    const again = await Promise.race([b.use({ env: { TF_VAR_LOG: log + '-second' } }), delay(300).then(() => null)]);
    assert.equal(again?.error, 'failed', 'ambiguity blocks a fifth or second use alike');
    const stopped = b.local!.broker.stopPrograms();
    await assert.rejects(stopped, /cleanup/);
    assert.equal((await use).error, 'failed');
    assert.equal(readdirSync(join(b.dir, 'run/programs')).length, 1);
    assert.ok(pids.every(running));
  } finally {
    process.kill = kill;
    if (existsSync(log + '-second')) pids.push(...JSON.parse(readFileSync(log + '-second', 'utf8')).slice(0, 2));
    for (const pid of pids) if (running(pid)) kill(pid, 'SIGKILL');
    await b.close();
  }
});

test('B3 normal exit near the timeout boundary settles each lane once', async () => {
  const b = await program('import time\ntime.sleep(.97)\n');
  try {
    for (let i = 0; i < 4; i++) {
      const result = await b.use({ timeout_ms: 1000 });
      assert.ok([0, 128, 143].includes(result.outcome.exit), JSON.stringify(result));
      assert.deepEqual(readdirSync(join(b.dir, 'run/programs')), []);
    }
    await b.local!.broker.stopPrograms();
  } finally { await b.close(); }
});

for (const alreadyRejected of [false, true]) {
  test(`I1 shutdown awaits recoverable owned group before reporting ${alreadyRejected ? 'already-rejected' : 'concurrent'} cleanup failure`, { timeout: 20000 }, async () => {
    const b = await program(stubborn);
    const logs = [join(b.home, 'denied-group'), join(b.home, 'recoverable-group')];
    const uses = logs.map((log, i) => b.use({ env: { TF_VAR_LOG: log }, ...(alreadyRejected && i === 0 ? { timeout_ms: 1000 } : {}) }));
    const kill = process.kill;
    let groups: number[] = [];
    let recoverableSettled = false;
    void uses[1]!.then(() => { recoverableSettled = true; });
    try {
      await until(() => logs.every(existsSync));
      const owned = logs.map((log) => JSON.parse(readFileSync(log, 'utf8')) as [number, number, string]);
      groups = owned.map(([pid]) => Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[2]));
      assert.ok(groups.every((pid) => pid > 0));
      assert.notEqual(groups[0], groups[1]);
      const delivered: Array<{ group: number; signal: number | NodeJS.Signals | undefined }> = [];
      process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
        if (pid === -groups[0]!) throw Object.assign(new Error('synthetic denied owned group'), { code: 'EPERM' });
        const result = kill(pid, signal);
        if (pid < 0) delivered.push({ group: -pid, signal });
        return result;
      }) as typeof process.kill;
      if (alreadyRejected) {
        assert.equal((await uses[0]!).error, 'failed');
        assert.equal(recoverableSettled, false, 'other owned group is still active when shutdown starts');
      }
      await assert.rejects(b.local!.broker.stopPrograms(), /cleanup/);
      // These observations are made immediately on rejection, when main would process.exit(1).
      assert.ok(delivered.some((x) => x.group === groups[1] && x.signal === 'SIGKILL'), 'recoverable group receives KILL before shutdown rejects');
      assert.equal(running(groups[1]!), false, 'recoverable launcher has exited');
      assert.ok(owned[1]!.slice(0, 2).every((pid) => !running(Number(pid))), 'recoverable executables have stopped before shutdown rejects');
      assert.equal(existsSync(join(owned[1]![2], '..')), false, 'recoverable directory removed before shutdown rejects');
      // The close handler removes this directory before resolving internal cleanup; the outer
      // request/audit promise may need further microtasks to deliver its answer.
      assert.ok((await uses[1]!).outcome.exit !== 0);
      assert.ok(existsSync(owned[0]![2]), 'failed group retains credential and ownership evidence');
      assert.equal(readdirSync(join(b.dir, 'run/programs')).length, 1, 'only failed ownership remains');
      assert.equal((await uses[0]!).error, 'failed');
      assert.equal((await b.use()).error, 'failed', 'new credential uses remain blocked');
    } finally {
      process.kill = kill;
      for (const group of groups) {
        try { kill(-group, 'SIGKILL'); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
      }
      await Promise.all(uses);
      await b.close();
    }
  });
}
